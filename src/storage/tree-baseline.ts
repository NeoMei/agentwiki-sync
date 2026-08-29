import { canonicalBytes, sha256Hex } from "../agentwiki/protocol";
import type { TreeSnapshot } from "../core/tree-model";
import { validateTreeSnapshot } from "../core/tree-validation";
import type { ControlStorePort } from "../ports/control-store";
import type { BaselineRepository } from "./baseline";
import { MutableControlRepository } from "./envelope";
import { isCurrentPointerPayload, type CurrentPointerPayload } from "./pointer";
import {
  TreeGenerationRepository,
  type TreeGenerationManifestV2,
} from "./tree-generation";

const EPOCH_RFC3339 = "1970-01-01T00:00:00.000Z";

export type TreeBaselineKind = "pull" | "push" | "initialize";

interface TreeBaselineJournal {
  schemaVersion: 2;
  transactionId: string;
  kind: TreeBaselineKind;
  phase:
    | "prepared"
    | "applying"
    | "committing"
    | "committed"
    | "rolled_back"
    | "failed";
  oldGenerationId: string | null;
  newGenerationId: string;
}

function isTreeBaselineJournal(value: unknown): value is TreeBaselineJournal {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TreeBaselineJournal>;
  return (
    item.schemaVersion === 2 &&
    typeof item.transactionId === "string" &&
    ["pull", "push", "initialize"].includes(item.kind ?? "") &&
    [
      "prepared",
      "applying",
      "committing",
      "committed",
      "rolled_back",
      "failed",
    ].includes(item.phase ?? "") &&
    (item.oldGenerationId === null ||
      typeof item.oldGenerationId === "string") &&
    typeof item.newGenerationId === "string"
  );
}

export class TreeBaselineRepository {
  private readonly generations: TreeGenerationRepository;
  private readonly pointer: MutableControlRepository<CurrentPointerPayload>;
  private readonly journal: MutableControlRepository<TreeBaselineJournal>;
  private readonly treeRoot: string;

  constructor(
    private readonly store: ControlStorePort,
    private readonly root: string,
    private readonly spaceId: string,
    private readonly rootPath: string,
  ) {
    this.treeRoot = `${root}/tree-v2`;
    this.generations = new TreeGenerationRepository(store, this.treeRoot);
    this.pointer = new MutableControlRepository(
      store,
      `${this.treeRoot}/current.json`,
      isCurrentPointerPayload,
    );
    this.journal = new MutableControlRepository(
      store,
      `${this.treeRoot}/baseline-journal.json`,
      isTreeBaselineJournal,
    );
  }

  async readOptional(): Promise<TreeGenerationManifestV2 | null> {
    const current = await this.pointer.read();
    if (!current?.payload.active) return null;
    const manifest = await this.generations.readManifest(
      current.payload.generationId,
    );
    if (
      manifest.spaceId !== this.spaceId ||
      manifest.rootPath !== this.rootPath ||
      (await sha256Hex(canonicalBytes(manifest))) !==
        current.payload.manifestHash
    )
      throw new Error("基线损坏: 指针身份/哈希不匹配");
    return manifest;
  }

  async read(): Promise<TreeGenerationManifestV2> {
    const manifest = await this.readOptional();
    if (!manifest) throw new Error("基线缺失");
    return manifest;
  }

