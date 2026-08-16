import { sha256Hex } from "../agentwiki/protocol";
import type { ControlStorePort } from "../ports/control-store";
import type { VaultPort } from "../ports/vault";
import { MutableControlRepository } from "../storage/envelope";

export type PullAction =
  | { kind: "create" | "write"; path: string; body?: string; bodyPath?: string }
  | {
      kind: "rename";
      fromPath: string;
      path: string;
      body?: string;
      bodyPath?: string;
    }
  | { kind: "trash"; path: string };

type JournalAction =
  | {
      kind: "create" | "write";
      path: string;
      resultPath: string;
      resultHash: string;
    }
  | {
      kind: "rename";
      fromPath: string;
      path: string;
      resultPath: string;
      resultHash: string;
    }
  | { kind: "trash"; path: string };
interface SnapshotEntry {
  path: string;
  snapshotPath: string | null;
  hash: string | null;
}
interface PullJournal {
  schemaVersion: 1;
  transactionId: string;
  state:
    | "prepared"
    | "applying"
    | "committed"
    | "rolling_back"
    | "rolled_back"
    | "failed";
  scanEpoch: number;
  actions: JournalAction[];
  snapshots: SnapshotEntry[];
  temporaryPaths: Array<{
    original: string;
    temporary: string;
    expectedHash: string | null;
  }>;
  materialized: Array<{
    path: string;
    resultHash: string;
    expectedHash: string | null;
  }>;
}
function isPullJournal(value: unknown): value is PullJournal {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Partial<PullJournal>).schemaVersion === 1 &&
    typeof (value as Partial<PullJournal>).transactionId === "string" &&
    [
      "prepared",
      "applying",
      "committed",
      "rolling_back",
      "rolled_back",
      "failed",
    ].includes((value as Partial<PullJournal>).state ?? "") &&
    Array.isArray((value as Partial<PullJournal>).actions) &&
    Array.isArray((value as Partial<PullJournal>).snapshots)
  );
}

