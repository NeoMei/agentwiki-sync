import { treeRevisionContentHashV2 } from "@neomei/agentwiki-sync-protocol";

import { canonicalBytes, contentHash } from "../agentwiki/protocol";
import { opaqueFileKey } from "../core/identity-key";
import { isValidSyncPath } from "../core/sync-path";
import type { TreeFolder, TreePage } from "../core/tree-model";
import { validateTreeSnapshot } from "../core/tree-validation";
import type { ControlStorePort } from "../ports/control-store";

type PageMetadata = Omit<TreePage, "body">;

export interface TreeGenerationManifestV2 {
  schemaVersion: 2;
  protocolVersion: "2";
  generationId: string;
  spaceId: string;
  rootPath: string;
  baseRevision: string;
  baseRevisionContentHash: string;
  baseFolderCount: number;
  basePageCount: number;
  baseRevisionManifestByteLength: number;
  baseRevisionBodyBytes: number;
  lastSuccessfulSyncAt: string;
  folders: Record<string, TreeFolder>;
  pages: Record<string, PageMetadata>;
}

export class TreeGenerationRepository {
  constructor(
    private readonly store: ControlStorePort,
    private readonly root: string,
  ) {}

  private async localFileName(pageId: string, path: string): Promise<string> {
    if (path && isValidSyncPath(path)) return path;
    return `${await opaqueFileKey(pageId)}.md`;
  }

  private manifestPath(generationId: string): string {
    return `${this.root}/generations/${generationId}/manifest.json`;
  }

  private bodyPath(generationId: string, fileName: string): string {
    return `${this.root}/generations/${generationId}/base/${fileName}`;
  }

  private async revisionManifest(
    meta: Pick<TreeGenerationManifestV2, "spaceId" | "folders" | "pages">,
    hydratedPages: TreePage[],
  ): Promise<{ contentHash: string; manifestByteLength: number }> {
    const folders = Object.values(meta.folders);
    const contentHash = await treeRevisionContentHashV2({
      protocolVersion: "2",
      spaceId: meta.spaceId,
      folders,
      pages: hydratedPages,
    });
    const metadata = {
      protocolVersion: "2" as const,
      spaceId: meta.spaceId,
      folders,
      pages: Object.values(meta.pages),
    };
    return {
      contentHash,
      manifestByteLength: canonicalBytes(metadata).byteLength,
    };
  }

  async write(
    input: TreeGenerationManifestV2,
    bodies: Record<string, string>,
  ): Promise<TreeGenerationManifestV2> {
    const pages: Record<string, PageMetadata> = {};
    const hydrated: TreePage[] = [];
    let bodyBytes = 0;
    for (const [pageId, page] of Object.entries(input.pages)) {
      const body = bodies[pageId];
      if (body === undefined) throw new Error(`缺少基础内容： ${pageId}`);
      const hash = await contentHash(body);
      bodyBytes += new TextEncoder().encode(body).byteLength;
      const metadata: PageMetadata = { ...page, contentHash: hash };
      pages[pageId] = metadata;
      hydrated.push({ ...metadata, body });
      await this.store.write(
        this.bodyPath(
          input.generationId,
          await this.localFileName(pageId, page.path),
        ),
        body,
      );
    }

    const revision = await this.revisionManifest(
      { spaceId: input.spaceId, folders: input.folders, pages },
      hydrated,
    );
    const manifest: TreeGenerationManifestV2 = {
      ...input,
      pages,
      baseFolderCount: Object.keys(input.folders).length,
      basePageCount: Object.keys(pages).length,
      baseRevisionBodyBytes: bodyBytes,
      baseRevisionManifestByteLength: revision.manifestByteLength,
      baseRevisionContentHash: revision.contentHash,
    };
    await this.store.write(
      this.manifestPath(input.generationId),
      JSON.stringify(manifest),
    );
    await this.verify(input.generationId);
    return manifest;
  }

