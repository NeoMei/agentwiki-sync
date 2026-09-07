# Shortest Image Link Transaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Obsidian 原生重命名产生的短 Markdown 图片链接，在一次确认后完成安全的标准相对路径同步与可恢复本地写回，并补齐原 U7 发布门。

**Architecture:** 普通 Push 有本地修正时使用 schema 4 父日志，复用 schema 3 TreePushServiceV3 远端子引擎和 deferred TreeTransaction 本地子引擎。没有本地修正保留普通 schema 3；Pull 和首次图片升级沿用其既有所有者。先完成未启用的纯计算、持久化和协调器，最后一次接入生产入口，避免只规范化内存的危险中间状态。

**Tech Stack:** TypeScript、Vitest、Zod、Obsidian public Vault/MetadataCache APIs、现有 ControlStore envelope；公开协议依赖保持 @neomei/agentwiki-sync-protocol 0.5.1。

**Spec:** [已确认补充规格](../specs/2026-09-07-shortest-image-link-transaction-design.md)。执行前完整阅读该文和其引用的两份前置规格。

## Global Constraints

- 仅处理映射内 `pages/**/*.md` 引用的、映射内平铺 `assets/<name>` 的 PNG/JPEG/WebP/GIF。
- 不扫描上传整个附件目录，不读取未引用图片字节，不新建附件管理入口。
- 不修改服务器、公开协议包或公共 Markdown 解析语义；标准 Markdown 仍按 Page 相对路径解析，旧裸名 wiki 嵌入规则不变。
- 不修改 Obsidian 全局链接设置，不在 rename 事件、扫描或未确认预览中改业务文件。
- 不自动规范化整个 Vault，不改普通页面链接、外链、正文示例或其他映射。
- 不新增自动覆盖晚编辑、自动降级、强制完成日志或伪造远端成功的功能。
- 公共协议仍为 v3，私有 schema 4 不代表服务器协议升级。
- `rawPathStates` 始终是原字节 hash；canonical contentHash 不能替代 CAS 证据。
- local_only 不创建 session、Blob、Finalize、空 Revision 或假成功 result。
- 继续在 `/Users/neomei/项目/codexprojects/AgentWiki-Obsidian/.worktrees/referenced-image-sync-v3`、分支 `codex/referenced-image-sync-v3` 执行；不另建与原实现脱节的分支。
- 起点为设计提交 d53f768；产品起点 70bf4ae。先核对实际 HEAD、脏文件和 AGENTS.md；已有未跟踪验收文档属于用户工作，不能清理。
- 原两个 SDD ledger、真实 Android 失败笔记和旧事务证据均为显式交接依赖，不能作为临时文件删除。
- Task 1–4 不在生产 scan/runtime 启用规范化；Task 5 完整接线并通过行为门后才启用。每项独立提交、独立任务审查；修复另做差异审查。
- 本计划不是实现或通过证明。现有 869 测试、安装包 hash、生产部署及部分设备证据均为历史基线，不替代最终候选验证。

## 文件职责与依赖顺序

以下路径均相对上述隔离 worktree；执行命令也在该目录。

| 文件                                                                                          | 职责                                                                   | Task |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---- |
| `src/core/attachment-reference.ts`                                                            | 复用原 tokenizer，区分合法短名候选与语法非法；公开 classification 不变 | 1    |
| `src/core/attachment-target.ts`（新）                                                         | 从 attachment-merge 提取相对目标/style 工具                            | 1    |
| `src/core/attachment-merge.ts`                                                                | 使用提取后的同一工具，行为不变                                         | 1    |
| `src/core/local-image-normalization.ts`（新）                                                 | 纯计算改写、raw/canonical 双证据                                       | 1    |
| `src/ports/vault.ts`、`src/obsidian/adapters.ts`                                              | 可选受限 resolver；public metadata + 全 Vault 路径唯一性               | 1    |
| `src/obsidian/shortest-image-resolver.ts`（新）                                               | 元数据索引及 create/delete/rename 失效                                 | 1    |
| `src/application/normalized-push-plan.ts`（新）                                               | 持久计划类型、授权 hash、候选和配额校验                                | 2    |
| `src/storage/normalized-push.ts`（新）                                                        | schema 4 strict guard、归属、payload 和历史完成凭据                    | 2    |
| `src/storage/push-journal-router.ts`（新）                                                    | 普通 Push 根日志 3/4 混合代际及受控 writer                             | 2    |
| `src/application/tree-push-service-v3.ts`                                                     | 仅注入 journal port；旧 strict3/上传/取消语义不放宽                    | 2    |
| `src/application/normalized-push-local.ts`（新）                                              | deferred transaction、真实字节验证、baseline/身份完成                  | 3    |
| `src/application/tree-local-apply-v3.ts`                                                      | 复用既有身份计算/提交；只作必要提取                                    | 3    |
| `src/application/normalized-push.ts`（新）                                                    | 父操作状态推进、固定目标验证和 remote/local 两个子操作协调             | 4    |
| `src/core/tree-scan.ts`                                                                       | 启用 canonical scan 与本地证据，保持 raw 状态                          | 5    |
| `src/application/sync-runtime.ts`                                                             | 普通入口 delegation、旧恢复 dispatch、Pull 接线                        | 5    |
| `src/application/local-image-upgrade-plan.ts`、`src/application/local-image-upgrade-entry.ts` | 升级计划保留规范化动作与授权证据                                       | 5    |
| `src/application/local-image-upgrade.ts`、`src/storage/local-image-upgrade-confirmation.ts`   | 冻结/恢复验证新增证据；旧授权不追认                                    | 5    |
| `src/application/tree-diff.ts`、`src/application/tree-preview.ts`                             | 依据最终冲突选择保留真实本地动作                                       | 5    |
| `src/main.ts`、`src/application/protocol-negotiator.ts`                                       | resolver 生命周期、identity authority、恢复优先/最低协议/断开入口      | 5    |
| `src/obsidian/preview-modal.ts`、`src/obsidian/preview-logic.ts`                              | 本地修正清单、local_only 确认、准确 pending 文案                       | 5    |
| `tests/unit/local-image-normalization.test.ts`（新）                                          | tokenizer/target/resolver 纯行为                                       | 1    |
| `tests/integration/normalized-push-storage.test.ts`（新）                                     | schema、代际、冻结计划、归属及 writer                                  | 2    |
| `tests/integration/normalized-push-local.test.ts`（新）                                       | 本地事务提交/恢复/晚编辑                                               | 3    |
| `tests/integration/normalized-push.test.ts`（新）                                             | 父协调器 remote/local_only 与断点                                      | 4    |
| `tests/integration/normalized-push-runtime.test.ts`（新）                                     | 真 Runtime 入口和全路径故障矩阵                                        | 5–6  |
| `tests/fakes/normalized-push-fixture.ts`（新）                                                | 测试数据、真实 repositories/engines 组装，不模拟协调器成功             | 2–6  |
| `docs/verification/2026-09-07-shortest-image-link-acceptance.md`（新）                        | 同一最终候选的测试/真机/公网/审查/发布证据                             | 6–7  |

