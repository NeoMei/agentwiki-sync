import { pathKey } from "@neomei/agentwiki-sync-protocol";

import { sha256Hex } from "../agentwiki/protocol";
import type {
  AttachmentPullAction,
  TreePullAction,
  TreePullActionV3,
} from "../core/merge";
import type { ControlStorePort } from "../ports/control-store";
import type { VaultPort } from "../ports/vault";
import { MutableControlRepository } from "../storage/envelope";

const encoder = new TextEncoder();

type PathKind = "directory" | "file" | "missing";

export interface TreeTransactionPathState {
  kind: PathKind;
  hash: string | null;
}

interface OperationPath {
  path: string;
  before: TreeTransactionPathState;
  after: TreeTransactionPathState;
}

interface DirectoryClosure {
  roots: string[];
  initial: Record<string, Exclude<PathKind, "missing">>;
}

interface JournalOperation {
  action: TreePullActionV3;
  paths: OperationPath[];
  directoryClosure?: DirectoryClosure;
}

export interface TreeTransactionJournal {
  schemaVersion: 2 | 3;
  transactionId: string;
  baseRevision: string;
  targetRevision: string;
  targetTreeHash: string;
  state:
    | "prepared"
    | "applying"
    | "applied"
    | "verified"
    | "committed"
    | "rolling_back"
    | "rolled_back"
    | "ambiguous";
  nextOperation: number;
  operations: JournalOperation[];
  deferCommit?: boolean;
}

export interface TreeTransactionInput {
  baseRevision: string;
  targetRevision: string;
  targetTreeHash: string;
  actions: TreePullActionV3[];
  /** Keep sidecars and the applied state until generation/identity commit. */
  deferCommit?: boolean;
  /** Exact raw Vault states captured by the confirmed preview scan. */
  expectedPathStates?: Record<string, TreeTransactionPathState>;
}

