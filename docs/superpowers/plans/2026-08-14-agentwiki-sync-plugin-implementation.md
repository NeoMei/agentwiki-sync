# AgentWiki Sync Obsidian Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 交付可安装、可测试、移动端兼容的 AgentWiki Sync Obsidian 社区插件，完整实现人工连接、Status、Pull、Push、首次绑定、本地事务恢复和原生 UI。

**Architecture:** 采用函数式纯核心 + 端口/适配器架构。`src/core` 只处理确定性规范化、身份、状态、合并和计划；`src/storage` 实现不可变 generation、三副本 envelope 与 journal；`src/agentwiki` 集中承载公开同步契约和 HTTP；`src/application` 编排事务；`src/obsidian` 是唯一依赖 Obsidian API 的层。上游 `@neomei/agentwiki-sync-protocol` 尚未发布，因此本仓只实现契约所需的客户端兼容层，不读取或复制 AgentWiki 主项目内部代码；包发布后由一项 adapter conformance 测试替换该边界。

**Tech Stack:** TypeScript strict、Obsidian API 1.11.5、esbuild、Vitest、Zod、node-diff3 3.x、Web Crypto、npm lockfile、Node.js 24 LTS。

## Global Constraints

- `manifest.json` 固定 `minAppVersion: "1.11.5"`、`isDesktopOnly: false`，运行时不得使用 Node 内置模块、Shell、daemon 或 `FileSystemAdapter`。
- 插件加载、文件事件和闲置时不联网；只有用户执行 Status/Pull/Push 或连接动作才联网。
- 原始文件、credential、安装码和未确认内容不得自动上传；所有远端写入必须先展示确认预览。
- 每个 Space 独立串行；Push 前远端 head 必须等于 base；Pull/Push 事务可在每个持久化点崩溃恢复。
- v1 限制：单页 1 MiB、Space 5,000 页、正文 100 MiB、revision manifest 4 MiB、confirmation 4 MiB、额外目标 heap 32 MiB。
- Vault 可见 Markdown 只通过 `Vault/FileManager/MetadataCache`；隐藏 `.agentwiki/` 只通过 `DataAdapter` 的 Vault 相对路径。
- AgentWiki 主项目保持只读；真实端到端只接受已发布公开 API/协议包，缺失时使用本仓 fake remote 验证客户端行为并明确记录外部依赖。

## File Structure

- `src/agentwiki/protocol/`：公开 v1 DTO、严格响应验证、canonical/hash、路径与批次算法；未来唯一替换点。
- `src/agentwiki/client.ts`：`requestUrl` 无重定向假设、认证、分页、Push session 和结构化错误。
- `src/core/`：正文、路径、身份、status、diff3、首次绑定、Pull/Push 计划。
- `src/storage/`：Control Store、DeviceLocalState、generation、envelope、Pull/Push journal 与恢复。
- `src/application/`：连接、Status、Pull、Push 和映射用例；每 Space mutex、取消和进度。
- `src/obsidian/`：Vault/Secret/LocalStorage 适配器、设置页、同步中心、冲突视图。
- `tests/fakes/`：内存 Vault/DataAdapter/SecretStorage/fake AgentWiki。
- `tests/unit|integration|performance/`：纯核心、故障注入、用户流程与预算门禁。

---

### Task 1: 工程骨架与发布门禁

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `esbuild.config.mjs`, `manifest.json`, `versions.json`, `styles.css`, `src/main.ts`, `tests/setup.ts`, `.github/workflows/ci.yml`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `npm run test|typecheck|lint|build|check`；Obsidian 默认导出 `AgentWikiSyncPlugin`。

- [x] **Step 1: 写失败的发布元数据测试**

```ts
test("manifest is mobile compatible", () => {
  expect(manifest.minAppVersion).toBe("1.11.5");
  expect(manifest.isDesktopOnly).toBe(false);
});
```

- [x] **Step 2: 运行 `npm test -- tests/unit/release-metadata.test.ts`，确认因工程文件缺失失败。**
- [x] **Step 3: 创建 strict TypeScript、Vitest、ESLint、esbuild 和最小插件入口；`onload()` 只注册设置页/命令，不联网。**
- [x] **Step 4: 运行 `npm run check`，预期测试、lint、typecheck、build 全通过。**
- [x] **Step 5: 提交 `chore: scaffold Obsidian plugin`。**

### Task 2: 公开协议兼容边界

**Files:**
- Create: `src/agentwiki/protocol/types.ts`, `schemas.ts`, `canonical.ts`, `hash.ts`, `limits.ts`, `batching.ts`, `index.ts`
- Test: `tests/unit/protocol-canonical.test.ts`, `protocol-schemas.test.ts`, `protocol-batching.test.ts`