不得为测试方便复制 TreePushService 或 TreeTransaction。测试 fake 只位于端口和故障注入边界。

## Task 1: 纯本地候选解析、精确改写与受限 resolver

**Files:** 创建职责表中的 attachment-target、local-image-normalization、shortest-image-resolver；修改 attachment-reference、attachment-merge、VaultPort、adapters；测试新增 local-image-normalization，并扩展 `tests/unit/attachment-reference.test.ts`、`tests/unit/attachment-merge.test.ts`、`tests/unit/obsidian-adapters.test.ts`。暂不修改生产 tree-scan/main。

**Interfaces:** 新类型定义于 VaultPort 与 local-image-normalization；Page path 和 attachmentPath 均为映射相对路径。resolver 本身绑定 mappingRoot，不接受任意外部 root。

```ts
// src/ports/vault.ts
export type ShortestImageResolution =
  | { kind: "resolved"; attachmentPath: string; basenameKey: string }
  | { kind: "missing" | "ambiguous" | "out_of_scope" | "unavailable" };
// 在 VaultPort 增加此可选方法，不改变其余端口。
resolveShortestImage?(pagePath: string, decodedBasename: string):
  Promise<ShortestImageResolution>;
```

其余计算类型定义如下；ResolveShortestImage 由本模块导出供调用者使用：

```ts
export type ResolveShortestImage = (
  pagePath: string,
  decodedBasename: string,
) => Promise<ShortestImageResolution>;
export interface LocalImageReplacement {
  targetStart: number;
  targetEnd: number;
  originalTarget: string;
  canonicalTarget: string;
  attachmentPath: string;
  basenameKey: string;
}
export interface LocalImageNormalization {
  pageId: string;
  pagePath: string;
  rawHash: string;
  canonicalContentHash: string;
  replacements: LocalImageReplacement[];
}
export async function normalizeLocalImageLinks(input: {
  pageId: string;
  pagePath: string;
  raw: Uint8Array;
  resolve?: ResolveShortestImage;
}): Promise<{ body: string; evidence: LocalImageNormalization | null }>;
```

`normalizeLocalImageLinks` 没有 resolver 或遇拒绝时原样保留目标，由后续现有公开 parser 产生 blocker；不吞掉非法引用。`attachment-reference.ts` 新导出 `parseShortestImageCandidates(body: string): Array<{targetStart: number; targetEnd: number; decodedBasename: string}>`，使用同一个 tokenizer 的语法事实，不重新用正则解析 Markdown。提取的 `relativeAttachmentPath(pagePath: string, attachmentPath: string): string` 和 `preserveMarkdownTargetStyle(original: string, target: string, insideAngles: boolean): string` 为 attachment-target 的唯一公共工具。

- [ ] 写一个实质行为 RED：先以原正文作为最小实现返回，确认以下目标范围测试失败；缺模块、类型错误不算 RED。

```ts
it("canonicalizes only the valid image target and preserves raw evidence", async () => {
  const body = '![A](<photo.png> "T")\n`![code](photo.png)`';
  const raw = new TextEncoder().encode(body);
  const result = await normalizeLocalImageLinks({
    pageId: "page-1",
    pagePath: "pages/nested/note.md",
    raw,
    resolve: async () => ({
      kind: "resolved",
      attachmentPath: "assets/photo.png",
      basenameKey: "photo.png",
    }),
  });
  expect(result.body).toBe(
    '![A](<../../assets/photo.png> "T")\n`![code](photo.png)`',
  );
  expect(result.evidence?.rawHash).toBe(await sha256Hex(raw));
  expect(result.evidence?.canonicalContentHash).toBe(
    await contentHash(result.body),
  );
  expect(result.evidence?.replacements).toHaveLength(1);
});
```

- [ ] 运行 `npx vitest run tests/unit/local-image-normalization.test.ts`，记录预期的正文相等断言失败。
- [ ] 从原 tokenizer 提取合法候选事实；提取原两个路径/style 工具并通过 attachment-merge 原回归。对候选逐个调用可选 resolver，按 source range 降序替换；重新调用公开 parser 证明每个新目标分类 local 且路径等于 resolver 结果。不通过时保持原目标，不能写出另一个非法链接。

```ts
let rewritten = body;
for (const replacement of [...replacements].sort(
  (a, b) => b.targetStart - a.targetStart,
)) {
  rewritten =
    rewritten.slice(0, replacement.targetStart) +
    replacement.canonicalTarget +
    rewritten.slice(replacement.targetEnd);
}
// 公开 parser 再验证通过后才构造 evidence；rawHash 只从 input.raw 计算。
```

- [ ] 实现 `ObsidianShortestImageResolver(vault: Vault, metadataCache: MetadataCache, mappingRoot: string)`，公开 `resolve(pagePath: string, decodedBasename: string): Promise<ShortestImageResolution>`、`invalidate(): void`。仅 `vault.getFiles()` 建路径元数据索引，NFC + unicode-case-folding，索引命中必须全 Vault 数量为 1 且与 `getFirstLinkpathDest` 实际目标相同，再检查 flat assets。返回错误只有 kind，不携带外部路径。
- [ ] `ObsidianVaultPort` 构造器增加第四个可选 resolver 参数；端口无 resolver 返回 unavailable。事件注册由 Task 5 的插件生命周期承担，不在每个 adapter 创建永久监听器。
- [ ] 增加边界表：空格/括号/合法百分号编码 token/Unicode/角括号/title/反斜杠等价转义；非法 `%` 编码、解码后文件名含字面 `%`（公开协议 0.5.1 禁止，保留原引用并阻塞）、URI、盘符、slash、backslash、traversal、不支持扩展名、非法 title；code/comment；外部同 basename、大小写/NFC 重名、metadata 分歧、缺文件、非 flat assets；索引失效后新重名。断言拒绝输出不泄露外部路径，metadata 测试 readBinary 调用为 0。
- [ ] 运行 `npx vitest run tests/unit/local-image-normalization.test.ts tests/unit/attachment-reference.test.ts tests/unit/attachment-merge.test.ts tests/unit/obsidian-adapters.test.ts` 和 `npm run typecheck`，全部 PASS。检查公开 conformance fixture 未改宽。
- [ ] 仅 stage 本 Task 文件；提交 `feat(sync): calculate scoped shortest image link normalization`，进入独立任务审查。未启用生产规范化。

## Task 2: 冻结计划、schema 4 与普通根日志兼容 writer

