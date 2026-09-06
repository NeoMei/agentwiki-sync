# Local-first Image Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 纯文字 v2 Space 首次在 Obsidian 引用本地图片时，一次明确确认即可原子发布首个完整 v3 Revision，并可恢复地完成本地应用。

**Architecture:** 固定公开 v2 Snapshot，显式转换为仅用于计算的 v3 树，合并成最终候选后复用现有 v3 Push 引擎。独立升级日志只拥有跨协议阶段和子事务归属；Push journal 与 Vault transaction 分别拥有远端发布、本地写入事实。按 Space 模式路由，不以服务器支持 v3 推断所有 Space 已升级。

**Tech Stack:** TypeScript、Vitest、Zod、Obsidian Vault/FileManager、已发布 `@neomei/agentwiki-sync-protocol@0.5.1`。

**Spec:** `docs/superpowers/specs/2026-09-06-local-first-image-upgrade-design.md`；继承 `docs/superpowers/specs/2026-09-04-referenced-image-sync-v3-design.md`。

## Global Constraints

- 在 `/Users/neomei/项目/codexprojects/AgentWiki-Obsidian/.worktrees/referenced-image-sync-v3`、分支 `codex/referenced-image-sync-v3` 执行；不新建重复实现分支，不改用户主 Vault。
- 源码检查点 `6e4510e195b6ab042c719c06d10bb4b2ff9da3b8`；补充设计文档 `771d9f4`。Tasks 1–18 不重做，原 Task19 尚未完成；原作者暂停于 I1 模式路由之前。开工先核对 HEAD、dirty 状态及 `.superpowers/sdd/2026-09-04-referenced-image-sync-v3-implementation/progress.md`。
- 只同步 `pages/**/*.md` 引用且解析到 `assets/<single-file-name>` 的 PNG/JPEG/WebP/GIF。未引用图片不读字节、不上传；不得删除未引用文件或按同名冒认附件身份。
- 保留 10 MiB/Blob、1000 张/Revision、100 MiB/次、1 MiB/chunk、最多10块、单边10000px、4000万像素及默认并发2；服务器只能收紧。v2 读取、v3 发布分别验证各自 capabilities，共有资源取适用限制较严者。
- 继续使用 Human Device Credential；预览可以只读，viewer 不可确认升级。session/Finalize 必须保留服务器权限重查。
- 确认前只有只读请求与 scoped 私有预览暂存；session、Blob 上传、远端发布、业务文件写入、身份提交、基线切换均为零。
- 不修改 v1/v2 wire/hash，不伪造已发布的 v3 基线，不新增协议字段，不复制服务器内部服务。公开契约不足时停止该依赖链，在插件仓记录最小缺口，再交独立主项目任务。
- 主项目和生产只做本计划明确的公开契约验证；禁止顺便修改代码、数据库、部署。真实验证仅用已授权的隔离合成数据；凭据通过现有安全会话，不写文件、命令参数、日志或测试证据。
- Android 必须真实解锁后的 Obsidian 操作；锁屏、ADB 连通或桌面模拟不能标记通过。保留 ImageQA/ImageQA2/ImageRecoveryQA 故障现场，不手改日志修复。
- 本计划通过不等于实现或发布通过；所有任务独立审查后，还需 Task19 修复复审、whole-branch review、真实双端验收，最后才进入既有 tag 发布流程。

## 文件与职责

所有路径相对于上述插件工作区。新增文件按职责拆开，不把整个协调器塞入 `SyncRuntime`。

| 文件                                                                                                                   | 职责                                                        |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `src/application/tree-snapshot-reader.ts`                                                                              | 从 Runtime 提取固定版本读取与完整性验证，普通路径与升级共用 |
| `src/application/local-image-upgrade-plan.ts`                                                                          | legacy 类型、显式投影、合并、候选和授权摘要计算             |
| `src/storage/local-image-upgrade.ts`                                                                                   | 严格私有 schema、envelope、归属校验及 scoped 清理           |
| `src/application/local-image-upgrade.ts`                                                                               | 确认后的跨协议阶段协调及重启恢复                            |
| `src/application/local-image-upgrade-local.ts`                                                                         | 复用本地事务、身份与 baseline 的升级应用适配                |
| `src/application/space-sync-route.ts`                                                                                  | 纯函数模式路由，无请求或写入                                |
| `src/application/tree-push-service-v3.ts`                                                                              | 窄幅扩展父操作幂等归属与显式源版本校验端口                  |
| `src/application/sync-runtime.ts`                                                                                      | 提取共享读/本地提交能力，挂接升级；普通同步语义不变         |
| `src/main.ts`、`src/ports/tree-remote.ts`、`src/application/protocol-negotiator.ts`、`src/agentwiki/v3-tree-remote.ts` | 保留模式、独立 v2 capabilities、恢复优先与真实入口路由      |
| `src/obsidian/preview-modal.ts`                                                                                        | 统一升级预览及一次确认文案，复用现有冲突组件                |
| `tests/fakes/local-image-upgrade-fixture.ts`                                                                           | 明确固定的合成树与图片；不选择运行时或伪造发布成功          |
| `tests/fakes/plugin-harness.ts`                                                                                        | 提取现有真实插件初始化测试装配，不替换 negotiation/factory  |
| `tests/integration/local-image-upgrade-*.test.ts`                                                                      | 按转换、持久化、传输、应用、入口职责拆分测试                |
| `verification/local-image-upgrade.live.ts`、`vitest.live.config.ts`                                                    | 显式运行的公开服务契约验证，不进入默认离线 test glob        |
| `docs/verification/local-first-image-upgrade.md`                                                                       | 当前候选 SHA、公开契约与真实双端验收证据，不含秘密          |