function isPathState(value: unknown): value is TreeTransactionPathState {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TreeTransactionPathState>;
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

function isDirectoryClosure(value: unknown): value is DirectoryClosure {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DirectoryClosure>;
  return (
    Array.isArray(item.roots) &&
    item.roots.every((root): root is string => typeof root === "string") &&
    !!item.initial &&
    typeof item.initial === "object" &&
    Object.values(item.initial).every(
      (kind) => kind === "directory" || kind === "file",
    )
  );
}

function isJournalOperation(value: unknown): value is JournalOperation {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<JournalOperation>;
  const action = item.action as Partial<TreePullActionV3> | undefined;
  return (
    typeof action?.kind === "string" &&
    Array.isArray(item.paths) &&
    item.paths.every(isOperationPath) &&
    (item.directoryClosure === undefined ||
      isDirectoryClosure(item.directoryClosure))
  );
}

export function isTreeTransactionJournal(
  value: unknown,
): value is TreeTransactionJournal {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TreeTransactionJournal>;
  if (item.schemaVersion !== 2 && item.schemaVersion !== 3) return false;
  return (
    typeof item.transactionId === "string" &&
    typeof item.baseRevision === "string" &&
    typeof item.targetRevision === "string" &&
    typeof item.targetTreeHash === "string" &&
    [
      "prepared",
      "applying",
      "applied",
      "verified",
      "committed",
      "rolling_back",
      "rolled_back",
      "ambiguous",
    ].includes(item.state ?? "") &&
    Number.isSafeInteger(item.nextOperation) &&
    (item.nextOperation ?? -1) >= 0 &&
    Array.isArray(item.operations) &&
    item.operations.every(isJournalOperation) &&
    (item.deferCommit === undefined || typeof item.deferCommit === "boolean")
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

function sameState(
  left: TreeTransactionPathState,
  right: TreeTransactionPathState,
): boolean {
  return left.kind === right.kind && left.hash === right.hash;
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function isPageUpsert(
  action: TreePullActionV3,
): action is Extract<
  TreePullActionV3,
  { kind: "create_page" | "write_page" | "move_page" }
> {
  return (
    action.kind === "create_page" ||
    action.kind === "write_page" ||
    action.kind === "move_page"
  );
}

function isAttachmentFileAction(
  action: TreePullActionV3,
): action is Extract<
  TreePullActionV3,
  { kind: "create_attachment" | "write_attachment" | "remove_attachment_path" }
> {
  return (
    action.kind === "create_attachment" ||
    action.kind === "write_attachment" ||
    action.kind === "remove_attachment_path"
  );
}

function beforeSourcePath(
  action: TreePullActionV3,
  journalPath: string,
): string {
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
    private readonly readAttachmentSource?: (
      action: Extract<
        AttachmentPullAction,
        { kind: "create_attachment" | "write_attachment" }
      >,
    ) => Promise<Uint8Array | null>,
  ) {
    this.journal = new MutableControlRepository(
      control,
      `${root}/journal.json`,
      isTreeTransactionJournal,
    );
  }

  async inspect(): Promise<{
    schemaVersion: TreeTransactionJournal["schemaVersion"];
    state: TreeTransactionJournal["state"];
    transactionId: string;
    baseRevision: string;
    targetRevision: string;
    deferCommit: boolean;
  } | null> {
    const value = await this.journal.read();
    return value
      ? {
          schemaVersion: value.payload.schemaVersion,
          state: value.payload.state,
          transactionId: value.payload.transactionId,
          baseRevision: value.payload.baseRevision,
          targetRevision: value.payload.targetRevision,
          deferCommit: value.payload.deferCommit === true,
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

    if (input.expectedPathStates) {
      for (const [path, expected] of Object.entries(input.expectedPathStates))
        if (!sameState(await this.readPathState(path), expected))
          throw new Error("STALE_PULL_PREVIEW");
    }

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
        case "create_attachment":
        case "write_attachment":
        case "remove_attachment_path":
        case "detach_attachment":
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
          input.expectedPathStates,
        ),
      );
    }
    await this.journal.write({
      schemaVersion: 3,
      transactionId,
      baseRevision: input.baseRevision,
      targetRevision: input.targetRevision,
      targetTreeHash: input.targetTreeHash,
      state: "prepared",
      nextOperation: 0,
      operations,
      deferCommit: input.deferCommit ?? false,
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
          if (
            !(await this.directoryClosureMatches(
              operation,
              journal.operations,
              index,
            ))
          ) {
            journal.state = "ambiguous";
            await this.save(journal);
            throw new Error(
              "TREE_TRANSACTION_AMBIGUOUS: 目录子树出现未记录的变更",
            );
          }
          await this.executeOperation(index, operation);
        } else if (
          state !== "after" ||
          !(await this.directoryClosureMatches(
            operation,
            journal.operations,
            index + 1,
          ))
        ) {
          journal.state = "ambiguous";
          await this.save(journal);
          throw new Error("TREE_TRANSACTION_AMBIGUOUS: 事务前后状态不明确");
        }
        journal.nextOperation = index + 1;
        await this.save(journal);
      }
      if (journal.deferCommit) {
        journal.state = "applied";
        await this.save(journal);
      } else {
        journal.state = "committed";
        await this.save(journal);
        await this.discardSidecars();
      }
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
    if (journal.state === "verified") return;
    if (journal.state === "ambiguous")
      throw new Error(
        "TREE_TRANSACTION_AMBIGUOUS: 事务状态不明确，请按恢复指引处理",
      );
    if (journal.state === "applied") {
      await this.rollback(journal);
      return;
    }
    if (await this.isFullyApplied(journal)) {
      if (!journal.deferCommit) {
        journal.state = "committed";
        await this.save(journal);
        await this.discardSidecars();
        return;
      }
      // A deferred v3 transaction is not authoritative until the caller has
      // durably recorded full Vault verification. A crash before that record
      // therefore rolls back in this recovery call instead of exposing an
      // intermediate `applied` state that would require a second restart.
      await this.rollback(journal);
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

  private attachmentResultPath(operationIndex: number): string {
    return `${this.root}/results/${operationIndex}.bin`;
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

  async assertApplied(): Promise<void> {
    const journal = await this.load();
    if (
      journal.state !== "applied" &&
      journal.state !== "verified" &&
      journal.state !== "committed"
    )
      throw new Error("TREE_TRANSACTION_NOT_APPLIED");
    if (!(await this.isFullyApplied(journal))) {
      journal.state = "ambiguous";
      await this.save(journal);
      throw new Error("TREE_TRANSACTION_AMBIGUOUS: 事务结果已被修改");
    }
  }

  async markVerified(): Promise<void> {
    const journal = await this.load();
    if (journal.state === "verified" || journal.state === "committed") return;
    await this.assertApplied();
    journal.state = "verified";
    await this.save(journal);
  }

  async markCommitted(): Promise<void> {
    const journal = await this.load();
    if (journal.state === "committed") return;
    await this.assertApplied();
    journal.state = "committed";
    await this.save(journal);
    await this.discardSidecars();
  }

  async rollbackVerified(): Promise<void> {
    const journal = await this.load();
    if (journal.state !== "verified")
      throw new Error("TREE_TRANSACTION_NOT_VERIFIED");
    await this.rollback(journal);
  }

  private async readPathState(path: string): Promise<TreeTransactionPathState> {
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
    action: TreePullActionV3,
    ownedRoots: string[],
    expectedPathStates?: Record<string, TreeTransactionPathState>,
  ): Promise<JournalOperation> {
    const directoryClosure = await this.captureDirectoryClosure(action);
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
      case "create_attachment":
      case "write_attachment":
        paths = [
          {
            path: action.attachment.path,
            before: await this.readPathState(action.attachment.path),
            after: { kind: "file", hash: action.attachment.contentHash },
          },
        ];
        break;
      case "remove_attachment_path":
        paths = [
          {
            path: action.path,
            before: await this.readPathState(action.path),
            after: { kind: "missing", hash: null },
          },
        ];
        break;
      case "detach_attachment":
        paths = [];
        break;
    }

    if (expectedPathStates) {
      for (const item of paths) {
        const sourcePath = beforeSourcePath(action, item.path);
        const expected = expectedPathStates[sourcePath];
        if (!expected) throw new Error("STALE_PULL_PREVIEW");
        item.before = expected;
        if (!sameState(await this.readPathState(sourcePath), expected))
          throw new Error("STALE_PULL_PREVIEW");
      }
    }

    for (let pathIndex = 0; pathIndex < paths.length; pathIndex += 1) {
      const item = paths[pathIndex]!;
      if (item.before.kind === "file") {
        const bytes = await this.fileBytes(beforeSourcePath(action, item.path));
        if ((await sha256Hex(bytes)) !== item.before.hash)
          throw new Error("前置快照读取失败");
        if (isAttachmentFileAction(action)) {
          if (!this.control.writeBinary || !this.control.readBinary)
            throw new Error("ATTACHMENT_SOURCE_UNAVAILABLE");
          await this.control.writeBinary(
            this.beforePath(index, pathIndex),
            bytes,
          );
          const durable = await this.control.readBinary(
            this.beforePath(index, pathIndex),
          );
          if (!durable || (await sha256Hex(durable)) !== item.before.hash)
            throw new Error("回滚前置快照已损坏");
        } else {
          await this.control.write(
            this.beforePath(index, pathIndex),
            encodeBase64(bytes),
          );
        }
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

    if (
      action.kind === "create_attachment" ||
      action.kind === "write_attachment"
    ) {
      if (!this.readAttachmentSource || !this.control.writeBinary)
        throw new Error("ATTACHMENT_SOURCE_UNAVAILABLE");
      const bytes = await this.readAttachmentSource(action);
      if (
        !bytes ||
        bytes.byteLength !== Number(action.attachment.sizeBytes) ||
        (await sha256Hex(bytes)) !== action.attachment.contentHash
      )
        throw new Error("ATTACHMENT_SOURCE_MISMATCH");
      await this.control.writeBinary(this.attachmentResultPath(index), bytes);
      const durable = await this.control.readBinary?.(
        this.attachmentResultPath(index),
      );
      if (
        !durable ||
        (await sha256Hex(durable)) !== action.attachment.contentHash
      )
        throw new Error("ATTACHMENT_SOURCE_MISMATCH");
    }

    return {
      action,
      paths,
      ...(directoryClosure ? { directoryClosure } : {}),
    };
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

  private async captureDirectoryClosure(
    action: TreePullActionV3,
  ): Promise<DirectoryClosure | undefined> {
    if (
      action.kind !== "create_directory" &&
      action.kind !== "trash_directory" &&
      action.kind !== "move_directory"
    )
      return undefined;
    const roots =
      action.kind === "move_directory"
        ? [action.fromPath, action.path]
        : [action.path];
    const initial: DirectoryClosure["initial"] = {};
    const capture = async (actualRoot: string, logicalRoot: string) => {
      const rootKind = await this.vault.pathStatus(actualRoot);
      if (rootKind === "missing") return;
      initial[logicalRoot] = rootKind;
      if (rootKind !== "directory") return;
      for await (const entry of this.vault.listTree(actualRoot))
        initial[`${logicalRoot}/${entry.relativePath}`] =
          entry.kind === "directory" ? "directory" : "file";
    };
    if (action.kind === "move_directory") {
      await capture(action.beforePath ?? action.fromPath, action.fromPath);
      await capture(action.path, action.path);
    } else await capture(action.path, action.path);
    return { roots, initial };
  }

  private applyDirectoryStateAction(
    state: Map<string, Exclude<PathKind, "missing">>,
    action: TreePullActionV3,
  ): void {
    const remove = (path: string) => {
      for (const candidate of [...state.keys()])
        if (isInsideSubtree(candidate, path)) state.delete(candidate);
    };
    const move = (fromPath: string, toPath: string) => {
      const moved = [...state].filter(([path]) =>
        isInsideSubtree(path, fromPath),
      );
      remove(fromPath);
      for (const [path, kind] of moved)
        state.set(`${toPath}${path.slice(fromPath.length)}`, kind);
    };
    switch (action.kind) {
      case "create_directory":
        state.set(action.path, "directory");
        break;
      case "trash_directory":
        remove(action.path);
        break;
      case "move_directory":
        move(action.fromPath, action.path);
        break;
      case "create_page":
        state.set(action.path, "file");
        break;
      case "write_page":
        state.set(action.path, "file");
        break;
      case "move_page":
        move(action.fromPath, action.path);
        break;
      case "trash_page":
        remove(action.path);
        break;
      case "create_attachment":
      case "write_attachment":
        state.set(action.attachment.path, "file");
        break;
      case "remove_attachment_path":
        remove(action.path);
        break;
      case "detach_attachment":
        break;
    }
  }

  private legacyDirectoryClosure(
    operation: JournalOperation,
  ): DirectoryClosure {
    const roots =
      operation.action.kind === "move_directory"
        ? [operation.action.fromPath, operation.action.path]
        : operation.action.kind === "trash_directory" ||
            operation.action.kind === "create_directory"
          ? [operation.action.path]
          : [];
    const initial: DirectoryClosure["initial"] = {};
    for (const item of operation.paths)
      if (item.before.kind !== "missing") initial[item.path] = item.before.kind;
    return { roots, initial };
  }

  private async directoryClosureMatches(
    operation: JournalOperation,
    allOperations: JournalOperation[],
    appliedCount: number,
    transactionWide = false,
  ): Promise<boolean> {
    const closure =
      operation.directoryClosure ?? this.legacyDirectoryClosure(operation);
    const expectedState = new Map<string, Exclude<PathKind, "missing">>();
    const seeds = transactionWide
      ? allOperations.flatMap((candidate) => [
          candidate.directoryClosure ?? this.legacyDirectoryClosure(candidate),
        ])
      : [closure];
    for (const seed of seeds)
      for (const [path, kind] of Object.entries(seed.initial))
        expectedState.set(path, kind);
    for (let index = 0; index < appliedCount; index += 1)
      this.applyDirectoryStateAction(
        expectedState,
        allOperations[index]!.action,
      );
    for (const root of closure.roots) {
      const expected = new Map<string, PathKind>();
      for (const [path, kind] of expectedState)
        if (path !== root && isInsideSubtree(path, root))
          expected.set(pathKey(path), kind);
      const actual = new Map<string, PathKind>();
      if ((await this.vault.pathStatus(root)) === "directory")
        for await (const entry of this.vault.listTree(root))
          actual.set(
            pathKey(`${root}/${entry.relativePath}`),
            entry.kind === "directory" ? "directory" : "file",
          );
      if (
        actual.size !== expected.size ||
        [...actual].some(([path, kind]) => expected.get(path) !== kind)
      )
        return false;
    }
    return true;
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
      case "create_attachment":
      case "write_attachment": {
        const bytes = await this.control.readBinary?.(
          this.attachmentResultPath(index),
        );
        if (
          !bytes ||
          (await sha256Hex(bytes)) !== action.attachment.contentHash
        )
          throw new Error("ATTACHMENT_SOURCE_MISMATCH");
        await this.vault.ensureParentDirectories(action.attachment.path);
        await this.vault.write(action.attachment.path, bytes);
        break;
      }
      case "remove_attachment_path":
        await this.vault.trashFile(action.path);
        break;
      case "detach_attachment":
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
      if (
        (await this.classifyOperation(operation)) !== "after" ||
        !(await this.directoryClosureMatches(
          operation,
          journal.operations,
          journal.operations.length,
          true,
        ))
      )
        return false;
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
          if (
            !(await this.directoryClosureMatches(
              operation,
              journal.operations,
              index + 1,
            ))
          ) {
            journal.state = "ambiguous";
            await this.save(journal);
            throw new Error(
              "TREE_TRANSACTION_AMBIGUOUS: 回滚时目录子树出现未记录的变更",
            );
          }
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
        if (
          operation.action.kind === "create_directory" &&
          item.after.kind === "directory" &&
          !(await this.directoryClosureMatches(
            operation,
            journal.operations,
            index + 1,
          ))
        ) {
          journal.state = "ambiguous";
          await this.save(journal);
          throw new Error(
            "TREE_TRANSACTION_AMBIGUOUS: 回滚时目录子树出现未记录的变更",
          );
        }
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
    const binary = isAttachmentFileAction(operation.action)
      ? await this.control.readBinary?.(this.beforePath(index, pathIndex))
      : null;
    const raw = binary
      ? null
      : await this.control.read(this.beforePath(index, pathIndex));
    if (!binary && raw === null) throw new Error("回滚前置快照缺失");
    const bytes = binary ?? decodeBase64(raw!);
    if ((await sha256Hex(bytes)) !== operation.paths[pathIndex]?.before.hash)
      throw new Error("回滚前置快照已损坏");
    return bytes;
  }
}