**Files:** 新增 normalized-push-plan、storage/normalized-push、push-journal-router、normalized-push-storage 测试及 fixture；修改 tree-push-service-v3 的 journal 依赖注入，不改上传算法。读取 `src/storage/envelope.ts` 和 `src/storage/local-image-upgrade.ts` 的 strict candidate 规则。

**Interfaces:** 采用如下单一模型；`TreeIdentityStateV2`、`TreeSnapshotV3` 和 `TreePushPreviewV3` 使用现有导出，不定义替代模型。

```ts
export interface NormalizedPushBinding {
  operationId: string;
  serverOrigin: string;
  serverInstanceId: string;
  spaceId: string;
  deviceId: string;
  credentialId: string;
  vaultId: string;
  mappingRootKey: string;
}
export interface NormalizedPageWrite {
  kind: "write_page";
  pageId: string;
  path: string;
  beforeHash: string;
  payloadPath: string;
  contentHash: string;
  byteLength: number;
}
export interface NormalizedPushPlan {
  schemaVersion: 4;
  protocolVersion: "3";
  mode: "remote_push" | "local_only";
  binding: NormalizedPushBinding;
  sourceRevision: string;
  sourceTreeHash: string;
  capabilitiesHash: string;
  wireConfirmationHash: string;
  candidateHash: string;
  localPlanHash: string;
  authorizationHash: string;
  localTransactionId: string;
  localPlan: NormalizedPageWrite[];
  normalizations: LocalImageNormalization[];
  rawPathStates: LocalTreeScanV3["rawPathStates"];
  identities: TreeIdentityStateV2;
  scanEpoch: number;
}
export interface NormalizedPushCompletion {
  transactionId: string;
  targetRevision: string;
  targetTreeHash: string;
  identitiesHash: string;
  localPlanHash: string;
}
export interface NormalizedPushJournal extends NormalizedPushPlan {
  phase:
    | "confirmed"
    | "remote_pending"
    | "local_pending"
    | "complete"
    | "superseded";
  verifiedTarget: { revision: string; revisionContentHash: string } | null;
  completion: NormalizedPushCompletion | null;
}
export type NormalizedPushPlanInput = Omit<
  NormalizedPushPlan,
  "schemaVersion" | "protocolVersion" | "localPlanHash" | "authorizationHash"
>;
export function sealNormalizedPushPlan(
  input: NormalizedPushPlanInput,
): Promise<NormalizedPushPlan>;
export function isNormalizedPushJournal(
  value: unknown,
): value is NormalizedPushJournal;
export function normalizedPushPaths(
  controlRoot: string,
  operationId: string,
): {
  operationRoot: string;
  remoteRoot: string;
  localRoot: string;
  payloadRoot: string;
  controlAfterPath: string;
  completionPath: string;
};
```

paths 严格推导为 `<controlRoot>/push/operations/<operationId>/{remote,local,payload,control-after.json,completion.json}`；Page payload 名以现有 `opaqueFileKey` 生成，禁止原路径直接拼进私有文件名。源正文按 UTF-8 长度校验，原字节证据和 canonical 暂存分别受已解析的 Page/累计能力上限约束。时间戳、临时 previewId 不进入语义 hash，身份和 raw/normalization 证据必须进入。

```ts
export type JournalPort<T> = Pick<
  MutableControlRepository<T>,
  "read" | "write" | "clear"
>;
export class PushJournalRouter {
  constructor(store: ControlStorePort, controlRoot: string);
  read(): Promise<MutableControlEnvelope<
    TreePushJournalV3 | NormalizedPushJournal
  > | null>;
  writeParent(journal: NormalizedPushJournal): Promise<void>;
  v3Port(): JournalPort<TreePushJournalV3>;
}
export class NormalizedPushRepository {
  constructor(store: ControlStorePort, controlRoot: string);
  stage(
    plan: NormalizedPushPlan,
    push: TreePushPreviewV3,
    candidate: TreeSnapshotV3,
    rawPageBytes: Record<string, Uint8Array>,
  ): Promise<void>;
  read(): Promise<NormalizedPushJournal | null>;
  loadConfirmed(journal: NormalizedPushJournal): Promise<{
    plan: NormalizedPushPlan;
    push: TreePushPreviewV3;
    candidate: TreeSnapshotV3;
  }>;
  write(journal: NormalizedPushJournal): Promise<void>;
  assertTerminal(journal: NormalizedPushJournal): Promise<void>;
  cleanup(journal: NormalizedPushJournal): Promise<void>;
}
```

`candidate` 暂存的 revision 仅承载源计算上下文，不当作发布结果；比较候选使用 revisionContentHash 与正文/引用/附件集合。`stage` 将候选及 wire Page payload 转存到父操作的受控 payload 子目录，重验 hash/长度/能力后原子写父 journal；父 journal 未 durable 前不能调用远端。

实施接口澄清：`stage` 的第四参数是映射相对路径到真实源 Page 原字节的完整集合，精确覆盖 `rawPathStates` 中 `pages/**/*.md` 文件。验证集合、原字节 hash、严格 UTF-8 与逐页/累计 raw 配额，canonical 暂存另行计量。原字节不落盘、不进入日志或网络。它弥补仅凭 hash 无法证明字节长度的接口缺口，不新增日志字段。Task 4 在完整授权重验后、stage 前从绑定 Vault/root 有界读取该集合；stage 再次比对 hash，拒绝读取竞态。已持久操作恢复不重新 stage 或采纳当前正文；Task 5 的扫描仍须前置独立 raw/canonical 限额。

- [ ] fixture 导出 `makeNormalizedPlanInput(rawText?: string): Promise<NormalizedPushPlanInput>`：固定 `op-1/tx-1`、`https://example.test`、`server-1/space-1/device-1/credential-1/vault-1/Wiki`，单 Page `pages/note.md`，默认原文 `![A](photo.png)` 与目标 `![A](../assets/photo.png)`，源 `rev-1`；可选 rawText 仅供测试 LF/CRLF 等价字节时覆写原文，使用真实解码/规范化及 hash 函数重建全部证据。使用空 v2 identity 状态和确定能力，不使用全零 hash 冒充可验证内容。fixture 的候选由 FakeTreeRemoteV3 seed 的真实快照取得，wire 使用既有 prepareTreePushChangesV3。
- [ ] 在已有形状校验最小实现上增加授权行为 RED：

```ts
it("binds original bytes even when canonical wire stays equal", async () => {
  const input = await makeNormalizedPlanInput("![A](photo.png)\n");
  const first = await sealNormalizedPushPlan(input);
  const changed = structuredClone(input);
  const newRawHash = await sha256Hex(
    new TextEncoder().encode("![A](photo.png)\r\n"),
  );
  changed.rawPathStates["pages/note.md"].hash = newRawHash;
  changed.localPlan[0].beforeHash = newRawHash;
  changed.normalizations[0].rawHash = newRawHash;
  // LF/CRLF 改变原字节，但 normalized 正文与 wire 相同；BOM 仍按现有规则拒绝。
  const second = await sealNormalizedPushPlan(changed);
  expect(second.authorizationHash).not.toBe(first.authorizationHash);
  expect(second.wireConfirmationHash).toBe(first.wireConfirmationHash);
});
```