依赖顺序：U1 契约/读取 → U2 私有状态 → U3 预览 → U4 远端协调 → U5 本地恢复 → U6 入口/UI → U7 验收收尾。U1 公开契约门失败时不继续 U2–U6 生产实现。每项只提交其准确路径，保留其他任务改动。

## U1：固定旧快照读取与公开跨协议契约门

**Files:** Create `src/application/tree-snapshot-reader.ts`, `src/application/local-image-upgrade-plan.ts`, `tests/fakes/local-image-upgrade-fixture.ts`, `tests/integration/local-image-upgrade-contract.test.ts`, `verification/local-image-upgrade.live.ts`, `vitest.live.config.ts`, `docs/verification/local-first-image-upgrade.md`; Modify `src/application/sync-runtime.ts`。

**Interfaces:** 消费 `TreeRemotePort`/`TreeRemotePortV3`、`TreeSnapshot`、`TreeSnapshotV3`、现有 `SyncOperationOptions` 和公开 hash/delta 函数。新增导出如下；计算树没有 revision 身份。

```ts
export type UpgradeTree = Pick<
  TreeSnapshotV3,
  "protocolVersion" | "spaceId" | "folders" | "pages" | "attachments"
>;
export interface LegacyUpgradeBase {
  sourceProtocolVersion: "2";
  sourceRevision: string;
  sourceV2RevisionHash: string;
  source: TreeSnapshot & { protocolVersion: "2" };
  projected: UpgradeTree;
  projectedV3BaseHash: string;
}
export async function readTreeSnapshot(
  remote: TreeRemotePort,
  spaceId: string,
  revision: string,
  options?: SyncOperationOptions,
): Promise<TreeSnapshot>;
export async function readTreeSnapshotV3(
  remote: TreeRemotePortV3,
  spaceId: string,
  revision: string,
  options?: SyncOperationOptions,
): Promise<TreeSnapshotV3>;
export async function projectLegacyBase(
  source: TreeSnapshot & { protocolVersion: "2" },
): Promise<LegacyUpgradeBase>;
```

- [ ] 从 Runtime 的 `downloadRemoteSnapshot`/`downloadRemoteSnapshotV3` 提取而非复制读取逻辑；先写失败测试覆盖请求固定 R、跨 Space、混页、缺页/重复 ID、正文 hash、manifest 字节数/hash、累计限额及 revision0 的严格空证据。使用现有 FakeHttp 和真实 V2/V3 adapter，不把 404 当空树。普通 Runtime 改为委托共享 reader。
- [ ] 在 fixture 文件导出 `makeLegacySource(): Promise<TreeSnapshot & {protocolVersion: "2"}>`：固定 UUID `11111111-1111-4111-8111-111111111111` 的 Space、`22222222-2222-4222-8222-222222222222` 的目录及 `33333333-3333-4333-8333-333333333333` 的 Page；路径分别 `pages/notes`、`pages/notes/text.md`，正文 `纯文字\n`，时间 `2026-09-06T00:00:00.000Z`，用公开 v2 算法生成 hash。测试投影不得重建 ID/时间/目录顺序：

```ts
const source = await makeLegacySource();
const base = await projectLegacyBase(source);
expect(base.sourceRevision).toBe(source.revision);
expect(base.sourceV2RevisionHash).toBe(source.revisionContentHash);
expect(base.projected.folders).toEqual(source.folders);
expect(base.projected.pages).toEqual(
  source.pages.map((page) => ({
    ...page,
    referencedAttachmentIds: [],
  })),
);
expect(base.projectedV3BaseHash).toBe(
  await treeRevisionContentHashV3(base.projected),
);
expect(base.projectedV3BaseHash).not.toBe(base.sourceV2RevisionHash);
expect("revision" in base.projected).toBe(false);
```

- [ ] Run `npx vitest run tests/integration/local-image-upgrade-contract.test.ts`，确认 RED 来自尚不存在的 reader/投影，而非坏 fixture 或 import 拼写。
- [ ] 显式复制受支持字段并验证源树、正文引用；投影前拒绝远端 legacy 图片候选并要求刷新模式，不用 `as TreeSnapshotV3`。实现计算核心：

```ts
const projected: UpgradeTree = {
  protocolVersion: "3",
  spaceId: source.spaceId,
  folders: source.folders.map((folder) => ({ ...folder })),
  pages: source.pages.map((page) => ({ ...page, referencedAttachmentIds: [] })),
  attachments: [],
};
return {
  sourceProtocolVersion: "2",
  sourceRevision: source.revision,
  sourceV2RevisionHash: source.revisionContentHash,
  source: structuredClone(source),
  projected,
  projectedV3BaseHash: await treeRevisionContentHashV3(projected),
};
```