**Interfaces:**
- Produces: `canonicalBytes(value): Uint8Array`, `sha256Hex`, `contentHash`, `confirmationHash`, `revisionContentHash`, `capabilitiesHash`, `parseDecimalCount`, `partitionPushChanges` and all client DTOs.

- [x] **Step 1: 写固定 fixture 的失败测试，断言 `Hello\n` content hash、confirmation hash、batch hash、428 bytes 和 Unicode key 顺序。**
- [x] **Step 2: 运行三份协议测试，确认函数不存在或 fixture 不匹配。**
- [x] **Step 3: 用 Web Crypto 与严格 canonical JSON 实现最小协议函数；拒绝 float、undefined、循环和未配对 surrogate。**
- [x] **Step 4: 写 Zod response schema，响应允许未知字段、request 拒绝未知字段；decimal count 先解析 bigint。**
- [x] **Step 5: 实现同时受 item/body byte 限制的确定性 batching，并运行全部协议测试。**
- [x] **Step 6: 提交 `feat: add sync protocol compatibility boundary`。**

### Task 3: Markdown、可移植路径和安全文件键

**Files:**
- Create: `src/core/markdown.ts`, `src/core/portable-path.ts`, `src/core/identity-key.ts`, `src/core/errors.ts`
- Test: `tests/unit/markdown.test.ts`, `portable-path.test.ts`, `identity-key.test.ts`

**Interfaces:**
- Produces: `decodeVaultMarkdown(bytes)`, `normalizeMarkdown`, `validatePortablePath`, `portablePathKey`, `titleFromPath`, `idFileKey`.

- [x] **Step 1: 写 BOM、非法 UTF-8、CRLF/LF、末尾换行、Windows 保留名、NFC/casefold、段/总字节和 `.md` 扩展名失败测试。**
- [x] **Step 2: 运行测试确认失败原因是缺少校验。**
- [x] **Step 3: 实现严格 UTF-8 与正文 hash；实现 Unicode NFC、固定 casefold 表所需映射和可移植路径校验。**
- [x] **Step 4: 增加 `Straße/İ.MD → strasse/i\u0307.md`、COM¹/LPT³ 和 hash 文件键 fixtures 并跑绿。**
- [x] **Step 5: 提交 `feat: validate portable vault content`。**

### Task 4: 领域模型、扫描与 Status

**Files:**
- Create: `src/ports/vault.ts`, `src/core/model.ts`, `src/core/scan.ts`, `src/core/identity.ts`, `src/core/status.ts`, `src/core/space-limits.ts`
- Test: `tests/unit/scan.test.ts`, `identity.test.ts`, `status.test.ts`, `space-limits.test.ts`

**Interfaces:**
- Consumes: Task 2–3 hash/path functions.
- Produces: `VaultPort`, `scanMapping()`, `resolvePageIdentities()`, `computeStatus()`, `assertSpaceWithinCapabilities()`.

- [x] **Step 1: 写不完整扫描不得产生 archive、5,001 页/100 MiB/4 MiB 阻塞、scanEpoch 变化失效测试。**
- [x] **Step 2: 写 path 优先、move hint、唯一 hash fallback、歧义与跨 Space 新 ID 测试并确认红。**
- [x] **Step 3: 实现流式扫描和身份解析，只在完整扫描上计算 added/modified/renamed/deleted。**
- [x] **Step 4: 实现远端 head 与 base 的 clean/local/remote/both 状态，运行测试。**
- [x] **Step 5: 提交 `feat: compute deterministic sync status`。**

### Task 5: 三方合并与首次绑定计划

**Files:**
- Create: `src/core/field-merge.ts`, `src/core/body-merge.ts`, `src/core/pull-plan.ts`, `src/core/initial-binding.ts`
- Test: `tests/unit/field-merge.test.ts`, `body-merge.test.ts`, `pull-plan.test.ts`, `initial-binding.test.ts`

**Interfaces:**
- Produces: `mergeField`, `mergeBody`, `buildPullPreview`, `buildInitialBindingPreview`; structured conflicts never Git markers.

- [x] **Step 1: 写 path/title 真值表、非重叠 diff3、重叠/删除修改/双向移动冲突测试。**
- [x] **Step 2: 写任一分支 >10,000 行整篇冲突、末尾换行独立合并测试并确认红。**
- [x] **Step 3: 实现字段合并和 node-diff3 正文合并，冲突 ID 使用内容与范围 hash。**
- [x] **Step 4: 写首次 Clone、空远端发布、双方内容、显式跨路径绑定和 title-from-stem 测试。**
- [x] **Step 5: 实现首次绑定 plan，base 永远为固定远端 R，本地差异保持 dirty；运行测试。**
- [x] **Step 6: 提交 `feat: plan pull merges and initial binding`。**

### Task 6: Control Store、Envelope 与 Generation