- [ ] 运行 `npx vitest run tests/integration/normalized-push-storage.test.ts`；记录 raw evidence 未绑定导致相等的 RED，再实现以下 hash 分层：

```ts
const localPlanHash = await sha256Hex(
  canonicalBytes({
    localPlan: input.localPlan,
    normalizations: input.normalizations,
    rawPathStates: input.rawPathStates,
    identities: input.identities,
    scanEpoch: input.scanEpoch,
  }),
);
const authorizationHash = await sha256Hex(
  canonicalBytes({ ...input, localPlanHash }),
);
```

- [ ] 实现 strict schema 与语义约束：unknown keys/未来版本/非法路径/非 write_page/重复 Page/重叠目标/错误 hash/无界长度拒绝。local_only 不许 remote_pending；local_pending/complete 要 target；complete 要 completion。guard 仅证明形状，repository 再证明同 operation 的子日志、事务和历史 completion，不能凭 phase 成功。

取消边界澄清：local_only 的 local_pending 仅在没有远端子日志、存在同归属且精确绑定原 actions/raw 预条件/固定 source 的 deferred 本地事务、并已真实安全 rolled_back 时可转 superseded。保留回滚归属元数据，不写 completion 或改变 baseline/身份；prepared/applied/verified/committed/ambiguous 均不得伪装成取消。所保留 verifiedTarget 只能是原 sourceRevision/sourceTreeHash，不是新增发布证明。remote_push 已发布仍不能 supersede；writer 锁内重验全部证据。

- [ ] 根日志使用 union guard 读取 3/4 的全部 main/prev/next，再验证每个 envelope/hash 和等代际分叉；未知、损坏、错误归属全部 fail closed。旧 1/2 不进入 union service，保持原调度拥有。默认 TreePushServiceV3 构造器仍严格 schema3；增加第六个可选 `journalPort?: JournalPort<TreePushJournalV3>`。注入时 load/inspect 均走该 port，不再直接解析根文件而误拒绝 terminal4；未注入的升级/新远端子引擎行为完全不变。
- [ ] `v3Port().read()` 遇当前 4：仅在 `assertTerminal` 通过且保存历史 completion 凭据后返回 null；pending/伪 complete 拒绝。`write()` 重验根未变化，再用 union repository 递增 generation 写新3，不 clear4。反向3→4只允许 published+local verified 或权威 superseded 的3，保留旧 terminal envelope 于受控 operation 证据。注入 port 的 clear 只处理同拥有、权威未发布的活动3；不得删除 pending4 或历史完成凭据。按 controlRoot 串行化读-重验-写，避免两个 writer 抢占。
- [ ] 增加行为测试：1/2旧 dispatcher不改、strict3拒绝4、terminal3→4→terminal4→3、prev/next各排列、断在.next/rename、同代分叉、未来schema、corrupt高/低代、foreign operation、缺/改payload、丢completion、完成后用户编辑/新Pull仍terminal、pending无法替换。所有恢复重复两次，比较 generation 与写入事实，不只 assert guard true。
- [ ] 运行 storage 新测试及 `tests/integration/tree-push-service.test.ts`、`tests/integration/local-image-upgrade-storage.test.ts`、`tests/integration/local-image-upgrade-push.test.ts`，再 typecheck。仅 stage 本 Task 文件；提交 `feat(sync): persist normalized push plans with guarded journal transitions` 并审查。

## Task 3: 独立本地提交器与完成凭据

**Files:** 新增 normalized-push-local 及其测试，扩展 fixture；必要时从 tree-local-apply-v3 提取同一身份提交逻辑；不重写 tree-transaction 或 baseline 算法。

**Interfaces:** 消费 Task 2 plan/journal/paths，既有 VaultPort、ControlStorePort、TreeBaselineRepository、TreeIdentityRepository。新模块导出：

```ts
export class NormalizedPushLocalCommitter {
  constructor(input: {
    vault: VaultPort;
    control: ControlStorePort;
    controlRoot: string;
    baseline: TreeBaselineRepository;
    identities: TreeIdentityRepository;
  });
  apply(
    journal: NormalizedPushJournal,
    target: TreeSnapshotV3,
  ): Promise<NormalizedPushCompletion>;
  recover(
    journal: NormalizedPushJournal,
    target: TreeSnapshotV3,
  ): Promise<NormalizedPushCompletion>;
  assertComplete(journal: NormalizedPushJournal): Promise<void>;
}
```

fixture 增加 `makeNormalizedLocalFixture(): Promise<{journal: NormalizedPushJournal; target: TreeSnapshotV3; vault: MemoryVault; control: MemoryControlStore; baseline: TreeBaselineRepository; local: NormalizedPushLocalCommitter}>`，基于 Task 2 同一数据组装真实仓库，初始 raw 笔记和源 baseline 都真实存在。

- [ ] 增加 RED：使用暂时只返回完成对象的占位实现，真实 Vault 字节断言必须失败；随即替换该实现，不保留伪完成路径。

```ts
it("writes canonical bytes before claiming local completion", async () => {
  const f = await makeNormalizedLocalFixture();
  await f.local.apply(f.journal, f.target);
  const bytes = await f.vault.read("Wiki/pages/note.md");
  expect(new TextDecoder().decode(bytes!)).toBe("![A](../assets/photo.png)");
  await expect(f.local.assertComplete(f.journal)).resolves.toBeUndefined();
});
```

- [ ] 运行 `npx vitest run tests/integration/normalized-push-local.test.ts` 并记录正文仍为短链接的 RED。
- [ ] materialize 仅本地 write_page：校验 fixed target 对应 PageID/path/hash/body 与计划一致，读取受控 payload，确认原 raw CAS 状态；构建带真实 raw precondition 的 TreeTransactionInput，`deferCommit: true`，固定 localTransactionId。已存在子事务先 assertPreparedOwnership，不重新创建猜测计划。

```ts
await tx.prepare(transactionInput, journal.localTransactionId);
// 同 transactionId 的 control-after 必须先 durable，再执行第一个 Vault write。
await tx.apply();
await tx.assertApplied();
await tx.markVerified();
// 接下来复用 baseline.prepare/recover 与 applyV3ControlAfter；最后 markCommitted。
```