- [ ] 加公开服务测试：显式配置只包含 URL、隔离 Space ID 与安全凭据提供器；用公开接口准备纯文字 Space，固定读 R，以真实可解码合成 PNG 与 Page 引用生成 C，使用公开 `treeRevisionDeltaV3(base.projected, C)`、`canonicalTreeDeltaItemsV3`、confirmation 算法进行实际 session/chunk/batch/finalize。仅复用公开包和插件传输实现；不得导入服务器内部类。至少包含未改 Page、已改 Page、目录排序以及空 Space 两例。断言：

```ts
expect(after.sequence).toBe(before.sequence + 1);
expect(after.revision).toBe(finalized.revision);
expect(published.pages.find((p) => p.pageId === unchanged.pageId)).toEqual(
  unchanged,
);
expect(await treeRevisionContentHashV3(published)).toBe(
  published.revisionContentHash,
);
expect(published.attachments.map((a) => a.attachmentId)).toEqual([
  added.attachmentId,
]);
```

这里 `before`/`after` 是实际 head，`finalized` 是实际 Finalize 响应，`published` 是固定返回 Revision 的实际读取，`unchanged` 是 R 投影中的未改 Page，`added` 是上传 PNG 的已确认元数据；不是由 fake 构造的期望结果。

- [ ] 新配置 `defineConfig({test:{include:["verification/**/*.live.ts"],testTimeout:60000}})`；live 文件缺少安全测试上下文直接报错，不使用静默 skip。Run `npx vitest run --config vitest.live.config.ts`。报告脱敏的 server 标识、候选 SHA、前后 Revision/sequence、公开契约结果与清理归属；不输出 HTTP headers 或整个异常请求对象。
- [ ] 单元/reader 回归与 `npm run typecheck` 通过后，准确暂存本任务文件，commit `test(sync): verify public legacy-to-v3 upgrade contract`。如果真实契约失败，记录具体缺失字段/不一致公开响应并停止后续实现，不修改 fake 迎合结果。

## U2：严格私有意图与子事务归属

**Files:** Create `src/storage/local-image-upgrade.ts`, `tests/integration/local-image-upgrade-storage.test.ts`。

**Interfaces:** 消费 `ControlStorePort`、`MutableControlRepository`、`TreeTransactionPathState`。生成严格日志 schema 和 `LocalImageUpgradeRepository`，调用方不能任意推进远端成功事实。

```ts
export interface UpgradeBinding {
  operationId: string;
  serverInstanceId: string;
  spaceId: string;
  deviceId: string;
  credentialId: string;
  mappingRootKey: string;
}
export interface UpgradeIntent {
  schemaVersion: 1;
  binding: UpgradeBinding;
  sourceRevision: string;
  sourceV2RevisionHash: string;
  oldBaselineEvidenceHash: string;
  projectedV3BaseHash: string;
  capabilitiesHash: string;
  confirmationHash: string;
  candidateHash: string;
  localPlanHash: string;
  authorizationHash: string;
  payloadPaths: string[];
  pushOperationId: string;
  localTransactionId: string;
  phase:
    | "confirmed"
    | "remote_pending"
    | "local_pending"
    | "complete"
    | "superseded";
  verifiedPublication: null | { revision: string; revisionContentHash: string };
}
export class LocalImageUpgradeRepository {
  constructor(store: ControlStorePort, root: string, binding: UpgradeBinding);
  read(): Promise<UpgradeIntent | null>;
  write(intent: UpgradeIntent): Promise<void>;
  cleanupCompleted(): Promise<void>;
}
export function inspectLocalImageUpgrade(
  store: ControlStorePort,
  root: string,
  binding: Omit<UpgradeBinding, "operationId">,
): Promise<UpgradeIntent | null>;
```

`credentialId` 仅是不含秘密的公开身份绑定，不是 credential/token。日志不含正文、Blob、绝对 Vault 路径、signed URL。`verifiedPublication` 是对 Push journal 所指 R3 的校验证据，不保存另一个 session/result；任何推进必须交叉核对原 Push journal。

- [ ] 写严格 schema RED：额外字段、错 server/Space/device、跨根 payload、未来版本、损坏主候选/更高代次、父子操作 ID 不符全部 fail-closed；旧合法 `.prev` 不能覆盖更高未知版本。合法日志 round-trip，用 `z.object({...}).strict()` 嵌套验证，路径拒绝绝对路径、`..`、反斜线逃逸及其他 operation 子树。
- [ ] Run `npx vitest run tests/integration/local-image-upgrade-storage.test.ts`，确认新增仓库缺失的 RED。
- [ ] 仓库组合现有 envelope，不改其格式。示例测试必须通过真实内存 ControlStore 完成落盘/重建，而不是 stub `read`：

```ts
await repository.write(intent);
expect(
  await new LocalImageUpgradeRepository(store, root, intent.binding).read(),
).toEqual(intent);
await expect(
  repository.write({ ...intent, payloadPaths: ["../other/body.md"] }),
).rejects.toThrow();
expect(await store.read(unrelatedPath)).toBe(unrelatedContents);
```

测试内 `intent` 完整填充上述 schema，`unrelatedPath` 是同 Space 另一 operation 的测试文件；`store` 使用现有内存 ControlStore 测试实现。

