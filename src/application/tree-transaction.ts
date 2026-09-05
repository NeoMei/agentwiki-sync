import { pathKey } from "@neomei/agentwiki-sync-protocol";

import { sha256Hex } from "../agentwiki/protocol";
import type { TreePullAction } from "../core/merge";
import type { ControlStorePort } from "../ports/control-store";
import type { VaultPort } from "../ports/vault";
import { MutableControlRepository } from "../storage/envelope";

const encoder = new TextEncoder();

type PathKind = "directory" | "file" | "missing";

interface PathState {
  kind: PathKind;
  hash: string | null;
}

interface OperationPath {
  path: string;
  before: PathState;
  after: PathState;
}

interface JournalOperation {
  action: TreePullAction;
  paths: OperationPath[];
}

export interface TreeTransactionJournal {
  schemaVersion: 2;
  transactionId: string;
  baseRevision: string;
  targetRevision: string;
  targetTreeHash: string;
  state:
    | "prepared"
    | "applying"
    | "committed"
    | "rolling_back"
    | "rolled_back"
    | "ambiguous";
  nextOperation: number;
  operations: JournalOperation[];
}

export interface TreeTransactionInput {
  baseRevision: string;
  targetRevision: string;
  targetTreeHash: string;
  actions: TreePullAction[];
}

function isPathState(value: unknown): value is PathState {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PathState>;
  return (
    (item.kind === "directory" ||
      item.kind === "file" ||
      item.kind === "missing") &&
    (item.hash === null || typeof item.hash === "string")
  );
}

function isOperationPath(value: unknown): value is OperationPath {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<OperationPath>;
  return (
    typeof item.path === "string" &&
    isPathState(item.before) &&
    isPathState(item.after)
  );
}

function isJournalOperation(value: unknown): value is JournalOperation {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<JournalOperation>;
  const action = item.action as Partial<TreePullAction> | undefined;
  return (
    typeof action?.kind === "string" &&
    Array.isArray(item.paths) &&
    item.paths.every(isOperationPath)
  );
}