- [ ] 所有实际写入由 tx 独占。按真实文件 bytes 比较 canonical body/hash，不调用会虚拟规范化的 scan 来冒充写回。身份后状态使用既有 desiredV3Identities 规则保留其他页面晚编辑/pending；不要求整个 Vault 等于远端。baseline 使用同 transactionId 的 prepare→applying→recover，身份提交后才 markCommitted。
- [ ] control-after 同时绑定 target revision/hash 与 localPlanHash；复用既有状态模型时在本操作独立 metadata 中保存这些绑定。markCommitted 之后写 `completion.json`；它包含 NormalizedPushCompletion，只有从 committed tree、已应用 control-after 和对应 baseline 事务完成事实交叉验证才能生成。崩溃在 baseline提交至completion生成期间仍由同事务恢复。完成后验证历史凭据，不因用户后续编辑或新 baseline 拒绝旧 terminal。不得依赖已合法清理的正文 sidecar。
- [ ] 故障测试逐个中断：prepare前/后、control-after写后、第一/最后Page写后、markVerified前/后、baseline prepare/切换后、身份写前/后、markCommitted后/completion前。复用 MemoryControlStore 写入异常和 MemoryVault failAfterOperations；重建同 ports 的 committer，不复用内存成功状态。
- [ ] 晚编辑测试：CAS前变更→原文件保留且旧baseline；rollback时第三方改动→ambiguous不覆盖；只是碰巧正文等于canonical但无所属事务→不能冒认完成；未规范化的其他Page编辑保持pending。部分应用未verified依 TreeTransaction 回滚自己的写入；恢复后同 tx 可重放原计划，不能换operation/目标。
- [ ] 运行新测试、`tests/integration/tree-transaction.test.ts`、`tests/integration/local-image-upgrade-local.test.ts` 和 typecheck。仅 stage 本 Task 文件；提交 `feat(sync): commit normalized pages through recoverable local transactions` 并审查。

## Task 4: 普通 Push 父协调器及 local_only

**Files:** 新增 application/normalized-push 与 normalized-push 集成测试，扩展 fixture；消费 Tasks 1–3，不启用生产 Runtime。新父协调器不得持有另一套 session/result/receipt 字段。

**Interfaces:** `TreeRemotePortV3`、`SyncOperationOptions` 和既有 TreePushServiceV3 都直接使用现有导出。明确依赖契约：

```ts
export interface NormalizedPushAuthority {
  // 重验服务器/Space/device/credential/Vault/root，head/caps/权限及完整本地授权。
  // 返回值必须等于已持久 plan.authorizationHash，不能只返回 wire hash。
  revalidate(plan: NormalizedPushPlan): Promise<string>;
  // 固定 revision 的完整快照读取；禁止内部替换成当前 head。
  readTarget(revision: string): Promise<TreeSnapshotV3>;
}
export class NormalizedPushCoordinator {
  constructor(input: {
    remote: TreeRemotePortV3;
    vault: VaultPort;
    control: ControlStorePort;
    controlRoot: string;
    repository: NormalizedPushRepository;
    local: NormalizedPushLocalCommitter;
    authority: NormalizedPushAuthority;
  });
  confirm(
    plan: NormalizedPushPlan,
    push: TreePushPreviewV3,
    candidate: TreeSnapshotV3,
    options?: SyncOperationOptions,
  ): Promise<void>;
  recover(options?: SyncOperationOptions): Promise<void>;
  cancel(): Promise<void>;
  inspect(): Promise<NormalizedPushJournal | null>;
}
```

fixture 增加 `makeNormalizedCoordinatorFixture(mode: "remote_push" | "local_only")`，返回 `{plan, push, candidate, vault, control, remote, coordinator, rebuild}`；前七项使用上述真实类型，`rebuild(): NormalizedPushCoordinator` 只重新组装相同端口/authority，不继承内存 journal。local_only 的 fixed source 已含 canonical Page，raw Vault 仍短链接；remote_push 源含旧名图片，candidate 改名但 ID/bytes 保持。fixture 的 authority 用实际 scan 和 hash 计算，不永久回传预期 hash 来跳过失效测试。

- [ ] 增加 local_only 行为 RED，先证明现有“wire 空即返回”路径没有完成本地写回：

```ts
it("local-only changes require no publication but do commit the file", async () => {
  const f = await makeNormalizedCoordinatorFixture("local_only");
  const before = await f.remote.head();
  await f.coordinator.confirm(f.plan, f.push, f.candidate);
  expect(
    new TextDecoder().decode((await f.vault.read("Wiki/pages/note.md"))!),
  ).toBe("![A](../assets/photo.png)");
  expect(f.remote.createInputs).toEqual([]);
  expect(f.remote.uploadedChunkIndexes).toEqual([]);
  expect(f.remote.finalizeCalls).toBe(0);
  expect((await f.remote.head()).revision).toBe(before.revision);
  expect(await f.coordinator.inspect()).toMatchObject({
    mode: "local_only",
    phase: "complete",
  });
});
```

- [ ] 运行 `npx vitest run tests/integration/normalized-push.test.ts` 记录正文未写回失败；随后实现 confirm 固定输入重验→repository.stage→recover。两计划均空由调用者当 no-op，不允许创建空父操作。
- [ ] remote_push 在派生的 remoteRoot 构造原 TreePushServiceV3。使用原 ownership 参数固定 operationId/idempotencyKey；`assertSourceCurrent` 调完整 authority.revalidate，`revalidateConfirmation` 也验证完整本地授权后返回原 wire confirmationHash。onStaged 持久 remote_pending。原服务自身的 create/finalize、丢响应、能力变化和 abort 规则继续生效。
- [ ] Finalize 返回后固定读取该 revision，以 protocol 校验、candidate hash、实际 Page body/reference manifest、attachment 集合验证目标。不能只比较返回的 hash 字符串，也不能在 finalization未知时用 current head 冒充结果。local_only 则固定读取 sourceRevision 并证明受影响 Page 等于 canonical plan；禁止构造远端子日志。

```ts
// 两种 mode 仅在目标取得方式不同；共同走同一个本地提交边界。
await repository.write({ ...journal, verifiedTarget, phase: "local_pending" });
const completion = await local.recover(
  { ...journal, verifiedTarget, phase: "local_pending" },
  target,
);
// remote_push 此时才调用既有 child.markVerified()；local_only 没有 child。
await repository.write({
  ...journal,
  verifiedTarget,
  completion,
  phase: "complete",
});
```

- [ ] 写 complete 前由 repository 验证 child published+locally verified（remote_push）和同 tx completion；清理只删本 operation 不再需要的 payload，保留终态证明和 committed tree/control-after 元数据。child 自己 cleanup 不可越过其 remoteRoot。
- [ ] 恢复按规格第 6 节逐行实现。create 成功响应丢失沿固定 key，Finalize 成功响应丢失查询同 session，unknown 保持 pending。已 published 而 local CAS失败显示已发布本地待处理，不能重复发布/提交baseline。local_only 的晚编辑仍保留固定source，不追逐新head，文案明确“未发布云端版本”。
- [ ] cancel 测试覆盖：confirmed无child、上传可证abort、Finalize未知、已published、local_only未应用/部分应用/committed。只能权威未发布+安全本地终态 supersede，published 不可假取消；缺凭据/网络未知/foreignchild 均保存证据并阻塞。
- [ ] 增加 remote_push 与 local_only 对称 fault table：父stage写后、child stage后/create response丢失、batch后、finalize response丢失、fixedtarget读失败、local_pending写后、Task3每个本地断点、child.markVerified后、parent.complete后cleanup中断。每个用 rebuild 恢复两次；断言 session/key唯一、远端revision只增加一次或零次、文件实际结果、baseline/identity一致。
- [ ] 运行新测试、Task2/3测试、既有 tree-push-service 与 local-image-upgrade-push；typecheck。仅 stage 本 Task 文件；提交 `feat(sync): coordinate durable normalized pushes and local-only repairs` 并审查。

