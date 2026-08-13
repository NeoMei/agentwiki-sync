import { contentHash, type PushChange, type SyncCapabilities, type SyncPage } from "../agentwiki/protocol";
import { computeStatus, resolvePageIdentities, scanMapping } from "../core/status";
import type { LocalStatus, ManifestPage, ScanResult } from "../core/model";
import { mergeBody, type StructuredConflict } from "../core/merge";
import type { ControlStorePort } from "../ports/control-store";
import type { PushRemotePort } from "../ports/push-remote";
import type { VaultPort } from "../ports/vault";
import { PullTransaction, type PullAction } from "./pull-transaction";
import { PushService } from "./push-service";
import type { SpaceMapping } from "./sync-coordinator";

interface BaseState { schemaVersion: 1; revision: string; pages: Record<string, ManifestPage & { body: string }> }
export interface PullPreview { scanEpoch: number; revision: string; actions: PullAction[]; remotePages: SyncPage[]; conflicts: StructuredConflict[] }
export interface PushPreview { revision: string; changes: PushChange[]; capabilities: SyncCapabilities }
interface RuntimeRemote extends PushRemotePort { snapshot(spaceId?: string): Promise<SyncPage[]> }

const DEFAULT_CAPABILITIES: SyncCapabilities = { maxPageBytes: 1048576, maxBatchBytes: 4194304, maxBatchItems: 100, maxChangeCount: 5000, maxConfirmationBytes: 4194304, maxClientSpacePages: 5000, maxClientManifestBytes: 4194304, maxClientTotalBodyBytes: 104857600, maxResponseBytes: 4194304, maxPageItems: 200, pushSessionTtlSeconds: 900 };

export class SyncRuntime {
  private scanEpoch = 0;
  constructor(private readonly vault: VaultPort, private readonly control: ControlStorePort, private readonly remote: RuntimeRemote, private readonly mapping: SpaceMapping, private readonly capabilities = DEFAULT_CAPABILITIES) {}
  private get root(): string { return `.agentwiki/runtime/${this.mapping.spaceId}`; }
  private get basePath(): string { return `${this.root}/base.json`; }
  private get identitiesPath(): string { return `${this.root}/pending-identities.json`; }
  invalidate(): void { this.scanEpoch += 1; }