  async verify(generationId: string): Promise<TreeGenerationManifestV2> {
    const raw = await this.store.read(this.manifestPath(generationId));
    if (raw === null) throw new Error("基线损坏: 清单缺失");
    let manifest: TreeGenerationManifestV2;
    try {
      manifest = JSON.parse(raw) as TreeGenerationManifestV2;
    } catch {
      throw new Error("基线损坏: 清单无效");
    }
    if (manifest.schemaVersion !== 2)
      throw new Error("基线损坏: 未知的清单版本");
    if (
      manifest.generationId !== generationId ||
      manifest.protocolVersion !== "2"
    )
      throw new Error("基线损坏: 身份无效");

    for (const [key, folder] of Object.entries(manifest.folders))
      if (key !== folder.folderId || !folder.folderId)
        throw new Error("基线损坏: 文件夹身份不匹配");
    for (const [key, page] of Object.entries(manifest.pages))
      if (key !== page.pageId || !page.pageId)
        throw new Error("基线损坏: 页面身份不匹配");

    const hydrated = await this.hydratePages(manifest.pages, generationId);
    let bodyBytes = 0;
    for (const page of hydrated)
      bodyBytes += new TextEncoder().encode(page.body).byteLength;

    const revision = await this.revisionManifest(manifest, hydrated);
    if (
      manifest.baseFolderCount !== Object.keys(manifest.folders).length ||
      manifest.basePageCount !== hydrated.length ||
      manifest.baseRevisionBodyBytes !== bodyBytes ||
      manifest.baseRevisionManifestByteLength !== revision.manifestByteLength ||
      manifest.baseRevisionContentHash !== revision.contentHash
    )
      throw new Error("基线损坏: 修订指标不匹配");

    validateTreeSnapshot({
      protocolVersion: "2",
      spaceId: manifest.spaceId,
      revision: manifest.baseRevision,
      revisionContentHash: manifest.baseRevisionContentHash,
      folders: Object.values(manifest.folders),
      pages: hydrated,
    });
    return manifest;
  }

  private async hydratePages(
    pages: Record<string, PageMetadata>,
    generationId: string,
  ): Promise<TreePage[]> {
    const hydrated: TreePage[] = [];
    for (const page of Object.values(pages))
      hydrated.push({
        ...page,
        body: await this.readBodyForPage(generationId, page, page.contentHash),
      });
    return hydrated;
  }

  /**
   * 读取单个页面的正文 sidecar 并校验内容哈希。调用方必须传入已验证清单里的
   * page metadata，避免每读一页都重新走一次 verify()（否则读 N 页会变成 O(N²)）。
   */
  private async readBodyForPage(
    generationId: string,
    page: PageMetadata,
    expectedHash: string,
  ): Promise<string> {
    const fileName = await this.localFileName(page.pageId, page.path);
    let body = await this.store.read(this.bodyPath(generationId, fileName));
    if (body === null && isValidSyncPath(page.path)) {
      body = await this.store.read(
        this.bodyPath(generationId, `${await opaqueFileKey(page.pageId)}.md`),
      );
    }
    if (body === null || (await contentHash(body)) !== expectedHash)
      throw new Error("基线损坏: 页面内容哈希不匹配");
    return body;
  }

  async read(generationId: string): Promise<{
    manifest: TreeGenerationManifestV2;
    bodies: Record<string, string>;
  }> {
    const manifest = await this.verify(generationId);
    const bodies: Record<string, string> = {};
    for (const page of Object.values(manifest.pages))
      bodies[page.pageId] = await this.readBodyForPage(
        generationId,
        page,
        page.contentHash,
      );
    return { manifest, bodies };
  }

  async readManifest(generationId: string): Promise<TreeGenerationManifestV2> {
    return this.verify(generationId);
  }

  async readBody(
    generationId: string,
    pageId: string,
    expectedHash: string,
  ): Promise<string> {
    const manifest = await this.readManifest(generationId);
    const page = manifest.pages[pageId];
    if (!page) throw new Error("基线损坏: 页面缺失");
    return this.readBodyForPage(generationId, page, expectedHash);
  }
}