## Task 5: 完整生产接线、Pull/升级与预览 UI

**Files:** 修改职责表 Task5 的文件；扩展 `tests/unit/tree-scan.test.ts`、`tests/unit/preview-logic.test.ts`、`tests/unit/protocol-negotiator.test.ts`、`tests/integration/plugin-settings-lifecycle.test.ts`、`tests/integration/preview-modal-interactions.test.ts`、`tests/integration/local-image-upgrade-plan.test.ts`、`tests/integration/local-image-upgrade-entry.test.ts`；新增 normalized-push-runtime 测试。只在本 Task 成功后开启生产规范化。

**Interfaces:**

```ts
// LocalTreeScanV3 新增字段；所有测试/升级构造点必须明确 []，不能 undefined。
normalizations: LocalImageNormalization[];
// 原 PublishablePushPreviewV3 新增字段；普通旧路径为 null。
normalizedPush: { plan: NormalizedPushPlan; candidate: TreeSnapshotV3 } | null;
// BlockedPushPreviewV3 同时增加 normalizedPush: null，保持可判别 union。
// 新文件 normalized-push-plan 导出，供普通Push/Pull/升级统一构造真实写动作。
export function retainNormalizedPageWrites(input: {
  actions: TreePullActionV3[];
  finalPages: TreePageV3[];
  normalizations: LocalImageNormalization[];
  rawPathStates: LocalTreeScanV3["rawPathStates"];
}): TreePullActionV3[];
export interface NormalizedRuntimeAuthority {
  serverOrigin: string; serverInstanceId: string; deviceId: string;
  credentialId: string; vaultId: string;
}
// SyncRuntime 新增一次性配置入口，由 production factory 在缓存插入前调用。
configureNormalizedPush(authority: NormalizedRuntimeAuthority): void;
```

配置入口只接受非秘密 ID；同 runtime 再传不同 authority 必须使旧preview失效并拒绝复用。不具备全部 authority 的旧 test/runtime仍可走无本地规范化的严格旧路径；不能填造默认身份来激活新功能。Task5 production factory 必须实际传入完整 authority。底层 scan 保持无业务写入，调用方没有可恢复本地所有者时不传 resolver；不允许“做了 canonical scan 却走旧 finishV3Push”。

为使启用门可测试，在 tree-scan 两个 overload 和实现的既有第六参数 onProgress 后加第七个可选参数 `options?: { normalizeShortestImages?: boolean }`，缺省为 false。只有已具备本地事务所有者的普通v3、Pull、首次升级扫描传 true；v1/v2和真实写后校验仍false。旧确认升级记录的 `UpgradeLocalPlanEvidence` 新增可选 `normalizations?: LocalImageNormalization[]`：新的预览总是写入该字段（含空数组）并散列，旧持久记录缺省不补入旧hash，不启用新修正；不得以反序列化默认值改变已确认旧授权。

- [ ] 在 fixture 导出 `makeNormalizedRuntimeFixture(mode: "remote_push" | "local_only")`，返回 `{runtime: SyncRuntime, vault: MemoryVault, control: MemoryControlStore, remote: FakeTreeRemoteV3, rebuild: () => SyncRuntime}`。使用实际 `SyncRuntime.v3`、真实 baseline/identity repository；先 canonical 初始 Pull建立base，再模拟原生rename为短链接/保持附件ID；resolver 来自 Task1端口，authority来自固定非秘密测试身份。不要直接构造父journal来冒充入口测试。
- [ ] 在 normalized-push-runtime 写以下 RED：

```ts
it("ordinary runtime preview stays read-only and confirmation persists the local repair", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  const before = await f.vault.read("Wiki/pages/note.md");
  const preview = await f.runtime.previewPushV3();
  expect(await f.vault.read("Wiki/pages/note.md")).toEqual(before);
  expect(preview.changes).toEqual([]);
  expect(preview.normalizedPush?.plan.localPlan).toHaveLength(1);
  await f.runtime.applyPushV3(preview);
  expect(
    new TextDecoder().decode((await f.vault.read("Wiki/pages/note.md"))!),
  ).toBe("![A](../assets/photo.png)");
  const next = await f.runtime.previewPushV3();
  expect(next.changes).toEqual([]);
  expect(next.normalizedPush).toBeNull();
  expect(f.remote.finalizeCalls).toBe(0);
});
```

- [ ] 运行 `npx vitest run tests/integration/normalized-push-runtime.test.ts`，记录既有短链接blocker或local plan为空的行为RED。
- [ ] 在 scan Page生成前调用 Task1 normalize；rawPathStates已从原 bytes取值，不覆盖。canonical body用于contentHash/reference manifest，证据按path排序。引用集合确定后才读取图片；未引用资产只读路径元数据。将原字节总量与canonical总量分别套用已有上限；再验证身份和路径碰撞。
- [ ] Runtime preview先检查pending4，再读head/base/caps/scan；为本地修正分配operation/txid、暂存bounded payload、seal plan并展示。operationId/payload路径在seal前固定，确认stage不得改变已授权路径。apply在任何RPC前重新扫描并比对raw/normalization/identity/authority/caps/head；不按wire hash相同就自动重建授权。

```ts
if (preview.normalizedPush !== null) {
  await coordinator.confirm(
    preview.normalizedPush.plan,
    preview,
    preview.normalizedPush.candidate,
    options,
  );
  return;
}
if (preview.changes.length === 0) return;
// 无规范化继续原 schema3 service，但根journal使用 Task2兼容 writer。
```