- [ ] 当前意图固定存放 `${root}/local-image-upgrade/journal.json`，使启动路由不用先知道 operation ID 即可通过 `inspectLocalImageUpgrade` 严格读取；每个 payload/子事务根固定为 `${root}/local-image-upgrade/${operationId}`。Push 与 local transaction 使用确定的子根，operation ID 在生成意图时确定。仅 complete/superseded 且权威子日志满足终态才清理本操作暂存；保留终态意图/关联证明，未知、pending、关联缺失不清理。每次写入先验证 binding、schema、路径，再 `MutableControlRepository.write(structuredClone(intent))`。同 Space 未终态时拒绝第二个操作。
- [ ] 添加每个 envelope 写/rename 边界中断后重建的恢复测试，以及禁止 journal 嵌入秘密字段/原始正文的测试；Run 上述测试及 `npm run typecheck`，commit `feat(sync): persist owned local image upgrade intent`。

## U3：固定输入的合并预览和精确授权

**Files:** Modify `src/application/local-image-upgrade-plan.ts`; Modify only the needed calculation boundary in `src/application/tree-diff.ts`, `src/core/tree-scan.ts`; Create `tests/integration/local-image-upgrade-plan.test.ts`。

**Interfaces:** 使用 U1 的 `LegacyUpgradeBase`/`UpgradeTree`、U2 的 `UpgradeBinding`、已有 `LocalTreeScanV3`、`TreePullPreviewV3`、`TreePullActionV3`、`TreeIdentityStateV2`、`TreePushPreviewV3`。新增：

```ts
export interface UpgradePreview {
  binding: UpgradeBinding;
  remoteBase: LegacyUpgradeBase;
  oldBaselineEvidenceHash: string;
  merge: TreePullPreviewV3;
  candidate: UpgradeTree;
  candidateHash: string;
  localActions: TreePullActionV3[];
  expectedPathStates: Record<string, TreeTransactionPathState>;
  localPlanHash: string;
  push: TreePushPreviewV3;
  authorizationHash: string;
}
export interface UpgradeMergeInput {
  base: LegacyUpgradeBase;
  remote: LegacyUpgradeBase;
  local: LocalTreeScanV3;
}
export function mergeLegacyUpgrade(
  input: UpgradeMergeInput,
): Promise<TreePullPreviewV3>;
export function hashUpgradeAuthorization(input: {
  binding: UpgradeBinding;
  sourceRevision: string;
  sourceV2RevisionHash: string;
  projectedV3BaseHash: string;
  oldBaselineEvidenceHash: string;
  candidateHash: string;
  localPlanHash: string;
  confirmationHash: string;
}): Promise<string>;
```

`base` 来自校验过的 B；首次无 B 复用原明确初始绑定决策，不能偷偷以 R 充当 B 并覆盖同名。计算边界提取已有 merge/scanner 所需树字段，使其可消费计算投影；`LegacyUpgradeBase` 不暴露为读取到的 `TreeSnapshotV3`，更不写 generation。普通 v3 调用仍走原验证。

- [ ] 添加 RED：B/L/R 各自改 Page/目录，远端未改 Page 不出现在 upsert，初次绑定同名异 ID 必须显式决策，删除/重命名后代闭包、双向图片引用重写、inactive ID 重引用与同路径不同 hash 不能冒认。沿用现有 Page/Folder/Attachment resolver，不另写冲突算法。
- [ ] Run `npx vitest run tests/integration/local-image-upgrade-plan.test.ts`，记录 RED；用最小计算输入边界替换对“已发布快照身份”的不必要依赖，运行原 tree-diff/tree-scan 测试防回归。
- [ ] 从最终 resolved 树得到 C；精确 delta 必须由 R 投影到 C。复用 Runtime 当前 prepared-page/body sidecar 和附件校验逻辑，必要时抽取到本模块，不重复图片解析/Blob引擎。保留未变对象元数据及稳定 ID：

```ts
const changes = canonicalTreeDeltaItemsV3(
  treeRevisionDeltaV3(remoteBase.projected, candidate),
);
if (candidate.attachments.length === 0) {
  throw new Error("UPGRADE_PREVIEW_NO_IMAGES_RECONFIRM_TEXT");
}
if (changes.length === 0) throw new Error("UPGRADE_PREVIEW_EMPTY");
```

- [ ] 以 `sha256Hex(canonicalBytes(input))` 实现独立 `hashUpgradeAuthorization`；既有 wire `confirmationHash` 算法不改。`localPlanHash` 绑定有序 localActions、raw before-state、目录后代闭包、扫描代次与身份证据；authorization 同时绑定候选、localPlan 和远端确认。复制 preview 参与计算，后续 UI 变更必须重算，不能修改已确认对象。
- [ ] 增加真实 VaultPort read/write 计数测试；未引用 PNG 只有列表元数据，不读 bytes。预览允许 scoped payload 写，业务 `write/rename/remove/trash` 计数全部零；取消后 scoped 清理不触及其他操作。权限/caps/任一本地动作变化都会改变授权或使预览失效：