const encoder = new TextEncoder();
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return globalThis.btoa(binary);
}
function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export class PullTransaction {
  private readonly journal: MutableControlRepository<PullJournal>;
  constructor(
    private readonly vault: VaultPort,
    private readonly control: ControlStorePort,
    private readonly root: string,
  ) {
    this.journal = new MutableControlRepository(
      control,
      `${root}/journal.json`,
      isPullJournal,
    );
  }
  private async save(journal: PullJournal): Promise<void> {
    await this.journal.write(journal);
  }
  private async discardSidecars(): Promise<void> {
    for (const dir of ["snapshots", "results"]) {
      try {
        await this.control.removeTree?.(`${this.root}/${dir}`);
      } catch {
        // Best-effort: residual sidecars are inert after a terminal state.
      }
    }
  }
  private async load(): Promise<PullJournal> {
    const value = await this.journal.read();
    if (!value) throw new Error("拉取日志缺失或已损坏");
    return value.payload;
  }
  async inspect(): Promise<{
    state: PullJournal["state"];
    transactionId: string;
  } | null> {
    const value = await this.journal.read();
    return value
      ? {
          state: value.payload.state,
          transactionId: value.payload.transactionId,
        }
      : null;
  }
  async replaceForRecoveryTest(
    update: (journal: PullJournal) => void,
  ): Promise<void> {
    const journal = await this.load();
    update(journal);
    await this.save(journal);
  }

  async prepare(
    actions: PullAction[],
    scanEpoch: number,
    transactionId: string = crypto.randomUUID(),
    expectedHashes: Record<string, string | null> = {},
  ): Promise<void> {
    const paths = new Set<string>();
    for (const action of actions) {
      paths.add(action.path);
      if (action.kind === "rename") paths.add(action.fromPath);
    }
    const snapshots: SnapshotEntry[] = [];
    for (const [index, path] of [...paths].entries()) {
      const bytes = await this.vault.read(path);
      const hash = bytes ? await sha256Hex(bytes) : null;
      if (Object.hasOwn(expectedHashes, path) && expectedHashes[path] !== hash)
        throw new Error("预览后库已变更");
      const snapshotPath = bytes ? `${this.root}/snapshots/${index}.bin` : null;
      if (bytes && snapshotPath)
        await this.control.write(snapshotPath, encodeBase64(bytes));
      snapshots.push({
        path,
        snapshotPath,
        hash,
      });
    }
    const journalActions: JournalAction[] = [];
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index]!;
      if (action.kind === "trash") {
        journalActions.push(action);
        continue;
      }
      const resultPath = `${this.root}/results/${index}.md`;
      const body =
        action.body ??
        (action.bodyPath ? await this.control.read(action.bodyPath) : null);
      if (body === null) throw new Error("拉取操作内容缺失");
      const resultHash = await sha256Hex(encoder.encode(body));
      await this.control.write(resultPath, body);
      journalActions.push(
        action.kind === "rename"
          ? {
              kind: "rename",
              fromPath: action.fromPath,
              path: action.path,
              resultPath,
              resultHash,
            }
          : { kind: action.kind, path: action.path, resultPath, resultHash },
      );
    }
    const journal: PullJournal = {
      schemaVersion: 1,
      transactionId,
      state: "prepared",
      scanEpoch,
      actions: journalActions,
      snapshots,
      temporaryPaths: [],
      materialized: [],
    };
    await this.save(journal);
  }

  async apply(scanEpoch: number): Promise<void> {
    const journal = await this.load();
    if (journal.scanEpoch !== scanEpoch) throw new Error("扫描纪元已变更");
    for (const snapshot of journal.snapshots) {
      const current = await this.vault.read(snapshot.path);
      const hash = current ? await sha256Hex(current) : null;
      if (hash !== snapshot.hash) throw new Error("预览后库已变更");
    }
    journal.state = "applying";
    await this.save(journal);
    try {
      for (let index = 0; index < journal.actions.length; index += 1) {
        const action = journal.actions[index]!;
        if (action.kind === "rename") {
          const temporary = `${action.fromPath}.agentwiki-tmp-${index}`;
          const expectedHash =
            journal.snapshots.find((item) => item.path === action.fromPath)
              ?.hash ?? null;
          journal.temporaryPaths.push({
            original: action.fromPath,
            temporary,
            expectedHash,
          });
          await this.save(journal);
          await this.vault.rename(action.fromPath, temporary);
        }
      }
      for (let index = 0; index < journal.actions.length; index += 1) {
        const action = journal.actions[index]!;
        if (action.kind === "trash") {
          const expected = journal.snapshots.find(
            (item) => item.path === action.path,
          );
          const current = await this.vault.read(action.path);
          const currentHash = current ? await sha256Hex(current) : null;
          if (currentHash !== (expected?.hash ?? null))
            throw new Error("删除前库已变更");
          await this.vault.trashFile(action.path);
        } else {
          const result = await this.control.read(action.resultPath);
          if (
            result === null ||
            (await sha256Hex(encoder.encode(result))) !== action.resultHash
          )
            throw new Error("拉取结果边车已损坏");
          const body = encoder.encode(result);
          const snapshot = journal.snapshots.find(
            (item) => item.path === action.path,
          );
          const expected =
            action.kind === "rename" ||
            snapshot?.snapshotPath === null ||
            !snapshot
              ? null
              : await this.snapshotBytes(snapshot);
          const resultHash = action.resultHash;
          journal.materialized.push({
            path: action.path,
            resultHash,
            expectedHash:
              action.kind === "rename" ? null : (snapshot?.hash ?? null),
          });
          await this.save(journal);
          await this.vault.ensureParentDirectories(action.path);
          if (!(await this.vault.compareAndSwap(action.path, expected, body)))
            throw new Error("条件写入前库已变更");
        }
      }
      for (const temporary of journal.temporaryPaths)
        if (await this.vault.read(temporary.temporary))
          await this.vault.remove(temporary.temporary);
      journal.state = "committed";
      await this.save(journal);
      await this.discardSidecars();
    } catch (error) {
      journal.state = "rolling_back";
      await this.save(journal);
      await this.rollback(journal);
      throw error;
    }
  }

  async recover(): Promise<void> {
    const journal = await this.load();
    if (journal.state === "committed" || journal.state === "rolled_back")
      return;
    if (await this.isFullyMaterialized(journal)) {
      journal.state = "committed";
      await this.save(journal);
      await this.discardSidecars();
      return;
    }
    await this.rollback(journal);
  }

  private async isFullyMaterialized(journal: PullJournal): Promise<boolean> {
    if (
      journal.materialized.length !==
      journal.actions.filter((action) => action.kind !== "trash").length
    )
      return false;
    for (const item of journal.materialized) {
      const current = await this.vault.read(item.path);
      if (!current || (await sha256Hex(current)) !== item.resultHash)
        return false;
    }
    const finalTargets = new Set(
      journal.actions
        .filter((action) => action.kind !== "trash")
        .map((action) => action.path),
    );
    for (const action of journal.actions) {
      if (
        action.kind === "trash" &&
        (await this.vault.read(action.path)) !== null
      )
        return false;
      if (
        action.kind === "rename" &&
        !finalTargets.has(action.fromPath) &&
        (await this.vault.read(action.fromPath)) !== null
      )
        return false;
    }
    for (const temporary of journal.temporaryPaths)
      if ((await this.vault.read(temporary.temporary)) !== null) return false;
    return true;
  }

  private async rollback(journal: PullJournal): Promise<void> {
    try {
      for (const materialized of [...journal.materialized].reverse()) {
        const current = await this.vault.read(materialized.path);
        const currentHash = current ? await sha256Hex(current) : null;
        if (currentHash === materialized.expectedHash) continue;
        if (currentHash !== materialized.resultHash)
          throw new Error("用户编辑了已应用的结果");
        if (current) await this.vault.remove(materialized.path);
      }
      for (const temporary of [...journal.temporaryPaths].reverse()) {
        const bytes = await this.vault.read(temporary.temporary);
        if (bytes) {
          const current = await this.vault.read(temporary.original);
          if (current) throw new Error("用户在重命名源处创建了文件");
          await this.vault.rename(temporary.temporary, temporary.original);
        } else {
          const original = await this.vault.read(temporary.original);
          const hash = original ? await sha256Hex(original) : null;
          if (hash !== temporary.expectedHash)
            throw new Error("重命名恢复不明确");
        }
      }
      const materializedPaths = new Set(
        journal.materialized.map((item) => item.path),
      );
      for (const snapshot of journal.snapshots) {
        const current = await this.vault.read(snapshot.path);
        if (snapshot.snapshotPath === null) {
          if (current && !materializedPaths.has(snapshot.path))
            throw new Error("原本为空的事务路径出现了文件");
        } else if (!current)
          await this.vault.write(
            snapshot.path,
            await this.snapshotBytes(snapshot),
          );
        else if ((await sha256Hex(current)) !== snapshot.hash)
          throw new Error("事务停止后回滚目标被编辑");
      }
      for (const snapshot of journal.snapshots) {
        const current = await this.vault.read(snapshot.path);
        const hash = current ? await sha256Hex(current) : null;
        if (hash !== snapshot.hash) throw new Error("回滚快照验证失败");
      }
      journal.state = "rolled_back";
      journal.materialized = [];
      journal.temporaryPaths = [];
      await this.save(journal);
      await this.discardSidecars();
    } catch {
      journal.state = "failed";
      await this.save(journal);
      throw new Error("拉取恢复失败");
    }
  }
  private async snapshotBytes(snapshot: SnapshotEntry): Promise<Uint8Array> {
    if (!snapshot.snapshotPath) throw new Error("快照边车引用缺失");
    const raw = await this.control.read(snapshot.snapshotPath);
    if (raw === null) throw new Error("拉取快照边车缺失");
    const bytes = decodeBase64(raw);
    if ((await sha256Hex(bytes)) !== snapshot.hash)
      throw new Error("拉取快照边车已损坏");
    return bytes;
  }
}