- [ ] 新父操作不能调用现有先提交baseline的 `finishV3Push`。recover、最低协议、status/cancel、删除mapping/断开、正常Pull、首次升级入口统一先处理pending4；只检查 main schemaVersion 的旧分支替换为已验证candidate调度。旧1/2原所有者、旧3原语义；未知/foreign/corrupt日志导致所有破坏性入口拒绝并保留credential/mapping。schema4最低wire版本是3，不是4。
- [ ] `retainNormalizedPageWrites` 根据 finalPages PageID/path/body 与 raw预条件计算，仅为实际仍需写入的Page补 write_page；已有create/write/move动作按已有排序/归属规则去重与重算，不能多写同一路径。final冲突选择remote/delete/manual/keep-both之后再计算，不能把丢弃的local正文复活；删除或移走的Page不使用旧路径进行强制写入。
- [ ] Pull将normalizations并入冻结/确认证据和raw CAS，实际write_page不能被虚拟相等diff删掉；首次升级将证据加到 UpgradeLocalPlanEvidence、semanticLocal、confirmed preview materialization/hash。旧confirmed upgrade没有新增证据的恢复只按旧规则读取，不能赋予短链接修正新授权；新增字段有版本/存在性判别，不破坏旧持久fixture。现有升级父拥有计划，绝不能再次创建普通schema4父。
- [ ] main创建单一 metadata resolver索引并复用，每个mapping绑定受限root；用插件registerEvent的create/delete/rename监听invalidate，preview缓存scanEpoch随同失效。metadata resolve每次仍调用public cache并确认唯一实际目标。插件卸载清理监听；不修改Obsidian配置。main真实factory配置authority，runtime缓存命中时保持其entry/事件订阅一致。
- [ ] UI预览显示“本地图片链接修正”+Page数+mapping相对路径；确认条件为wire非空或localPlan非空且无blocker/未决冲突。local_only按钮“确认修正本地链接”；状态“本地链接修正待处理，未发布云端版本”。remote_push已发布本地阻塞则“远端已发布，本地待处理”，提供查看文件/重试；未终结操作禁用新预览覆盖和错误取消。
- [ ] 扩展UI实际DOM交互测试：wire空但localPlan非空可确认；取消预览没有RPC/Vault写；preview打开后rename/create同名导致确认禁用或revalidate拒绝；small-screen分页/异步resolver不丢计数；旧升级modal仍只有一次确认。
- [ ] scanner测试确认raw与canonical hash不同、未引用read为零、重复scan无业务写，Pull/upgrade最终选择均尊重且普通v1/v2不开始传图。运行上述新增/修改测试、Task1–4测试和 `npm run check`。本任务所有路径通过才提交 `feat(sync): wire normalized image links through sync previews and recovery` 并审查。

## Task 6: 生产入口故障矩阵与独立总审查

**Files:** 扩展 normalized-push-runtime、现有 local-image-upgrade-entry/plan/recovery-verifier 和 plugin-settings-lifecycle 测试；新增 acceptance证据文档。产品修复只允许针对独立发现、带行为RED的明确问题，另行审查，不借测试任务扩大产品范围。

**Interfaces:** 消费 Task5 fixture 的真实 runtime/rebuild，Fault injection只包裹现有FakeTreeRemoteV3/MemoryControlStore/VaultPort的真实方法。记录实际 `createInputs`、`finalizeCalls`、`uploadedChunkIndexes`、`operationLog`，不要只断言coordinator phase。

- [ ] 增加published后的晚编辑测试，先在未保护实现上见到覆盖/错误baseline推进RED；如果现有代码已经保护成功，记录该回归PASS，不制造假RED。

```ts
it("keeps edits made after publication and never republishes during recovery", async () => {
  const f = await makeNormalizedRuntimeFixture("remote_push");
  const preview = await f.runtime.previewPushV3();
  f.remote.onFinalize = () =>
    f.vault.seedMarkdown("Wiki/pages/note.md", "my late edit");
  await expect(f.runtime.applyPushV3(preview)).rejects.toThrow();
  const publishedCalls = f.remote.finalizeCalls;
  await expect(f.rebuild().recover()).rejects.toThrow();
  expect(
    new TextDecoder().decode((await f.vault.read("Wiki/pages/note.md"))!),
  ).toBe("my late edit");
  expect(f.remote.finalizeCalls).toBe(publishedCalls);
});
```

还要断言旧baseline不推进、持久父是local_pending、原子计划仍在；错误不是任意异常就合格，使用实际实现的专用错误码。onFinalize注入点如在服务提交前，补充包装真实finalize成功返回后再编辑的case以证明严格“已发布”时间边界。

- [ ] 运行 `npx vitest run tests/integration/normalized-push-runtime.test.ts tests/integration/local-image-upgrade-entry.test.ts tests/integration/local-image-upgrade-plan.test.ts tests/integration/local-image-upgrade-recovery-verifier.test.ts tests/integration/plugin-settings-lifecycle.test.ts`。
- [ ] 将Task2/3/4全部故障断点在真实Runtime入口关键代表路径重测，特别是响应丢失不是HTTP错误：先让fake返回合法成功并持久远端状态，再丢返回值，重建runtime恢复。验证固定session/idempotencyKey/返回revision、不追新head、stable attachmentId、同bytes不重传、下一次完整sync无动作。
- [ ] lifecycle矩阵：旧1/2/3恢复、terminal4后ordinary3、pending4阻断Pull/upgrade/newPush/删除mapping/断开、轮换credential/不同Vault/root/Space；不得读或输出秘密。纯local_only恢复后再Pull新head，恢复本身远端mutation计数为0。
- [ ] review原遗留项并记录逐项结果：Task19 I1真实production factory协商；I2/I3引用既有关闭证据不重复修复；Task12parser parity/last-reference零读取；Task16runtime职责；Task18async resolver分页；U6entry职责；17既有lint warning归属；single-page keep-both非空proper-subset限制是否符合已确认规格。不能把“延后”当作已修复。
- [ ] 执行 `npm run check` 与 `env -u npm_config_allow_scripts npm audit --json`；日志写入本次唯一临时目录，记录命令exit、测试文件/断言数、格式/type/build/bundle、lint errors/warnings和audit漏洞数。用 `mktemp -d /tmp/agentwiki-shortlinks-final.XXXXXX` 创建目录，不能复用旧日志冒充结果。
- [ ] 本 Task 测试与文档提交 `test(sync): cover normalized push recovery and lifecycle boundaries`。冻结commit，按实际新提交创建不可变diff，独立whole-branch review范围 `de1582cc541b32a308554c178a3ce385827f8054..HEAD`；保留每Task及每次fix审查。不并行进行同文件写入与最终审查；审查后有产品修改则重新冻结、复跑受影响门。

## Task 7: 同候选真机、公网恢复和 0.4.0 发布

**Files:** 只更新新的 acceptance文档及既有对应 verification文档；读取 `verification/local-image-upgrade.live.ts`、`verification/local-image-upgrade-recovery.ts`、`.github/workflows/release.yml`、`scripts/check-release.mjs`。本 Task 不默认新增产品代码；真机发现问题先回到归属Task做RED/修复/复审/重冻。

**Interfaces:** 继续使用现有live verifier provider契约：serverOrigin，spaceIds.populated/empty，serverLabel，cleanupOwner，recoveryCases.create/finalize（各自spaceId/rootPath/controlRoot/authority/control/vault），以及受限request。不得替换成fake provider来让公网门变绿。