```ts
expect(
  changes
    .filter((c) => c.operation === "upsert_page")
    .map((c) => c.page.pageId),
).not.toContain(unchangedPageId);
expect(businessWrites).toHaveLength(0);
expect(imageReads).not.toContain("assets/unused.png");
expect(
  await hashUpgradeAuthorization({
    ...bindingInput,
    localPlanHash: changedPlanHash,
  }),
).not.toBe(await hashUpgradeAuthorization(bindingInput));
```

测试计数由委托真实内存 VaultPort 的 spy 收集；`bindingInput` 完整满足上述函数签名，changedPlanHash 由确实改变的 before-state 算出。

- [ ] Run `npx vitest run tests/integration/local-image-upgrade-plan.test.ts`、原合并/扫描测试、`npm run typecheck`；commit `feat(sync): compute confirmed local-first image upgrade preview`。

## U4：复用 Push 的一次发布与远端恢复

**Files:** Create `src/application/local-image-upgrade.ts`, `tests/integration/local-image-upgrade-push.test.ts`; Modify `src/application/tree-push-service-v3.ts`。

**Interfaces:** `LocalImageUpgradeCoordinator` 消费 U2 repository、U3 preview、实际 `TreePushServiceV3` 与下列端口。新增 Push constructor 第五个可选参数 `ownership?: UpgradePushOwnership`；不改变 wire schema 或普通 journal schema。幂等键在 stage 时取 parent operation ID，否则维持普通 randomUUID。私有 operation 子根限定唯一子 journal。

```ts
export interface UpgradePushOwnership {
  operationId: string;
  assertSourceCurrent(baseRevision: string): Promise<void>;
  onStaged(): Promise<void>;
}
export interface UpgradeCoordinatorPort {
  revalidate(preview: UpgradePreview): Promise<void>;
  loadConfirmed(intent: UpgradeIntent): Promise<UpgradePreview>;
  verifyPublished(intent: UpgradeIntent): Promise<TreeSnapshotV3>;
  applyPublished(
    intent: UpgradeIntent,
    snapshot: TreeSnapshotV3,
  ): Promise<void>;
}
export class LocalImageUpgradeCoordinator {
  constructor(
    repository: LocalImageUpgradeRepository,
    push: TreePushServiceV3,
    port: UpgradeCoordinatorPort,
  );
  confirm(
    preview: UpgradePreview,
    authorizationHash: string,
    options?: SyncOperationOptions,
  ): Promise<void>;
  recover(options?: SyncOperationOptions): Promise<void>;
}
```

端口 `verifyPublished` 必须读取原 Push journal 结果再固定读取 R3，不从 current 猜结果；U4 测试使用受控 HTTP，U5 实现本地端口。`loadConfirmed` 从本操作受控暂存加载、重算并核对所有 hash，不能重新扫描后静默生成另一个候选。

- [ ] 写 RED：confirm 传入不匹配 authorization 不建 session；持久 intent 失败不派生 child；create 响应丢失重启仍用同一个 idempotency；Finalize 已提交但丢失响应只查询原 session。用真实 Push service + FakeHttp 路由控制响应，不能 stub coordinator.publish 返回成功。
- [ ] Run `npx vitest run tests/integration/local-image-upgrade-push.test.ts`。
- [ ] 只替换 Push 中普通 `remote.head()` 的适用来源检查；upgrade 不伪装 V3TreeRemote.head，采用明确端口：

```ts
if (this.ownership) {
  await this.ownership.assertSourceCurrent(journal.baseRevision);
} else if ((await this.remote.head()).revision !== journal.baseRevision) {
  throw new Error("BASE_STALE");
}
```

保留现有 superseded 保存/错误边界。stage 的幂等键为 `this.ownership?.operationId ?? crypto.randomUUID()`；恢复核对 journal.idempotencyKey 与 ownership，一旦不符停止。`assertSourceCurrent` 严格请求公开 fresh Space 模式及 v2 head，不能接受 HTTP 错误作为 mode；每次 create/finalize 前还通过 `TreePushLocalPortV3.revalidateConfirmation` 重查权限、caps、B/L/R 和完整本地授权。

- [ ] confirm 顺序锁定为：校验用户 hash → revalidate → 写 confirmed 意图和 payload 引用 → `publishPrepared` 内持久化并回读 owned child journal → `onStaged()` 核对 child 后将父意图记为 remote_pending → 再 revalidate → create。`onStaged()` 失败时不发网络请求。恢复遇到 confirmed 且 child 不存在时，仅在 payload 完整且所有 child envelope 候选确实不存在时派生；confirmed 且 child 存在则验证后补记 remote_pending 并 resume；remote_pending 却 missing child 视为损坏。通过 phase 写入与 child 核实顺序覆盖两者间断电，不靠不存在的“原子多文件写入”。
- [ ] recover 优先 `resumePending()` 并依权威 journal 分支；published → `verifyPublished` → 保存核验证据 → local_pending；unknown/error 保持 pending；明确未发布并已核实 aborted/expired 才 superseded。源 head 变更不阻止读取已发布 session 的固定结果。沿用 `6e4510e` name-conflict allowlist 和 published race 规则，不扩大到所有错误。
- [ ] 单独覆盖 `resumePending()` 尚无 sessionId 时的 create 分支：同一幂等键重试不能漏过 owned-source/本地授权重验；已有 sessionId 先查原 session，再判断是否仍需写入。结果未知时禁止新建候选、换幂等键或将旧操作说成未发布。若公开接口不足以在响应丢失且 head 变化后核实原操作，保留 pending 并记录明确契约缺口，不猜测结果。
- [ ] 添加权限撤销、caps 变更、本地变动、另一设备升级、取消与 late-finalize 测试；断言旧 payload/confirmation/ID 不变，unknown 不二次发布：