  private async readBase(): Promise<BaseState> { const raw = await this.control.read(this.basePath); return raw ? JSON.parse(raw) as BaseState : { schemaVersion: 1, revision: "0", pages: {} }; }
  private async writeBase(revision: string, pages: SyncPage[]): Promise<void> {
    const state: BaseState = { schemaVersion: 1, revision, pages: Object.fromEntries(pages.map((page) => [page.pageId, { pageId: page.pageId, relativePath: page.path, title: page.title, contentHash: page.contentHash, body: page.body }])) };
    await this.control.write(this.basePath, JSON.stringify(state));
  }
  private async scan(): Promise<ScanResult> { return scanMapping(await this.vault.listMarkdown(this.mapping.rootPath), { complete: true, scanEpoch: this.scanEpoch, capabilities: { pages: this.capabilities.maxClientSpacePages, bodyBytes: this.capabilities.maxClientTotalBodyBytes, manifestBytes: this.capabilities.maxClientManifestBytes } }); }
  async establishEmptyBase(): Promise<void> { const head = await this.remote.getHead(this.mapping.spaceId); await this.writeBase(head.revision, []); }
  async status(): Promise<{ baseRevision: string; remoteRevision: string; local: LocalStatus }> {
    const base = await this.readBase(); const scan = await this.scan(); const resolved = resolvePageIdentities(base.pages, scan.files, []); const head = await this.remote.getHead(this.mapping.spaceId);
    return { baseRevision: base.revision, remoteRevision: head.revision, local: computeStatus(base.pages, resolved, scan) };
  }
  async previewPull(): Promise<PullPreview> {
    const base = await this.readBase(); const remote = await this.remote.snapshot(this.mapping.spaceId); const scan = await this.scan(); const localByPath = new Map(scan.files.map((file) => [file.relativePath, file]));
    const actions: PullAction[] = []; const conflicts: StructuredConflict[] = [];
    for (const page of remote) {
      const local = localByPath.get(page.path); const path = `${this.mapping.rootPath}/${page.path}`; const basePage = base.pages[page.pageId];
      if (!local) actions.push({ kind: "create", path, body: page.body });
      else if (!basePage) { if (local.contentHash !== page.contentHash) actions.push({ kind: "write", path, body: page.body }); }
      else {
        const merged = await mergeBody(basePage.body, local.normalizedBody, page.body, page.pageId); conflicts.push(...merged.conflicts);
        if (merged.body !== local.normalizedBody) actions.push({ kind: "write", path, body: merged.body });
      }
    }
    const remoteIds = new Set(remote.map((page) => page.pageId));
    for (const page of Object.values(base.pages)) if (!remoteIds.has(page.pageId)) {
      const local = localByPath.get(page.relativePath);
      if (local && local.contentHash !== page.contentHash) conflicts.push((await mergeBody(page.body, local.normalizedBody, "", page.pageId)).conflicts[0] ?? { conflictId: page.pageId, base: page.body, local: local.normalizedBody, remote: "", wholeDocument: true });
      else if (local) actions.push({ kind: "trash", path: `${this.mapping.rootPath}/${page.relativePath}` });
    }
    return { scanEpoch: scan.scanEpoch, revision: (await this.remote.getHead(this.mapping.spaceId)).revision, actions, remotePages: remote, conflicts };
  }
  async applyPull(preview: PullPreview): Promise<void> { if (preview.conflicts.length > 0) throw new Error("Pull has unresolved structured conflicts"); const tx = new PullTransaction(this.vault, this.control, `${this.root}/pull`); await tx.prepare(preview.actions, preview.scanEpoch); await tx.apply(this.scanEpoch); await this.writeBase(preview.revision, preview.remotePages); this.mapping.status = "active"; }
  async previewPush(): Promise<PushPreview> {
    const base = await this.readBase(); const head = await this.remote.getHead(this.mapping.spaceId); if (head.revision !== base.revision) throw new Error("BASE_STALE");
    const scan = await this.scan(); const resolved = resolvePageIdentities(base.pages, scan.files, []); const local = computeStatus(base.pages, resolved, scan); if (local.ambiguous.length > 0) throw new Error("IDENTITY_REQUIRED");
    const rawIdentities = await this.control.read(this.identitiesPath); const identities = rawIdentities ? JSON.parse(rawIdentities) as Record<string, { pageId: string; contentHash: string }> : {};
    const changes: PushChange[] = [];
    for (const file of [...local.added, ...local.modified, ...local.renamed]) { const identity = identities[file.relativePath]; const pageId = file.pageId ?? (identity?.contentHash === file.contentHash ? identity.pageId : crypto.randomUUID()); if (!file.pageId) identities[file.relativePath] = { pageId, contentHash: file.contentHash }; changes.push({ operation: "upsert", pageId, path: file.relativePath, title: file.title, body: file.normalizedBody, contentHash: await contentHash(file.normalizedBody) }); }
    await this.control.write(this.identitiesPath, JSON.stringify(identities));
    for (const page of local.deleted) changes.push({ operation: "archive", pageId: page.pageId, previousPath: page.relativePath });
    return { revision: base.revision, changes, capabilities: this.capabilities };
  }
  async applyPush(preview: PushPreview): Promise<void> { if (preview.changes.length === 0) return; const result = await new PushService(this.remote, this.control, `${this.root}/push`).publish({ spaceId: this.mapping.spaceId, baseRevision: preview.revision, changes: preview.changes, capabilities: preview.capabilities }); await this.writeBase(result.revision, await this.remote.snapshot(this.mapping.spaceId)); await this.control.remove(this.identitiesPath); this.mapping.status = "active"; }
}