  async prepare(
    snapshot: TreeSnapshot,
    kind: TreeBaselineKind,
  ): Promise<TreeBaselineJournal> {
    const validated = validateTreeSnapshot(snapshot);
    if (validated.protocolVersion !== "2")
      throw new TypeError("树基线仅接受 v2 快照");
    const current = await this.pointer.read();
    const generationId = crypto.randomUUID();
    const folders = Object.fromEntries(
      validated.folders.map((folder) => [folder.folderId, folder]),
    );
    const pageMap = Object.fromEntries(
      validated.pages.map((page) => {
        const { body: _body, ...metadata } = page;
        return [page.pageId, metadata];
      }),
    );
    const bodies = Object.fromEntries(
      validated.pages.map((page) => [page.pageId, page.body]),
    );
    await this.generations.write(
      {
        schemaVersion: 2,
        protocolVersion: "2",
        generationId,
        spaceId: this.spaceId,
        rootPath: this.rootPath,
        baseRevision: validated.revision,
        baseRevisionContentHash: "",
        baseFolderCount: validated.folders.length,
        basePageCount: validated.pages.length,
        baseRevisionManifestByteLength: 0,
        baseRevisionBodyBytes: 0,
        lastSuccessfulSyncAt: new Date().toISOString(),
        folders,
        pages: pageMap,
      },
      bodies,
    );
    const value: TreeBaselineJournal = {
      schemaVersion: 2,
      transactionId: crypto.randomUUID(),
      kind,
      phase: "prepared",
      oldGenerationId: current?.payload.active
        ? current.payload.generationId
        : null,
      newGenerationId: generationId,
    };
    await this.journal.write(value);
    return value;
  }

  async setPhase(phase: TreeBaselineJournal["phase"]): Promise<void> {
    const current = await this.journal.read();
    if (!current) throw new Error("基线日志缺失");
    await this.journal.write({ ...current.payload, phase });
  }

  async commit(): Promise<void> {
    const current = await this.journal.read();
    if (!current) throw new Error("基线日志缺失");
    await this.journal.write({ ...current.payload, phase: "committing" });
    const manifest = await this.generations.verify(
      current.payload.newGenerationId,
    );
    if (
      manifest.spaceId !== this.spaceId ||
      manifest.rootPath !== this.rootPath
    )
      throw new Error("基线身份不匹配");
    const manifestHash = await sha256Hex(canonicalBytes(manifest));
    await this.pointer.write({
      schemaVersion: 1,
      active: true,
      generationId: current.payload.newGenerationId,
      manifestHash,
    });
    await this.journal.write({ ...current.payload, phase: "committed" });
    await this.pruneGenerations();
  }

  /**
   * 每次提交都会写入一份完整 generation；只保留指针候选与日志引用的代，
   * 避免无限累积，同时保留在途事务与回滚所需的最近两代。
   */
  private async pruneGenerations(): Promise<void> {
    if (!this.store.list) return;
    const keep = new Set<string>();
    for (const candidate of await this.pointer.candidates())
      if (candidate.payload.active) keep.add(candidate.payload.generationId);
    const journal = await this.journal.read();
    if (journal) {
      keep.add(journal.payload.newGenerationId);
      if (journal.payload.oldGenerationId)
        keep.add(journal.payload.oldGenerationId);
    }
    const generationsRoot = `${this.treeRoot}/generations`;
    const listing = await this.store.list(generationsRoot);
    for (const folder of listing.folders) {
      const id = folder.slice(generationsRoot.length + 1);
      if (keep.has(id)) continue;
      try {
        await this.store.removeTree?.(folder);
      } catch {
        // Best-effort: stale generations are inert and retried later.
      }
    }
  }

  async recover(committedTransactionId: string | null): Promise<void> {
    const current = await this.journal.read();
    if (
      !current ||
      current.payload.phase === "committed" ||
      current.payload.phase === "rolled_back"
    )
      return;
    if (committedTransactionId === current.payload.transactionId) {
      await this.commit();
      return;
    }
    await this.journal.write({ ...current.payload, phase: "rolled_back" });
  }

  async readLegacyEvidence(
    legacy: BaselineRepository,
  ): Promise<TreeSnapshot | null> {
    const base = await legacy.read();
    if (base.revision === "0" && Object.keys(base.pages).length === 0)
      return null;
    return validateTreeSnapshot({
      protocolVersion: "1",
      spaceId: this.spaceId,
      revision: base.revision,
      revisionContentHash: "",
      folders: [],
      pages: await Promise.all(
        Object.values(base.pages).map(async (page) => ({
          pageId: page.pageId,
          folderId: null,
          path: page.relativePath,
          title: page.title,
          body: await legacy.readBody(
            page.pageId,
            base.generationId,
            page.contentHash,
          ),
          contentHash: page.contentHash,
          updatedAt: EPOCH_RFC3339,
        })),
      ),
    });
  }
}