```ts
expect(new Set(createBodies.map((body) => body.idempotencyKey)).size).toBe(1);
expect(finalizeCallsAfterPublishedRecovery).toBe(0);
expect(await baseline.readSnapshot()).toEqual(oldBaseline);
expect((await repository.read())?.phase).not.toBe("complete");
```

- [ ] Run 新传输测试、现有 v3 push 测试及 `npm run typecheck`；commit `feat(sync): coordinate atomic first-image publication`。

## U5：固定 R3 本地应用、身份和断电恢复

**Files:** Create `src/application/local-image-upgrade-local.ts`, `tests/integration/local-image-upgrade-local.test.ts`; Modify narrow shared helpers in `src/application/sync-runtime.ts` and `src/storage/tree-baseline.ts` only if required for shared verified local-apply orchestration。

**Interfaces:** 实现 U4 `UpgradeCoordinatorPort` 的 `verifyPublished`/`applyPublished`；复用既有 `TreeTransaction.prepare(input: TreeTransactionInput, transactionId?: string)`、`apply/recover/assertApplied/markVerified/markCommitted`、`TreeBaselineRepository.prepare(snapshot, "pull", transactionId)`/`commit()` 和 `src/storage/tree-identities.ts` 的 `TreeIdentityRepository`。生成 `UpgradeLocalApply` 类：

```ts
export class UpgradeLocalApply {
  constructor(deps: {
    remote: TreeRemotePortV3;
    push: TreePushServiceV3;
    transaction: TreeTransaction;
    baseline: TreeBaselineRepository;
    identities: TreeIdentityRepository;
    vault: VaultPort;
    loadConfirmed(intent: UpgradeIntent): Promise<UpgradePreview>;
  });
  verifyPublished(intent: UpgradeIntent): Promise<TreeSnapshotV3>;
  applyPublished(
    intent: UpgradeIntent,
    snapshot: TreeSnapshotV3,
  ): Promise<void>;
}
```

U4 coordinator 依次调用这两个方法；真实端口在应用模块装配现有 repositories，Runtime 只委托。它不是第二个发布状态机。使用 `prepare(...,"pull",...)` 表示已确认完整远端读取/本地应用，不放宽 baseline 对普通 Push 首次 v3 的保护；只有真实返回且完整验证的 R3 能传入。

- [ ] 写 RED：Finalize 后 current 已前進仍读取返回 R3；R3 candidate/hash/附件 metadata 不符不写 Vault；before-state 晚改保留用户内容；未引用图片永不删除。故障注入存储和 Vault 的逐操作失败，重建真实 repositories/coordinator 后恢复，不仅在同一对象上再次调用。
- [ ] Run `npx vitest run tests/integration/local-image-upgrade-local.test.ts`。
- [ ] `verifyPublished` 读取实际 child journal 的 published result，使用 U1 `readTreeSnapshotV3(remote, spaceId, result.revision)`；校验协议、Space、revision/hash、candidateHash、所有正文/附件及下载 bytes。只保存验证证明，不更改 child result。晚编辑的原 before-state 不再满足时抛出可展示的 `UPGRADE_REMOTE_PUBLISHED_LOCAL_PENDING`，不能回退普通 v2。
- [ ] 为本地事务使用意图中已固定的 transaction ID，归属校验覆盖 baseline journal 和 identity staged state；直接使用现有 prepare 第二参数，不在 `TreeTransactionInput` 重复增加字段。拒绝与现存非终态事务冲突的 supplied ID。
- [ ] 本地应用按既有 v3 Pull 的受控顺序提取为共享能力：保存 before-state/后代闭包 → `prepare({baseRevision: intent.sourceRevision,targetRevision: snapshot.revision,targetTreeHash: snapshot.revisionContentHash,actions,expectedPathStates,deferCommit:true}, intent.localTransactionId)` → 持久 staged identity/control-after → apply → 验证实际文件 → `tx.markVerified()` → `baseline.prepare(snapshot,"pull",intent.localTransactionId)` → `baseline.setPhase("applying")` → `tx.assertApplied()` → `baseline.recover(intent.localTransactionId)` → 提交同归属 identity/control-after → `tx.markCommitted()`。最终核对三者一致后再 `push.markVerified()`、将父意图标 complete 并清理。具体 rollback/恢复判定沿用现有证据，不另建成功布尔值。该链每个 await 的下一行均需可注入断电。
- [ ] 跑图片写、正文写、rename、identity 保存、pointer 切换、terminal cleanup 全断点矩阵，断言：