**Files:**
- Create: `src/ports/control-store.ts`, `src/storage/envelope.ts`, `src/storage/control-store.ts`, `src/storage/generation.ts`, `src/storage/device-state.ts`, `src/storage/schemas.ts`
- Test: `tests/unit/envelope.test.ts`, `generation.test.ts`, `device-state.test.ts`, `tests/fakes/memory-data-adapter.ts`

**Interfaces:**
- Produces: `MutableControlRepository<T>`, `GenerationRepository`, `DeviceStateRepository`; current pointer activation is journal-aware.

- [x] **Step 1: 写 current/prev/next 每个故障点、同 generation 异 hash、未知 schema、旧单 key 迁移失败测试。**
- [x] **Step 2: 实现 canonical payload hash、三副本读取选择和串行写入，确认普通 payload 测试通过。**
- [x] **Step 3: 写 pointer phase×candidate、active=false tombstone、不可变 base/manifest 损坏测试。**
- [x] **Step 4: 实现 generation 写入/重读、base 三指标重算、journal-aware pointer 收敛和最近两代保留。**
- [x] **Step 5: 提交 `feat: persist crash-safe sync generations`。**

### Task 7: Pull Vault 事务与恢复

**Files:**
- Create: `src/storage/pull-journal.ts`, `src/application/pull-transaction.ts`, `src/obsidian/vault-adapter.ts`
- Test: `tests/integration/pull-transaction.test.ts`, `pull-recovery.test.ts`, `tests/fakes/memory-vault.ts`

**Interfaces:**
- Produces: `PullTransaction.prepare/apply/recover`; all writes are conditional on `vaultByteHash` and `scanEpoch`.

- [x] **Step 1: 写 create/write/rename/trash、A↔B、三路径环、目录创建和回收站失败测试。**
- [x] **Step 2: 对 prepared/applying/committing/committed/rollback 每个持久化点注入退出并确认红。**
- [x] **Step 3: 实现 results/snapshots staging、条件 `Vault.process`、临时路径置换与逐步 journal。**
- [x] **Step 4: 实现唯一状态推断、rollback、pointer tombstone 与 failed freeze；运行故障矩阵。**
- [x] **Step 5: 提交 `feat: apply crash-safe pull transactions`。**

### Task 8: AgentWiki HTTP 客户端与人工连接

**Files:**
- Create: `src/ports/http.ts`, `src/ports/secrets.ts`, `src/agentwiki/client.ts`, `src/agentwiki/retry.ts`, `src/application/connection-service.ts`, `src/obsidian/request-url-adapter.ts`, `src/obsidian/secret-adapter.ts`
- Test: `tests/unit/server-url.test.ts`, `retry.test.ts`, `tests/integration/connection-service.test.ts`, `agentwiki-client.test.ts`

**Interfaces:**
- Produces: `AgentWikiClient`, `ConnectionService`, `HttpPort`, `SecretPort`; active device session only after exchange→verify→activate→verify.

- [x] **Step 1: 写 HTTPS/loopback URL、3xx 拒绝、错误 envelope、分页固定指标与授权 header 测试。**
- [x] **Step 2: 写 exchange 每个崩溃点、response lost、collision 换 credential、过期和 revoke 测试。**
- [x] **Step 3: 实现 requestUrl client、端点级重试预算和无正文诊断。**
- [x] **Step 4: 实现随机 Secret ID、connection journal、credential_stored 提交顺序、activate 和恢复。**
- [x] **Step 5: 运行连接/客户端测试，扫描代码确认 secret 不进入 Control Store/log。**
- [x] **Step 6: 提交 `feat: connect human AgentWiki devices`。**

### Task 9: Push 预览、分批上传与恢复

**Files:**
- Create: `src/core/push-plan.ts`, `src/storage/push-journal.ts`, `src/application/push-service.ts`
- Test: `tests/unit/push-plan.test.ts`, `tests/integration/push-service.test.ts`, `push-recovery.test.ts`

**Interfaces:**
- Produces: `buildPushPreview`, `PushService.start/resume/abort`; remote publish and local generation commit are separate phases.

- [x] **Step 1: 写远端领先禁止 Push、preview capability hash、confirmation 限制和 payload snapshot 测试。**
- [x] **Step 2: 写批次响应丢失、finalize 响应丢失、noop、BASE_STALE、session expiry 和 credential rotation 测试。**
- [x] **Step 3: 实现 JSONL sidecar、payload、batch index、receipt 与精确临时空间估算。**
- [x] **Step 4: 实现 create/upload/finalize/query 状态机及 published 后本地 generation 幂等提交。**
- [x] **Step 5: 运行 Push 故障矩阵，确认用户确认后的新编辑仍被 Status 判为 modified。**
- [x] **Step 6: 提交 `feat: publish confirmed vault changes`。**

### Task 10: 同步用例编排与映射生命周期

