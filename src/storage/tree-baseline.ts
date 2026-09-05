import { canonicalBytes, sha256Hex } from "../agentwiki/protocol";
import { treeRevisionContentHashV3 } from "@neomei/agentwiki-sync-protocol";

import type { TreeSnapshot, TreeSnapshotV3 } from "../core/tree-model";
import { validateTreeSnapshot } from "../core/tree-validation";
import type { ControlStorePort } from "../ports/control-store";
import type { BaselineRepository } from "./baseline";
import { MutableControlRepository } from "./envelope";
import {
  isCurrentPointerPayload,
  pointerSwapDecision,
  selectCurrentPointer,
  type CurrentPointerPayload,
  type TransactionGate,
} from "./pointer";
import {
  TreeGenerationRepository,
  type TreeGenerationManifest,
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
  oldPointerWriteGeneration?: number | null;
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
    typeof item.newGenerationId === "string" &&
    (item.oldPointerWriteGeneration === undefined ||
      item.oldPointerWriteGeneration === null ||
      (Number.isSafeInteger(item.oldPointerWriteGeneration) &&
        item.oldPointerWriteGeneration >= 1))
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

  async readOptional(): Promise<TreeGenerationManifest | null> {
    const current = await this.selectPointer();
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

  private async selectPointer() {
    const journal = await this.journal.read();
    const gate: TransactionGate | null = journal
      ? {
          state:
            journal.payload.phase === "rolled_back"
              ? "rolling_back"
              : journal.payload.phase,
          oldGenerationId: journal.payload.oldGenerationId,
          newGenerationId: journal.payload.newGenerationId,
          newGenerationVerified: journal.payload.phase === "committed",
        }
      : null;
    return selectCurrentPointer(await this.pointer.candidates(), gate);
  }

  async read(): Promise<TreeGenerationManifest> {
    const manifest = await this.readOptional();
    if (!manifest) throw new Error("基线缺失");
    return manifest;
  }

  /**
   * 还原当前 v2 基线的完整 TreeSnapshot（含每页正文），供三方比较使用。
   */
  async readSnapshot(): Promise<TreeSnapshot | TreeSnapshotV3> {
    const manifest = await this.read();
    const { bodies } = await this.generations.read(manifest.generationId);
    const pages = Object.values(manifest.pages).map((page) => ({
      ...page,
      body: bodies[page.pageId]!,
    }));
    if (manifest.schemaVersion === 3)
      return {
        protocolVersion: "3",
        spaceId: manifest.spaceId,
        revision: manifest.baseRevision,
        revisionContentHash: manifest.baseRevisionContentHash,
        folders: Object.values(manifest.folders),
        pages,
        attachments: Object.values(manifest.attachments),
      } as TreeSnapshotV3;
    return {
      protocolVersion: "2",
      spaceId: manifest.spaceId,
      revision: manifest.baseRevision,
      revisionContentHash: manifest.baseRevisionContentHash,
      folders: Object.values(manifest.folders),
      pages,
    };
  }

  revisionContentHashV3(snapshot: TreeSnapshotV3): Promise<string> {
    return treeRevisionContentHashV3({
      protocolVersion: "3",
      spaceId: snapshot.spaceId,
      folders: snapshot.folders,
      pages: snapshot.pages,
      attachments: snapshot.attachments,
    });
  }

  async prepare(
    snapshot: TreeSnapshot,
    kind: TreeBaselineKind,
    transactionId?: string,
  ): Promise<TreeBaselineJournal>;
  async prepare(
    snapshot: TreeSnapshotV3,
    kind: TreeBaselineKind,
    transactionId?: string,
  ): Promise<TreeBaselineJournal>;
  async prepare(
    snapshot: TreeSnapshot | TreeSnapshotV3,
    kind: TreeBaselineKind,
    transactionId?: string,
  ): Promise<TreeBaselineJournal> {
    const current = await this.selectPointer();
    if (snapshot.protocolVersion === "3" && kind !== "pull") {
      const existing = current?.payload.active
        ? await this.generations.verify(current.payload.generationId)
        : null;
      if (existing?.schemaVersion !== 3)
        throw new Error("V3 bootstrap requires a confirmed Pull");
    }
    const generationId = crypto.randomUUID();
    if (snapshot.protocolVersion === "3") {
      const folders = Object.fromEntries(
        snapshot.folders.map((folder) => [folder.folderId, folder]),
      );
      const pages = Object.fromEntries(
        snapshot.pages.map((page) => {
          const { body: _body, ...metadata } = page;
          return [page.pageId, metadata];
        }),
      );
      const attachments = Object.fromEntries(
        snapshot.attachments.map((item) => [item.attachmentId, item]),
      );
      const bodies = Object.fromEntries(
        snapshot.pages.map((page) => [page.pageId, page.body]),
      );
      const metrics = await this.generations.metricsV3({
        spaceId: snapshot.spaceId,
        folders,
        pages,
        attachments,
        bodies,
      });
      if (snapshot.revisionContentHash !== metrics.contentHash)
        throw new Error("V3 snapshot authority hash mismatch");
      await this.generations.write(
        {
          schemaVersion: 3,
          protocolVersion: "3",
          generationId,
          spaceId: this.spaceId,
          rootPath: this.rootPath,
          baseRevision: snapshot.revision,
          baseRevisionContentHash: snapshot.revisionContentHash,
          baseFolderCount: metrics.folderCount,
          basePageCount: metrics.pageCount,
          baseAttachmentCount: metrics.attachmentCount,
          baseRevisionManifestByteLength: metrics.manifestByteLength,
          baseRevisionBodyBytes: metrics.bodyBytes,
          baseRevisionAttachmentBytes: metrics.attachmentBytes,
          lastSuccessfulSyncAt: new Date().toISOString(),
          folders,
          pages,
          attachments,
        },
        bodies,
      );
      return this.writePreparedJournal(
        current,
        generationId,
        kind,
        transactionId,
      );
    }
    const validated = validateTreeSnapshot(snapshot);
    if (validated.protocolVersion !== "2")
      throw new TypeError("树基线仅接受 v2/v3 快照");
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
    return this.writePreparedJournal(
      current,
      generationId,
      kind,
      transactionId,
    );
  }

  private async writePreparedJournal(
    current: ReturnType<typeof selectCurrentPointer>,
    generationId: string,
    kind: TreeBaselineKind,
    transactionId: string = crypto.randomUUID(),
  ): Promise<TreeBaselineJournal> {
    const value: TreeBaselineJournal = {
      schemaVersion: 2,
      transactionId,
      kind,
      phase: "prepared",
      oldGenerationId: current?.payload.active
        ? current.payload.generationId
        : null,
      oldPointerWriteGeneration: current?.writeGeneration ?? null,
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

  async hasTransaction(transactionId: string): Promise<boolean> {
    return (await this.journal.read())?.payload.transactionId === transactionId;
  }

  async inspectJournal(): Promise<Pick<
    TreeBaselineJournal,
    "transactionId" | "kind" | "phase"
  > | null> {
    const current = await this.journal.read();
    if (!current) return null;
    const { transactionId, kind, phase } = current.payload;
    return { transactionId, kind, phase };
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
    const candidates = await this.pointer.candidates();
    const decision = pointerSwapDecision(
      candidates,
      {
        writeGeneration:
          current.payload.oldPointerWriteGeneration ??
          (current.payload.oldGenerationId === null
            ? null
            : Math.max(
                ...candidates
                  .filter(
                    (candidate) =>
                      candidate.payload.active &&
                      candidate.payload.generationId ===
                        current.payload.oldGenerationId,
                  )
                  .map((candidate) => candidate.writeGeneration),
              )),
        generationId: current.payload.oldGenerationId,
      },
      current.payload.newGenerationId,
    );
    if (decision === "write")
      await this.pointer.write({
        schemaVersion: 1,
        active: true,
        generationId: current.payload.newGenerationId,
        manifestHash,
      });
    await this.journal.write({ ...current.payload, phase: "committed" });
    await this.pruneGenerations();
  }

  async requiredProtocolVersion(): Promise<"1" | "2" | "3"> {
    const current = await this.readOptional();
    if (!current) return "1";
    return current.schemaVersion === 3 ? "3" : "2";
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