```ts
expect(await vault.read(lateEditedPath)).toEqual(lateEditedBytes);
expect((await push.load()).result?.revision).toBe(publishedRevision);
expect(
  recoveryNetworkCalls.filter((call) => call.kind === "finalize"),
).toHaveLength(0);
// 仅在本地恢复确实成功的分支断言：
expect((await baseline.readSnapshot()).revision).toBe(publishedRevision);
expect((await baseline.readSnapshot()).protocolVersion).toBe("3");
expect((await repository.read())?.phase).toBe("complete");
```

不能在本地晚编辑冲突分支断言 complete；保持 local_pending 并用新预览授权新的覆盖/合并决定。完成后再 Pull 当前新 head。

- [ ] 回归 `6e4510e` 的 terminal sidecar 清理、inactive ID 重引用、同名不同 hash 与 Finalize race；Run 新本地测试、tree-transaction、tree-baseline、sync-runtime 对应测试及 `npm run typecheck`；commit `feat(sync): recover local application of first-image upgrade`。

## U6：真实插件入口按 Space 模式分流与单次确认

**Files:** Create `src/application/space-sync-route.ts`, `tests/fakes/plugin-harness.ts`, `tests/integration/local-image-upgrade-entry.test.ts`; Modify `src/main.ts`, `src/ports/tree-remote.ts`, `src/agentwiki/v3-tree-remote.ts`, `src/application/protocol-negotiator.ts`, `src/obsidian/preview-modal.ts`, `tests/integration/plugin-settings-lifecycle.test.ts`。

**Interfaces:** 新增纯函数，模式先由公开 schema 严格验证；旧服务器不需要虚构 mode。

```ts
export type SpaceSyncRoute =
  "legacy" | "native_v3" | "bootstrap" | "upgrade" | "recover_upgrade";
export function selectSpaceSyncRoute(input: {
  serverVersion: "1" | "2" | "3";
  syncMode: "legacy_v2" | "bootstrap_required" | "native_v3" | null;
  requiredVersion: "1" | "2" | "3";
  pendingUpgrade: boolean;
  localImageCandidate: boolean;
  remoteImageCandidate: boolean;
}): SpaceSyncRoute;
```

- [ ] 提取 `plugin-settings-lifecycle.test.ts` 的真实 `makePlugin` 初始化和 storage 装配到 harness，维持原测试通过。新 entry 测试从 plugin.onload/factory/同步中心出发，通过 requestUrlState/FakeHttp 提供 wire 响应；不得预选 FakeTreeRemote 或只测 selectSpaceSyncRoute 返回字符串。
- [ ] 增加 RED 路由表：old+任一图片阻止；v3 legacy 无图真实 v2 adapter；legacy 本地图片 upgrade；bootstrap 首次请求不先触发 v3 head/delta；native 无附件仍 v3；已提交 v3+legacy 报不一致；pending 优先恢复；未知模式和 401/403/409/429/5xx 都不降级。
- [ ] Run `npx vitest run tests/integration/local-image-upgrade-entry.test.ts tests/integration/plugin-settings-lifecycle.test.ts`。
- [ ] 按以下顺序实现路由核心，HTTP/权限验证留在严格装配层；同步中心 loadDiff 和 runStrategy 使用同一路由，不让状态读取绕过 bootstrap：

```ts
if (input.pendingUpgrade) return "recover_upgrade";
if (input.serverVersion !== "3") {
  if (
    input.requiredVersion === "3" ||
    input.localImageCandidate ||
    input.remoteImageCandidate
  )
    throw new Error("SYNC_PROTOCOL_UPGRADE_REQUIRED");
  return "legacy";
}
if (input.syncMode === "native_v3") return "native_v3";
if (input.requiredVersion === "3")
  throw new Error("SPACE_PROTOCOL_INCONSISTENT");
if (input.syncMode === "bootstrap_required") return "bootstrap";
if (input.syncMode !== "legacy_v2") throw new Error("SPACE_MODE_INVALID");
if (input.remoteImageCandidate) throw new Error("SPACE_MODE_REFRESH_REQUIRED");
return input.localImageCandidate ? "upgrade" : "legacy";
```

- [ ] 主入口保留 Space syncMode/canPublish；独立读取验证 v2 capabilities，不覆盖 server v3 negotiation cache。runtime key 包含 route/capabilities/映射绑定，旧 runtime 不能绕过 fresh pending recovery。扫描本地图片只读合法引用；不先读取整个 assets 文件夹字节。
- [ ] 预览标题说明 v2→v3、不可自动降级、兼容要求；显示最终页面/目录动作、图片名称/数量、传输字节上界、全部冲突和本地应用计划。按钮唯一主动作是“确认升级并同步”，调用 `coordinator.confirm(preview, preview.authorizationHash, options)`。未解决冲突、viewer、正在重算或 preview 失效时禁用；全部图片被取消后转文字预览并重新确认。远端 bootstrap 保持原有两个确认，不混用。
- [ ] 实际模拟点击验证一次确认成功；在点击前断言 session/chunk/batch/finalize/Vault业务写入为零。覆盖 modal close/cancel、窄屏滚动、冲突重算后按钮状态及晚编辑 local_pending 文案；刷新后从持久日志恢复，不需原 modal 内存。原 Task19 I1 必须以这些真实入口断言替换假成功矩阵。
- [ ] Run 入口与既有 UI/生命周期/negotiation 测试、`npm run typecheck`；commit `feat(obsidian): route first local image through one confirmed upgrade`。

