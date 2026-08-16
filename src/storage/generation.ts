import {
  canonicalBytes,
  contentHash,
  revisionContentHash,
} from "../agentwiki/protocol";
import type { ControlStorePort } from "../ports/control-store";
import {
  portablePathKey,
  validatePortablePath,
  validateTitle,
} from "../core/portable-path";
import { opaqueFileKey } from "../core/identity-key";
import { isValidSyncPath } from "../core/sync-path";

export interface SpaceManifest {
  schemaVersion: 1;
  protocolVersion: "1";
  generationId: string;
  spaceId: string;
  rootPath: string;
  baseRevision: string;
  baseRevisionContentHash: string;
  basePageCount: number;
  baseRevisionManifestByteLength: number;
  baseRevisionBodyBytes: number;
  lastSuccessfulSyncAt: string;
  pages: Record<
    string,
    { pageId: string; relativePath: string; title: string; contentHash: string }
  >;
}

export class GenerationRepository {
  constructor(
    private readonly store: ControlStorePort,
    private readonly root: string,
  ) {}

  /**
   * 生成可读的本地文件名
   * 优先使用 syncPath（如果合法），否则回退到哈希文件名
   */
  private async localFileName(
    pageId: string,
    relativePath: string,
  ): Promise<string> {
    if (relativePath && isValidSyncPath(relativePath)) return relativePath;
    return `p-${await opaqueFileKey(pageId)}.md`;
  }

  private path(generationId: string, suffix: string): string {
    return `${this.root}/generations/${generationId}/${suffix}`;
  }

  async write(
    input: SpaceManifest,
    baseBodies: Record<string, string>,
  ): Promise<SpaceManifest> {
    const pages = { ...input.pages };
    let bodyBytes = 0;
    for (const [pageId, page] of Object.entries(pages)) {
      const body = baseBodies[pageId];
      if (body === undefined) throw new Error(`缺少基础内容： ${pageId}`);
      page.contentHash = await contentHash(body);
      bodyBytes += new TextEncoder().encode(body).byteLength;
      await this.store.write(
        this.path(
          input.generationId,
          `base/${await this.localFileName(pageId, page.relativePath)}`,
        ),
        body,
      );
    }
    const protocolManifest = {
      protocolVersion: "1" as const,
      spaceId: input.spaceId,
      pages: Object.values(pages).map((page) => ({
        pageId: page.pageId,
        path: page.relativePath,
        title: page.title,
        contentHash: page.contentHash,
      })),
    };
    const manifest: SpaceManifest = {
      ...input,
      pages,
      basePageCount: Object.keys(pages).length,
      baseRevisionBodyBytes: bodyBytes,
      baseRevisionManifestByteLength:
        pages && Object.keys(pages).length > 0
          ? canonicalBytes(protocolManifest).byteLength
          : 0,
      baseRevisionContentHash: await revisionContentHash(protocolManifest),
    };
    await this.store.write(
      this.path(input.generationId, "manifest.json"),
      JSON.stringify(manifest),
    );
    await this.verify(input.generationId);
    return manifest;
  }

  async verify(generationId: string): Promise<SpaceManifest> {
    const raw = await this.store.read(this.path(generationId, "manifest.json"));
    if (raw === null) throw new Error("基线损坏: 清单缺失");
    let manifest: SpaceManifest;
    try {
      manifest = JSON.parse(raw) as SpaceManifest;
    } catch {
      throw new Error("基线损坏: 清单无效");
    }
    if (manifest.schemaVersion !== 1 || manifest.generationId !== generationId)
      throw new Error("基线损坏: 身份无效");
    const pathKeys = new Set<string>();
    for (const [key, page] of Object.entries(manifest.pages)) {
      if (key !== page.pageId || !page.pageId)
        throw new Error("基线损坏: 页面身份不匹配");
      const path = validatePortablePath(page.relativePath);
      validateTitle(page.title);
      if (pathKeys.has(path.key)) throw new Error("基线损坏: 路径冲突");
      pathKeys.add(portablePathKey(path.path));
    }
    let bodyBytes = 0;
    for (const page of Object.values(manifest.pages)) {
      const body = await this.store.read(
        this.path(
          generationId,
          `base/${await this.localFileName(page.pageId, page.relativePath)}`,
        ),
      );
      if (body === null || (await contentHash(body)) !== page.contentHash)
        throw new Error("基线损坏: 基础哈希不匹配");
      bodyBytes += new TextEncoder().encode(body).byteLength;
    }
    const protocolManifest = {
      protocolVersion: "1" as const,
      spaceId: manifest.spaceId,
      pages: Object.values(manifest.pages).map((page) => ({
        pageId: page.pageId,
        path: page.relativePath,
        title: page.title,
        contentHash: page.contentHash,
      })),
    };
    const manifestBytes =
      Object.keys(manifest.pages).length > 0
        ? canonicalBytes(protocolManifest).byteLength
        : 0;
    if (
      manifest.basePageCount !== Object.keys(manifest.pages).length ||
      manifest.baseRevisionBodyBytes !== bodyBytes ||
      manifest.baseRevisionManifestByteLength !== manifestBytes ||
      manifest.baseRevisionContentHash !==
        (await revisionContentHash(protocolManifest))
    )
      throw new Error("基线损坏: 修订指标不匹配");
    return manifest;
  }