**Files:**
- Create: `src/application/sync-coordinator.ts`, `status-service.ts`, `mapping-service.ts`, `operation-lock.ts`, `progress.ts`
- Test: `tests/integration/sync-coordinator.test.ts`, `mapping-lifecycle.test.ts`

**Interfaces:**
- Produces: commands `status(spaceId)`, `pull(spaceId)`, `push(spaceId)`; one operation per Space and no cross-Space leakage.

- [x] **Step 1: 写双 Space 隔离、并发拒绝、pending 映射隐藏、server/vault identity mismatch freeze 测试。**
- [x] **Step 2: 写添加/取消/移除映射、断开、离线忘记和新 Vault 物理副本确认测试。**
- [x] **Step 3: 实现服务编排、取消边界、每批/50 文件 yield 与进度事件。**
- [x] **Step 4: 运行集成测试并提交 `feat: orchestrate manual space sync`。**

### Task 11: Obsidian 原生设置与同步中心 UI

**Files:**
- Create: `src/obsidian/settings-tab.ts`, `sync-modal.ts`, `conflict-view.ts`, `view-model.ts`, `notices.ts`
- Modify: `src/main.ts`, `styles.css`
- Test: `tests/unit/view-model.test.ts`, `tests/integration/plugin-lifecycle.test.ts`

**Interfaces:**
- Produces: ribbon、`status/pull/push` commands、内联连接、Space mapping、分页预览和桌面/移动冲突视图。

- [x] **Step 1: 写插件加载零网络、命令注册、活动文件选 Space 和按钮能力 view-model 测试。**
- [x] **Step 2: 写设置页内联连接状态、无自动浏览器跳转、预览确认/取消边界测试。**
- [x] **Step 3: 实现原生 `PluginSettingTab/Modal/Setting` UI，不引入 React。**
- [x] **Step 4: 实现诊断预览与脱敏、100 项文件分页、冲突选择和最终结果编辑。**
- [x] **Step 5: 运行 UI/lifecycle 测试并提交 `feat: add native Obsidian sync UI`。**

### Task 12: 全流程 Fake AgentWiki 验收

**Files:**
- Create: `tests/fakes/fake-agentwiki.ts`, `tests/e2e/manual-sync-flow.test.ts`, `multi-device-flow.test.ts`, `fault-matrix.test.ts`

**Interfaces:**
- Produces: 可重复的内存公开 API，不依赖主项目内部 DTO。

- [x] **Step 1: 写桌面 Push→移动 Pull→移动 Push→桌面 Pull 的失败 E2E。**
- [x] **Step 2: 实现 fake remote 的 revision、Snapshot/Delta、角色、session、批次与原子 finalize。**
- [x] **Step 3: 覆盖双设备非重叠合并、重叠冲突、归档、角色降级、响应丢失和 Relation-only revision。**
- [x] **Step 4: 对所有 journal/HTTP fault point 参数化执行，运行 `npm test -- tests/e2e tests/integration`。**
- [x] **Step 5: 提交 `test: verify end-to-end manual sync flows`。**

### Task 13: 性能、安全和发布验收

**Files:**
- Create: `tests/performance/bounded-space.test.ts`, `scripts/check-bundle.mjs`, `scripts/check-release.mjs`, `README.md`, `CHANGELOG.md`, `docs/verification/agentwiki-sync-v1.md`
- Modify: `package.json`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces: 可复现验证报告与社区插件发布产物 `main.js`, `manifest.json`, `styles.css`。

- [x] **Step 1: 写 5,000 页/100 MiB 流式 scan、分页 Pull、分批 Push 与 10,001 行降级性能测试。**
- [x] **Step 2: 写 bundle 扫描，拒绝 `node:`, `fs`, `child_process`, `FileSystemAdapter` 和 secret fixture。**
- [x] **Step 3: 编写安装、连接、首次绑定、恢复、隐私、已知上游依赖文档。**
- [x] **Step 4: 运行 `npm ci && npm run check`，随后在干净临时 Vault 执行 plugin load smoke test。**
- [x] **Step 5: 生成验证报告，记录真实 AgentWiki API/协议包尚未发布，因此 live 联调为外部待办而非插件缺失。**
- [x] **Step 6: 提交 `release: prepare AgentWiki Sync v1`。**

## Self-Review

- Spec coverage: 设计第 1–18 节分别映射到 Task 1–13；连接、三种同步命令、首次绑定、事务恢复、容量、隐私、UI、CI 和 E2E 均有实现与测试任务。
- Placeholder scan: 计划不含 TBD/TODO/“同上”；上游 API 未发布是明确外部依赖，并由 fake public contract 与条件 live 验收处理。
- Type consistency: 协议函数只从 Task 2 暴露；Vault/HTTP/Secret/Control 端口分别由 Tasks 4/6/8 定义；application 层只依赖这些稳定接口。
