import {
  TreeRevisionContentManifestV3Schema,
  treeRevisionContentHashV2,
  treeRevisionContentHashV3,
} from "@neomei/agentwiki-sync-protocol";

import { canonicalBytes, contentHash } from "../agentwiki/protocol";
import { opaqueFileKey } from "../core/identity-key";
import { isValidSyncPath } from "../core/sync-path";
import type {
  TreeAttachment,
  TreeFolder,
  TreePage,
  TreePageV3,
} from "../core/tree-model";
import { validateTreeSnapshot } from "../core/tree-validation";
import type { ControlStorePort } from "../ports/control-store";

type PageMetadata = Omit<TreePage, "body">;
type PageMetadataV3 = Omit<TreePageV3, "body">;

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

export interface TreeGenerationManifestV3 {
  schemaVersion: 3;
  protocolVersion: "3";
  generationId: string;
  spaceId: string;
  rootPath: string;
  baseRevision: string;
  baseRevisionContentHash: string;
  baseFolderCount: number;
  basePageCount: number;
  baseAttachmentCount: number;
  baseRevisionManifestByteLength: number;
  baseRevisionBodyBytes: number;
  baseRevisionAttachmentBytes: number;
  lastSuccessfulSyncAt: string;
  folders: Record<string, TreeFolder>;
  pages: Record<string, PageMetadataV3>;
  attachments: Record<string, TreeAttachment>;
}

export type TreeGenerationManifest =
  TreeGenerationManifestV2 | TreeGenerationManifestV3;

export interface TreeGenerationMetricsV3 {
  contentHash: string;
  folderCount: number;
  pageCount: number;
  attachmentCount: number;
  manifestByteLength: number;
  bodyBytes: number;
  attachmentBytes: number;
}