- [ ] 建立验收矩阵，每一项记录“候选commit、bundle SHA256、环境、操作、权威事实、PASS/FAIL/NOT_RUN、证据路径”。桌面、Android、公网、GH release各列分开；health、页面打开、插件版本显示均不是完整sync证据。
- [ ] 安装前重新检查桌面/ADB实际连接与用户是否正在使用；锁屏/别的app不绕过。仅已授权的桌面隔离Vault与Android `NeoMei-Docs` 内 `U7Android70bf4ae` 合成映射，保留原 `wiki` 及其余映射。备份目标插件原main/manifest/styles，不复制或输出data.json凭据；安装最终候选后重开并验证实际manifest0.4.0和三文件hash，确认加载的是新bundle。
- [ ] Android原失败笔记 `U7Android70bf4ae/pages/Android First Image Baseline.md` 保持原始 `![Android local image](u7-renamed.png)`，禁止手工改为相对路径绕过。预览显示本地修正，确认后真文件成为标准相对引用，web固定版本与Android均显示图；附件ID沿旧身份保持，同bytes不上传，未引用 `u7-unreferenced.png` 没有上传/读字节。再完整同步验证零动作。
- [ ] 同bundle桌面与手机补齐：从新合成纯文字Space首次图片升级、服务器图片下载、原生rename/链接更新、含特殊字符/子目录Page、窄屏确认/冲突分页、网络断开/恢复、插件/应用完整重启后恢复。离线证明必须注明阻断WebView还是native requestUrl；重启后断网读本地图片与同步失败行为分别记录，恢复网络用finally。不能把旧WebView单session读图算完整进程离线验收。
- [ ] 通过真实登录/受控本地renderer provider新建或使用准确归属的合成Spaces：populated legacy、empty legacy、create-success-response-loss、finalize-success-response-loss四个独立Space。已有已升级的Space不能冒充legacy；不得修改真实用户Space权限/读取token。provider缺少字段或transport不可用时记录NOT_RUN和具体所缺用户动作。
- [ ] 在受控provider经过上述归属/接口核验后，把它的实际绝对路径设为 `AGENTWIKI_UPGRADE_LIVE_CONTEXT_MODULE`；执行下面命令，不使用过期/tmp provider。create 201与finalize 200响应丢失后用同ports生产Entry重建，证明同operation/session、版本仅+1、完整baseline/identity/parent terminal。原子升级失败前后无半套数据，现有空/非空四项与丢响应两项必须全部记录。

```bash
test -n "$AGENTWIKI_UPGRADE_LIVE_CONTEXT_MODULE"
npx vitest run --config vitest.live.config.ts
```

- [ ] 真实门和whole-branch发现全部处理后再运行最终check/audit，记录最终构建asset hash；需要修复则旧设备验收只保留为历史，至少重跑受影响完整链路，不混用bundle。以下命令读出将发布的真实资产：

```bash
git status --short
git rev-parse HEAD
npm run check
env -u npm_config_allow_scripts npm audit --json
shasum -a 256 main.js manifest.json styles.css
```

- [ ] 恢复既有用户授权的发布流程前核验remote/main、最新release、0.4.0 tag是否已存在、版本文件一致、无未review代码。若tag已存在，不覆盖；比较其commit/assets决定是否已经发布或需要新版本授权。合并/推送只带已review提交，保留用户未跟踪证据；按原分支整合策略处理main，不force push。
- [ ] 所有门通过且main指向冻结候选后，使用数值tag `0.4.0` 触发现有release workflow，不能另开手工release竞态。跟随workflow完成，核验GH Release三资产、attestation、下载hash与冻结产物、fresh真实Vault安装后实际版本/启用状态。若workflow重复构建因非确定性有hash差异，查明差异并重新验实际发布资产，不能称同bundle通过。
- [ ] 独立报告插件GitHub发布、Obsidian社区目录状态、Local Sync npm版本、server部署状态。社区目录存在不等于Obsidian员工完成手工审核；本地修复不需要无关server重部署。server/npm仅只读核验，不沿用旧记忆作当前状态。
- [ ] 最终文档提交 `docs(sync): record final image sync acceptance and release evidence`。只有全部必需门为PASS且真实发布资产验过才报告完成；外部环境不可达则报告剩余NOT_RUN，不宣称“彻底做完”。不删除旧日志、笔记、回滚证据或合成Space，除非用户另行授权清理。

## 执行前自查与规格覆盖

| 规格要求                                 | 实现/验证任务 | 必须可观察的证据                                  |
| ---------------------------------------- | ------------- | ------------------------------------------------- |
| §1窄范围、无未引用字节读取/无preview写   | 1、5、7       | read/write audit及真实未引用图片                  |
| §2公共parser不变、metadata唯一性、ranges | 1、5          | conformance、NFC/casefold重名、正文精确断言       |
| §2 raw/canonical分离、确认新碰撞         | 1、2、5       | raw hash与确认失效测试                            |
| §3身份/授权/配额/冻结payload             | 2、5          | raw或identity变动拒绝、受控sidecar、双配额        |
| §4父/子职责与schema代际                  | 2、4、5、6    | strict3/4、混代次序、旧恢复不追认                 |
| §4终态不依赖当前Vault或已清sidecar       | 2、3、4       | 后续编辑/Pull后历史complete仍成立                 |
| §5固定目标和真实本地先验证再baseline     | 3、4、6       | 故障注入顺序、真实bytes/CAS/baseline断言          |
| §5 local_only有确认且零远端mutation      | 4、5、6       | session/blob/finalize计数0、revision不变          |
| §6每个中断、取消、晚编辑/rollback归属    | 3、4、6       | 重建ports恢复两次、第三方字节保留                 |
| §7Pull/升级复用父、最终选择决定动作      | 5、6          | 保留write_page、不复活discarded local、旧版本回归 |
| §8模块内聚/不复制引擎                    | 1–6           | 任务审查与whole-branch职责复核                    |
| §9Android原样例/桌面/公网/发布门         | 6、7          | 同候选矩阵、独立review、实际release资产           |

计划自查要求：每个新导出在本计划有唯一签名，所有生产接线消费相同名字；Task1–4默认未启用；schema4完成后3writer兼容而不是清日志；local_only绝不伪造publication；所有失败路径保留原计划/证据。执行者若发现类型实际不匹配，先修正计划接口并记录具体差异，不能让后续任务猜另一个同名接口。

## 执行交接

建议选择 **Subagent-Driven**：本任务内每项使用新的实现子代理与独立两阶段审查，控制器负责真实设备、公网、最终冻结和发布；不用另建用户任务。另一选项为 **Inline Execution**：按 executing-plans 在当前会话逐项执行并设置审查检查点。

用户选择执行方式后才开始 Task 1；本次计划完成不更改产品、手机、服务器或发布状态。