## U7：故障矩阵、Task19 复审与真实双端收尾

**Files:** Modify `docs/verification/local-first-image-upgrade.md`; Modify exact defect-owning test/source files only if fresh failures require reviewed fixes。复用原 Task19 的 `.superpowers/sdd` 证据与 review briefs，不提交凭据或私有现场。

**Interfaces:** 消费 U1–U6 的最终冻结 SHA、实际 plugin factory、公开 HTTP 与安装 bundle；产出逐项 PASS/FAIL/NOT_RUN 证据及独立审查结论，不新增产品接口。

- [ ] 核对 U1–U6 task review；恢复原 Task19 fix loop，对 `6e4510e` I2/I3 及本轮 I1 的完整 fix range 做独立定向复审。旧 review 的大测试文件与17条 baseline warning 逐项盘点，不能用关闭 lint 规则掩盖。保留原 fixture，不回写日志制造通过。
- [ ] Run `npm run check` 与 `npm audit --json`；记录冻结 commit、每个命令退出码、测试文件/测试数、warnings 和 bundle SHA。若 audit 子进程受 `npm_config_allow_scripts` 污染，只清理该子进程环境再复核，不放宽依赖安全要求。最后代码修复后重新跑完整质量门。
- [ ] Run `npx vitest run --config vitest.live.config.ts` 于同一候选；重跑公开 R→R3 原子升级及 create/finalize 丢响应，确认同一操作只一个新 Revision。不能引用旧 native-v3 fixture 的成功作为首次本地升级证明。
- [ ] 桌面仅用 `/Users/neomei/Obsidian/AgentWiki-Sync-V3-Acceptance-20260905` 新建独立合成映射，先公开确认网页 Space 无图片引用且 legacy_v2。只在本地写 Markdown 引用合成图片，通过真实 modal 一次确认；核验网页图片、离线读取、稳定 ID、重复零操作、detach/re-reference、FileManager 重命名和未引用图零读取/上传。安装前后保存 manifest/main.js SHA，安装仅作用于已授权隔离 Vault。
- [ ] 同一最终 bundle 在真实 Android 已解锁 Obsidian 中运行独立纯文字 Space 首图升级，完成窄屏确认、图片写读、FileManager、重启恢复。设备若仍锁屏，向用户要求手动解锁，不绕过锁，不把整体验收记为通过。记录设备/Obsidian版本、bundle SHA 和实际结果；不暴露设备中的其他内容。
- [ ] 对整个待发布分支做独立 whole-branch review，范围含原已发布 origin/main 到冻结 HEAD 的产品代码和文档；检查原有 Task12/16/18 遗留项及误跟踪 task-14-report 的归属。不对 `.superpowers` 递归删除；只在明确确认目标后处理误跟踪文件。
- [ ] 只有全部必需门 PASS 且 review 无阻塞项，才继续原已授权发布流程：刷新 origin/main/tag/latest，沿 numeric tag `0.4.0` workflow，不重复手工 release；核对 GitHub 三资产 SHA/attestation、实际安装 bundle、社区列表与 npm/server 已发布渠道。已有 server/npm 发布状态与插件发布分开陈述；若公开契约不需服务器改动，不部署无关 server 版本。
- [ ] commit `docs(sync): record verified first-image upgrade acceptance`（仅真实产生的脱敏证据）。存在 NOT_RUN/FAIL 时提交真实状态，不标记 Task19 完成，不发插件0.4.0。

## 执行者自查与交付

| 补充设计要求                               | 实施/验证任务         |
| ------------------------------------------ | --------------------- |
| §1–2 一次原子升级、公开协议可表达性        | U1、U4、U7            |
| §3 模式/权限/最低协议/恢复优先/旧端无图    | U4、U6                |
| §4.1 固定输入、初始绑定、空树证据          | U1、U3                |
| §4.2 三种 hash 与真实 generation           | U1、U2、U3、U5        |
| §4.3 精确 delta/图片范围/限额/全取消       | U1、U3、U6            |
| §5 确认零副作用与完整授权重验              | U2、U3、U4、U6        |
| §6 发布/本地顺序、幂等、归属、断电、晚编辑 | U2、U4、U5、U7        |
| §7 独立模块与跨仓边界                      | 文件职责表、U1、U3–U6 |
| §8–9 Task19 回归、双端、审查与发布门       | U6、U7                |

- [ ] 每项执行记录 RED/GREEN 命令、冻结 commit 与独立审查结论；计划中的测试片段是要落地的断言，不是已经通过的结果。
- [ ] 逐项核对代码里的函数/类型与本计划接口；如公开契约证据要求变更接口，先更新受影响任务与评审说明，禁止靠强制类型转换绕过边界。
- [ ] 最终报告分开列：本地代码/完整测试、GitHub、npm、server生产、桌面、Android。未验证渠道不得写“全部完成”。

本计划仅完成拆分与实施准备。推荐下一轮采用当前任务内的 subagent-driven-development：每个独立任务新作者、task review、必要 fix review，最后 whole-branch review；原 Task19 证据与待复审修复继续沿用。