  async read(
    generationId: string,
  ): Promise<{ manifest: SpaceManifest; bodies: Record<string, string> }> {
    const manifest = await this.verify(generationId);
    const bodies: Record<string, string> = {};
    for (const page of Object.values(manifest.pages)) {
      const body = await this.store.read(
        this.path(
          generationId,
          `base/${await this.localFileName(page.pageId, page.relativePath)}`,
        ),
      );
      if (body === null) throw new Error("基线损坏: 内容缺失");
      bodies[page.pageId] = body;
    }
    return { manifest, bodies };
  }
  async readManifest(generationId: string): Promise<SpaceManifest> {
    return this.verify(generationId);
  }
  async readBody(
    generationId: string,
    pageId: string,
    expectedHash: string,
    relativePath?: string,
  ): Promise<string> {
    // 向后兼容：如果没有传入 relativePath，尝试从 manifest 读取
    let path = relativePath;
    if (!path) {
      const manifest = await this.readManifest(generationId);
      const page = manifest.pages[pageId];
      if (page) path = page.relativePath;
    }
    const fileName = path
      ? await this.localFileName(pageId, path)
      : `p-${await opaqueFileKey(pageId)}.md`;
    // 尝试可读路径，如果不存在则回退到哈希路径（向后兼容）
    let body = await this.store.read(
      this.path(generationId, `base/${fileName}`),
    );
    if (body === null && path && isValidSyncPath(path)) {
      body = await this.store.read(
        this.path(generationId, `base/p-${await opaqueFileKey(pageId)}.md`),
      );
    }
    if (body === null || (await contentHash(body)) !== expectedHash)
      throw new Error("基线损坏: 基础哈希不匹配");
    return body;
  }
  async writeStreaming(
    input: SpaceManifest,
    pages: AsyncIterable<{
      pageId: string;
      relativePath: string;
      title: string;
      contentHash: string;
      body: string;
    }>,
  ): Promise<SpaceManifest> {
    const pageMap: SpaceManifest["pages"] = {};
    let bodyBytes = 0;
    for await (const page of pages) {
      if (pageMap[page.pageId]) throw new Error("基线损坏: 页面身份重复");
      if ((await contentHash(page.body)) !== page.contentHash)
        throw new Error("基线损坏: 基础哈希不匹配");
      pageMap[page.pageId] = {
        pageId: page.pageId,
        relativePath: page.relativePath,
        title: page.title,
        contentHash: page.contentHash,
      };
      bodyBytes += new TextEncoder().encode(page.body).byteLength;
      await this.store.write(
        this.path(
          input.generationId,
          `base/${await this.localFileName(page.pageId, page.relativePath)}`,
        ),
        page.body,
      );
    }
    const protocolManifest = {
      protocolVersion: "1" as const,
      spaceId: input.spaceId,
      pages: Object.values(pageMap).map((page) => ({
        pageId: page.pageId,
        path: page.relativePath,
        title: page.title,
        contentHash: page.contentHash,
      })),
    };
    const manifest: SpaceManifest = {
      ...input,
      pages: pageMap,
      basePageCount: Object.keys(pageMap).length,
      baseRevisionBodyBytes: bodyBytes,
      baseRevisionManifestByteLength: Object.keys(pageMap).length
        ? canonicalBytes(protocolManifest).byteLength
        : 0,
      baseRevisionContentHash: await revisionContentHash(protocolManifest),
    };
    await this.store.write(
      this.path(input.generationId, "manifest.json"),
      JSON.stringify(manifest),
    );
    await this.verify(input.generationId);
    return manifest;
  }
}

