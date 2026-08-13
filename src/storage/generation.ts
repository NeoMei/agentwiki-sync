import { canonicalBytes, contentHash, revisionContentHash } from "../agentwiki/protocol";
import type { ControlStorePort } from "../ports/control-store";
import { portablePathKey, validatePortablePath, validateTitle } from "../core/portable-path";

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
  pages: Record<string, { pageId: string; relativePath: string; title: string; contentHash: string }>;
}

export class GenerationRepository {
  constructor(private readonly store: ControlStorePort, private readonly root: string) {}

  private path(generationId: string, suffix: string): string { return `${this.root}/generations/${generationId}/${suffix}`; }

  async write(input: SpaceManifest, baseBodies: Record<string, string>): Promise<SpaceManifest> {
    const pages = { ...input.pages };
    let bodyBytes = 0;
    for (const [pageId, page] of Object.entries(pages)) {
      const body = baseBodies[pageId];
      if (body === undefined) throw new Error(`Missing base body for ${pageId}`);
      page.contentHash = await contentHash(body);
      bodyBytes += new TextEncoder().encode(body).byteLength;
      await this.store.write(this.path(input.generationId, `base/${encodeURIComponent(pageId)}.md`), body);
    }
    const protocolManifest = { pages: Object.values(pages).map((page) => ({ pageId: page.pageId, path: page.relativePath, title: page.title, contentHash: page.contentHash })) };
    const manifest: SpaceManifest = {
      ...input, pages, basePageCount: Object.keys(pages).length, baseRevisionBodyBytes: bodyBytes,
      baseRevisionManifestByteLength: pages && Object.keys(pages).length > 0 ? canonicalBytes(protocolManifest).byteLength : 0,
      baseRevisionContentHash: await revisionContentHash(protocolManifest)
    };
    await this.store.write(this.path(input.generationId, "manifest.json"), JSON.stringify(manifest));
    await this.verify(input.generationId);
    return manifest;
  }

  async verify(generationId: string): Promise<SpaceManifest> {
    const raw = await this.store.read(this.path(generationId, "manifest.json"));
    if (raw === null) throw new Error("baseline corrupt: missing manifest");
    let manifest: SpaceManifest;
    try { manifest = JSON.parse(raw) as SpaceManifest; } catch { throw new Error("baseline corrupt: invalid manifest"); }
    if (manifest.schemaVersion !== 1 || manifest.generationId !== generationId) throw new Error("baseline corrupt: invalid identity");
    const pathKeys=new Set<string>();for(const [key,page] of Object.entries(manifest.pages)){if(key!==page.pageId||!page.pageId)throw new Error("baseline corrupt: page identity mismatch");const path=validatePortablePath(page.relativePath);validateTitle(page.title);if(pathKeys.has(path.key))throw new Error("baseline corrupt: path collision");pathKeys.add(portablePathKey(path.path));}
    let bodyBytes = 0;
    for (const page of Object.values(manifest.pages)) {
      const body = await this.store.read(this.path(generationId, `base/${encodeURIComponent(page.pageId)}.md`));
      if (body === null || await contentHash(body) !== page.contentHash) throw new Error("baseline corrupt: base hash mismatch");
      bodyBytes += new TextEncoder().encode(body).byteLength;
    }
    const protocolManifest = { pages: Object.values(manifest.pages).map((page) => ({ pageId: page.pageId, path: page.relativePath, title: page.title, contentHash: page.contentHash })) };
    const manifestBytes = Object.keys(manifest.pages).length > 0 ? canonicalBytes(protocolManifest).byteLength : 0;
    if (manifest.basePageCount !== Object.keys(manifest.pages).length || manifest.baseRevisionBodyBytes !== bodyBytes || manifest.baseRevisionManifestByteLength !== manifestBytes || manifest.baseRevisionContentHash !== await revisionContentHash(protocolManifest)) throw new Error("baseline corrupt: revision metrics mismatch");
    return manifest;
  }

  async read(generationId: string): Promise<{ manifest: SpaceManifest; bodies: Record<string, string> }> {
    const manifest = await this.verify(generationId); const bodies: Record<string, string> = {};
    for (const page of Object.values(manifest.pages)) { const body = await this.store.read(this.path(generationId, `base/${encodeURIComponent(page.pageId)}.md`)); if (body === null) throw new Error("baseline corrupt: missing body"); bodies[page.pageId] = body; }
    return { manifest, bodies };
  }
}