function isTreeTransactionJournal(
  value: unknown,
): value is TreeTransactionJournal {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TreeTransactionJournal>;
  if (item.schemaVersion !== 2) return false;
  return (
    typeof item.transactionId === "string" &&
    typeof item.baseRevision === "string" &&
    typeof item.targetRevision === "string" &&
    typeof item.targetTreeHash === "string" &&
    [
      "prepared",
      "applying",
      "committed",
      "rolling_back",
      "rolled_back",
      "ambiguous",
    ].includes(item.state ?? "") &&
    Number.isSafeInteger(item.nextOperation) &&
    (item.nextOperation ?? -1) >= 0 &&
    Array.isArray(item.operations) &&
    item.operations.every(isJournalOperation)
  );
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return window.btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sameState(left: PathState, right: PathState): boolean {
  return left.kind === right.kind && left.hash === right.hash;
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function isPageUpsert(
  action: TreePullAction,
): action is Extract<
  TreePullAction,
  { kind: "create_page" | "write_page" | "move_page" }
> {
  return (
    action.kind === "create_page" ||
    action.kind === "write_page" ||
    action.kind === "move_page"
  );
}

function beforeSourcePath(action: TreePullAction, journalPath: string): string {
  if (
    action.kind === "move_page" &&
    action.beforePath &&
    journalPath === action.fromPath
  )
    return action.beforePath;
  if (
    action.kind === "write_page" &&
    action.beforePath &&
    journalPath === action.path
  )
    return action.beforePath;
  return journalPath;
}

function isInsideSubtree(path: string, root: string): boolean {
  const key = pathKey(path);
  const rootKey = pathKey(root);
  return key === rootKey || key.startsWith(`${rootKey}/`);
}

export class TreeTransaction {
  private readonly journal: MutableControlRepository<TreeTransactionJournal>;

  constructor(
    private readonly vault: VaultPort,
    private readonly control: ControlStorePort,
    private readonly root: string,
  ) {
    this.journal = new MutableControlRepository(
      control,
      `${root}/journal.json`,
      isTreeTransactionJournal,
    );
  }

  async inspect(): Promise<{
    state: TreeTransactionJournal["state"];
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

  async prepare(
    input: TreeTransactionInput,
    transactionId: string = crypto.randomUUID(),
  ): Promise<void> {
    const existing = await this.journal.read();
    if (
      existing &&
      existing.payload.state !== "committed" &&
      existing.payload.state !== "rolled_back"
    )
      throw new Error("存在未终结的事务，请先执行恢复（recover）");

    const ownedRoots = input.actions.flatMap((action) => {
      switch (action.kind) {
        case "trash_page":
        case "trash_directory":
          return [action.path];
        case "move_page":
        case "move_directory":
          return [action.beforePath ?? action.fromPath];
        case "create_page":
        case "write_page":
        case "create_directory":
          return [];
      }
    });

    const operations: JournalOperation[] = [];
    for (let index = 0; index < input.actions.length; index += 1) {
      operations.push(
        await this.materializeOperation(
          index,
          input.actions[index]!,
          ownedRoots,
        ),
      );
    }
    await this.journal.write({
      schemaVersion: 2,
      transactionId,
      baseRevision: input.baseRevision,
      targetRevision: input.targetRevision,
      targetTreeHash: input.targetTreeHash,
      state: "prepared",
      nextOperation: 0,
      operations,
    });
  }

  async apply(): Promise<void> {
    const journal = await this.load();
    if (journal.state === "committed" || journal.state === "rolled_back")
      return;
    journal.state = "applying";
    await this.save(journal);
    try {
      for (
        let index = journal.nextOperation;
        index < journal.operations.length;
        index += 1
      ) {
        const operation = journal.operations[index]!;
        const state = await this.classifyOperation(operation);
        if (state === "before") {
          await this.executeOperation(index, operation);
        } else if (state !== "after") {
          journal.state = "ambiguous";
          await this.save(journal);
          throw new Error("TREE_TRANSACTION_AMBIGUOUS: 事务前后状态不明确");
        }
        journal.nextOperation = index + 1;
        await this.save(journal);
      }
      journal.state = "committed";
      await this.save(journal);
      await this.discardSidecars();
    } catch (error) {
      if (journal.state === "ambiguous") throw error;
      journal.state = "rolling_back";
      await this.save(journal);
      throw error;
    }
  }

  async recover(): Promise<void> {
    const journal = await this.load();
    if (journal.state === "committed" || journal.state === "rolled_back")
      return;
    if (journal.state === "ambiguous")
      throw new Error(
        "TREE_TRANSACTION_AMBIGUOUS: 事务状态不明确，请按恢复指引处理",
      );
    if (await this.isFullyApplied(journal)) {
      journal.state = "committed";
      await this.save(journal);
      await this.discardSidecars();
      return;
    }
    await this.rollback(journal);
  }

  private async load(): Promise<TreeTransactionJournal> {
    const value = await this.journal.read();
    if (!value) throw new Error("拉取日志缺失或已损坏");
    return value.payload;
  }

  private async save(journal: TreeTransactionJournal): Promise<void> {
    await this.journal.write(journal);
  }

  private beforePath(operationIndex: number, pathIndex: number): string {
    return `${this.root}/before/${operationIndex}-${pathIndex}.bin`;
  }

  private resultPath(operationIndex: number): string {
    return `${this.root}/results/${operationIndex}.md`;
  }

  private async discardSidecars(): Promise<void> {
    for (const dir of ["before", "results"]) {
      try {
        await this.control.removeTree?.(`${this.root}/${dir}`);
      } catch {
        // Best-effort: residual sidecars are inert after a terminal state.
      }
    }
  }

  private async readPathState(path: string): Promise<PathState> {
    const kind = await this.vault.pathStatus(path);
    if (kind === "directory") return { kind: "directory", hash: null };
    if (kind === "file") {
      const bytes = await this.vault.read(path);
      return { kind: "file", hash: bytes ? await sha256Hex(bytes) : null };
    }
    return { kind: "missing", hash: null };
  }

  private async fileBytes(path: string): Promise<Uint8Array> {
    const bytes = await this.vault.read(path);
    if (!bytes) throw new Error("文件快照读取失败");
    return bytes;
  }

  private async materializeOperation(
    index: number,
    action: TreePullAction,
    ownedRoots: string[],
  ): Promise<JournalOperation> {
    let paths: OperationPath[];
    switch (action.kind) {
      case "create_directory":
        paths = [
          {
            path: action.path,
            before: { kind: "missing", hash: null },
            after: { kind: "directory", hash: null },
          },
        ];
        break;
      case "trash_directory":
        paths = await this.directoryTrashPaths(action.path, ownedRoots);
        break;
      case "move_directory":
        paths = await this.directoryMovePaths(
          action.fromPath,
          action.path,
          ownedRoots,
        );
        break;
      case "create_page":
        paths = [
          {
            path: action.path,
            before: { kind: "missing", hash: null },
            after: { kind: "file", hash: await this.resultHash(action) },
          },
        ];
        break;
      case "write_page":
        paths = [
          {
            path: action.path,
            before: await this.readPathState(action.beforePath ?? action.path),
            after: { kind: "file", hash: await this.resultHash(action) },
          },
        ];
        break;
      case "move_page":
        paths = [
          {
            path: action.fromPath,
            before: await this.readPathState(
              action.beforePath ?? action.fromPath,
            ),
            after: { kind: "missing", hash: null },
          },
          {
            path: action.path,
            before: { kind: "missing", hash: null },
            after: { kind: "file", hash: await this.resultHash(action) },
          },
        ];
        break;
      case "trash_page":
        paths = [
          {
            path: action.path,
            before: await this.readPathState(action.path),
            after: { kind: "missing", hash: null },
          },
        ];
        break;
    }

    for (let pathIndex = 0; pathIndex < paths.length; pathIndex += 1) {
      const item = paths[pathIndex]!;
      if (item.before.kind === "file") {
        const bytes = await this.fileBytes(beforeSourcePath(action, item.path));
        if ((await sha256Hex(bytes)) !== item.before.hash)
          throw new Error("前置快照读取失败");
        await this.control.write(
          this.beforePath(index, pathIndex),
          encodeBase64(bytes),
        );
      }
    }

    if (isPageUpsert(action)) {
      const body = await this.control.read(action.bodyPath);
      if (body === null) throw new Error("拉取操作内容缺失");
      if (
        (await sha256Hex(encoder.encode(body))) !==
        (await this.resultHash(action))
      )
        throw new Error("拉取结果边车校验失败");
      await this.control.write(this.resultPath(index), body);
    }

    return { action, paths };
  }

  private async resultHash(
    action: Extract<
      TreePullAction,
      { kind: "create_page" | "write_page" | "move_page" }
    >,
  ): Promise<string> {
    const body = await this.control.read(action.bodyPath);
    if (body === null) throw new Error("拉取操作内容缺失");
    return sha256Hex(encoder.encode(body));
  }

  private async directoryMovePaths(
    fromPath: string,
    toPath: string,
    ownedRoots: string[],
  ): Promise<OperationPath[]> {
    const others = ownedRoots.filter(
      (root) => pathKey(root) !== pathKey(fromPath),
    );
    const paths: OperationPath[] = [
      {
        path: fromPath,
        before: { kind: "directory", hash: null },
        after: { kind: "missing", hash: null },
      },
      {
        path: toPath,
        before: { kind: "missing", hash: null },
        after: { kind: "directory", hash: null },
      },
    ];
    for await (const entry of this.vault.listTree(fromPath)) {
      const source = `${fromPath}/${entry.relativePath}`;
      if (others.some((root) => isInsideSubtree(source, root))) continue;
      const target = `${toPath}/${entry.relativePath}`;
      if (entry.kind === "directory") {
        paths.push({
          path: source,
          before: { kind: "directory", hash: null },
          after: { kind: "missing", hash: null },
        });
        paths.push({
          path: target,
          before: { kind: "missing", hash: null },
          after: { kind: "directory", hash: null },
        });
      } else {
        const bytes = entry.bytes ?? (await this.vault.read(source));
        if (bytes === null) throw new Error("目录中的文件在读取时消失");
        const hash = await sha256Hex(bytes);
        paths.push({
          path: source,
          before: { kind: "file", hash },
          after: { kind: "missing", hash: null },
        });
        paths.push({
          path: target,
          before: { kind: "missing", hash: null },
          after: { kind: "file", hash },
        });
      }
    }
    return paths;
  }

  private async directoryTrashPaths(
    path: string,
    ownedRoots: string[],
  ): Promise<OperationPath[]> {
    const others = ownedRoots.filter((root) => pathKey(root) !== pathKey(path));
    const paths: OperationPath[] = [
      {
        path,
        before: { kind: "directory", hash: null },
        after: { kind: "missing", hash: null },
      },
    ];
    for await (const entry of this.vault.listTree(path)) {
      const child = `${path}/${entry.relativePath}`;
      if (others.some((root) => isInsideSubtree(child, root))) continue;
      if (entry.kind === "directory") {
        paths.push({
          path: child,
          before: { kind: "directory", hash: null },
          after: { kind: "missing", hash: null },
        });
      } else {
        const bytes = entry.bytes ?? (await this.vault.read(child));
        if (bytes === null) throw new Error("目录中的文件在读取时消失");
        paths.push({
          path: child,
          before: {
            kind: "file",
            hash: await sha256Hex(bytes),
          },
          after: { kind: "missing", hash: null },
        });
      }
    }
    return paths;
  }

  private async classifyOperation(
    operation: JournalOperation,
  ): Promise<"before" | "after" | "other"> {
    let allBefore = true;
    let allAfter = true;
    for (const item of operation.paths) {
      const current = await this.readPathState(item.path);
      if (!sameState(current, item.before)) allBefore = false;
      if (!sameState(current, item.after)) allAfter = false;
      if (!allBefore && !allAfter) return "other";
    }
    if (allBefore) return "before";
    if (allAfter) return "after";
    return "other";
  }

  private async executeOperation(
    index: number,
    operation: JournalOperation,
  ): Promise<void> {
    const action = operation.action;
    switch (action.kind) {
      case "create_directory":
        await this.vault.createDirectory(action.path);
        break;
      case "move_directory":
        await this.vault.rename(action.fromPath, action.path);
        break;
      case "trash_directory":
        await this.vault.trashDirectory(action.path);
        break;
      case "create_page":
      case "write_page":
        await this.vault.write(action.path, await this.resultBody(index));
        break;
      case "move_page": {
        await this.vault.rename(action.fromPath, action.path);
        const after = operation.paths.find((item) => item.path === action.path);
        const current = await this.vault.read(action.path);
        const currentHash = current ? await sha256Hex(current) : null;
        if (after && currentHash !== after.after.hash) {
          await this.vault.write(action.path, await this.resultBody(index));
        }
        break;
      }
      case "trash_page":
        await this.vault.trashFile(action.path);
        break;
    }
  }

  private async resultBody(operationIndex: number): Promise<Uint8Array> {
    const raw = await this.control.read(this.resultPath(operationIndex));
    if (raw === null) throw new Error("拉取结果边车缺失");
    return encoder.encode(raw);
  }

  private async isFullyApplied(
    journal: TreeTransactionJournal,
  ): Promise<boolean> {
    for (const operation of journal.operations) {
      if ((await this.classifyOperation(operation)) !== "after") return false;
    }
    return true;
  }

  private async rollback(journal: TreeTransactionJournal): Promise<void> {
    const last = Math.min(journal.nextOperation, journal.operations.length - 1);
    for (let index = last; index >= 0; index -= 1) {
      const operation = journal.operations[index]!;
      if (operation.action.kind === "move_directory") {
        // A directory move is one atomic rename; classify and revert whole.
        const state = await this.classifyOperation(operation);
        if (state === "before") continue;
        if (state === "after") {
          await this.vault.rename(
            operation.action.path,
            operation.action.fromPath,
          );
          continue;
        }
        journal.state = "ambiguous";
        await this.save(journal);
        throw new Error("TREE_TRANSACTION_AMBIGUOUS: 回滚时发现未记录的变更");
      }
      await this.rollbackOperationPaths(index, operation, journal);
    }
    journal.state = "rolled_back";
    journal.nextOperation = 0;
    await this.save(journal);
    await this.discardSidecars();
  }

  /**
   * Reverts one operation path by path so an interruption can resume safely:
   * each path is reclassified independently (before = already restored,
   * after = restore now) instead of treating the whole operation as a unit.
   */
  private async rollbackOperationPaths(
    index: number,
    operation: JournalOperation,
    journal: TreeTransactionJournal,
  ): Promise<void> {
    for (const { item } of this.rollbackPathOrder(operation)) {
      const current = await this.readPathState(item.path);
      if (sameState(current, item.before)) continue;
      if (sameState(current, item.after)) {
        await this.revertPath(index, operation, item);
        continue;
      }
      journal.state = "ambiguous";
      await this.save(journal);
      throw new Error("TREE_TRANSACTION_AMBIGUOUS: 回滚时发现未记录的变更");
    }
  }

  private rollbackPathOrder(
    operation: JournalOperation,
  ): Array<{ pathIndex: number; item: OperationPath }> {
    const entries = operation.paths.map((item, pathIndex) => ({
      pathIndex,
      item,
    }));
    entries.sort((left, right) => {
      const leftDir = left.item.before.kind === "directory";
      const rightDir = right.item.before.kind === "directory";
      if (leftDir !== rightDir) return leftDir ? -1 : 1;
      if (leftDir)
        return pathDepth(left.item.path) - pathDepth(right.item.path);
      return left.pathIndex - right.pathIndex;
    });
    return entries;
  }

  private async revertPath(
    index: number,
    operation: JournalOperation,
    item: OperationPath,
  ): Promise<void> {
    const { before, after } = item;
    if (after.kind === "missing") {
      if (before.kind === "file")
        await this.vault.write(
          item.path,
          await this.beforeBytes(index, operation, item.path),
        );
      else if (before.kind === "directory")
        await this.vault.createDirectory(item.path);
      return;
    }
    if (after.kind === "file") {
      if (before.kind === "missing") await this.vault.trashFile(item.path);
      else if (before.kind === "file")
        await this.vault.write(
          item.path,
          await this.beforeBytes(index, operation, item.path),
        );
      return;
    }
    // after.kind === "directory" (a created directory)
    await this.vault.trashDirectory(item.path);
  }

  private async beforeBytes(
    index: number,
    operation: JournalOperation,
    path: string,
  ): Promise<Uint8Array> {
    const pathIndex = operation.paths.findIndex((item) => item.path === path);
    if (pathIndex < 0) throw new Error("回滚前置快照缺失");
    const raw = await this.control.read(this.beforePath(index, pathIndex));
    if (raw === null) throw new Error("回滚前置快照缺失");
    const bytes = decodeBase64(raw);
    if ((await sha256Hex(bytes)) !== operation.paths[pathIndex]?.before.hash)
      throw new Error("回滚前置快照已损坏");
    return bytes;
  }
}