const HASH = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
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

  async metricsV3(input: {
    spaceId: string;
    folders: Record<string, TreeFolder>;
    pages: Record<string, PageMetadataV3>;
    attachments: Record<string, TreeAttachment>;
    bodies: Record<string, string>;
  }): Promise<TreeGenerationMetricsV3> {
    const hydratedPages: TreePageV3[] = [];
    let bodyBytes = 0;
    for (const [pageId, page] of Object.entries(input.pages)) {
      if (pageId !== page.pageId) throw new Error("Invalid v3 page identity");
      const body = input.bodies[pageId];
      if (body === undefined) throw new Error(`Missing base body: ${pageId}`);
      if ((await contentHash(body)) !== page.contentHash)
        throw new Error("V3 generation body content hash mismatch");
      bodyBytes += new TextEncoder().encode(body).byteLength;
      hydratedPages.push({ ...page, body });
    }
    for (const [folderId, folder] of Object.entries(input.folders))
      if (folderId !== folder.folderId)
        throw new Error("Invalid v3 folder identity");
    let attachmentBytes = 0;
    for (const [attachmentId, attachment] of Object.entries(
      input.attachments,
    )) {
      if (attachmentId !== attachment.attachmentId)
        throw new Error("Invalid v3 attachment identity");
      attachmentBytes += Number(attachment.sizeBytes);
      if (!Number.isSafeInteger(attachmentBytes))
        throw new Error("Invalid v3 attachment byte count");
    }
    const metadata = TreeRevisionContentManifestV3Schema.parse({
      protocolVersion: "3",
      spaceId: input.spaceId,
      folders: Object.values(input.folders),
      pages: hydratedPages,
      attachments: Object.values(input.attachments),
    });
    return {
      contentHash: await treeRevisionContentHashV3(metadata),
      folderCount: Object.keys(input.folders).length,
      pageCount: Object.keys(input.pages).length,
      attachmentCount: Object.keys(input.attachments).length,
      manifestByteLength: canonicalBytes(metadata).byteLength,
      bodyBytes,
      attachmentBytes,
    };
  }

  async write(
    input: TreeGenerationManifestV2,
    bodies: Record<string, string>,
  ): Promise<TreeGenerationManifestV2>;
  async write(
    input: TreeGenerationManifestV3,
    bodies: Record<string, string>,
  ): Promise<TreeGenerationManifestV3>;
  async write(
    input: TreeGenerationManifest,
    bodies: Record<string, string>,
  ): Promise<TreeGenerationManifest> {
    if (input.schemaVersion === 3) return this.writeV3(input, bodies);
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

  private async writeV3(
    input: TreeGenerationManifestV3,
    bodies: Record<string, string>,
  ): Promise<TreeGenerationManifestV3> {
    const metrics = await this.metricsV3({
      spaceId: input.spaceId,
      folders: input.folders,
      pages: input.pages,
      attachments: input.attachments,
      bodies,
    });
    if (
      input.baseRevisionContentHash !== metrics.contentHash ||
      input.baseFolderCount !== metrics.folderCount ||
      input.basePageCount !== metrics.pageCount ||
      input.baseAttachmentCount !== metrics.attachmentCount ||
      input.baseRevisionManifestByteLength !== metrics.manifestByteLength ||
      input.baseRevisionBodyBytes !== metrics.bodyBytes ||
      input.baseRevisionAttachmentBytes !== metrics.attachmentBytes
    )
      throw new Error("V3 generation authority hash or metrics mismatch");
    for (const [pageId, page] of Object.entries(input.pages))
      await this.store.write(
        this.bodyPath(
          input.generationId,
          await this.localFileName(pageId, page.path),
        ),
        bodies[pageId]!,
      );
    await this.store.write(
      this.manifestPath(input.generationId),
      JSON.stringify(input),
    );
    const verified = await this.verify(input.generationId);
    if (verified.schemaVersion !== 3)
      throw new Error("V3 generation verification failed");
    return verified;
  }

  async verify(generationId: string): Promise<TreeGenerationManifest> {
    const raw = await this.store.read(this.manifestPath(generationId));
    if (raw === null) throw new Error("基线损坏: 清单缺失");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("基线损坏: 清单无效");
    }
    if (!isRecord(parsed) || typeof parsed.schemaVersion !== "number")
      throw new Error("基线损坏: 清单无效");
    if (parsed.schemaVersion > 3)
      throw new Error("Unknown tree generation schema version");
    if (parsed.schemaVersion === 3) return this.verifyV3(parsed, generationId);
    if (parsed.schemaVersion !== 2) throw new Error("基线损坏: 未知的清单版本");
    const manifest = parsed as unknown as TreeGenerationManifestV2;
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

  private async verifyV3(
    parsed: Record<string, unknown>,
    generationId: string,
  ): Promise<TreeGenerationManifestV3> {
    if (
      !hasOnlyKeys(parsed, [
        "schemaVersion",
        "protocolVersion",
        "generationId",
        "spaceId",
        "rootPath",
        "baseRevision",
        "baseRevisionContentHash",
        "baseFolderCount",
        "basePageCount",
        "baseAttachmentCount",
        "baseRevisionManifestByteLength",
        "baseRevisionBodyBytes",
        "baseRevisionAttachmentBytes",
        "lastSuccessfulSyncAt",
        "folders",
        "pages",
        "attachments",
      ]) ||
      parsed.protocolVersion !== "3" ||
      parsed.generationId !== generationId ||
      typeof parsed.spaceId !== "string" ||
      typeof parsed.rootPath !== "string" ||
      typeof parsed.baseRevision !== "string" ||
      typeof parsed.baseRevisionContentHash !== "string" ||
      !HASH.test(parsed.baseRevisionContentHash) ||
      typeof parsed.lastSuccessfulSyncAt !== "string" ||
      !isRecord(parsed.folders) ||
      !isRecord(parsed.pages) ||
      !isRecord(parsed.attachments)
    )
      throw new Error("Invalid v3 tree generation manifest");
    for (const metric of [
      parsed.baseFolderCount,
      parsed.basePageCount,
      parsed.baseAttachmentCount,
      parsed.baseRevisionManifestByteLength,
      parsed.baseRevisionBodyBytes,
      parsed.baseRevisionAttachmentBytes,
    ])
      if (!Number.isSafeInteger(metric) || (metric as number) < 0)
        throw new Error("Invalid v3 tree generation manifest");
    const manifest = parsed as unknown as TreeGenerationManifestV3;
    const bodies: Record<string, string> = {};
    for (const [pageId, page] of Object.entries(manifest.pages)) {
      if (!isRecord(page)) throw new Error("Invalid v3 page metadata");
      bodies[pageId] = await this.readBodyForPage(
        generationId,
        page,
        page.contentHash,
      );
    }
    const metrics = await this.metricsV3({
      spaceId: manifest.spaceId,
      folders: manifest.folders,
      pages: manifest.pages,
      attachments: manifest.attachments,
      bodies,
    });
    if (
      manifest.baseRevisionContentHash !== metrics.contentHash ||
      manifest.baseFolderCount !== metrics.folderCount ||
      manifest.basePageCount !== metrics.pageCount ||
      manifest.baseAttachmentCount !== metrics.attachmentCount ||
      manifest.baseRevisionManifestByteLength !== metrics.manifestByteLength ||
      manifest.baseRevisionBodyBytes !== metrics.bodyBytes ||
      manifest.baseRevisionAttachmentBytes !== metrics.attachmentBytes
    )
      throw new Error("基线损坏: v3 修订指标不匹配");
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
    manifest: TreeGenerationManifest;
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

  async readManifest(generationId: string): Promise<TreeGenerationManifest> {
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
