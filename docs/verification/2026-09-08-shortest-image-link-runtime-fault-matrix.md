# 最短图片链接生产 Runtime 故障矩阵

验证日期：2026-09-08（Asia/Shanghai）。候选分支：`codex/referenced-image-sync-v3`。本记录只证明受控 FakeTreeRemoteV3、MemoryControlStore 和 VaultPort 后的实际插件 Runtime/factory 入口；不等于真实服务器、设备、Vault 安装或发布验收。

## Runtime 故障断点与可观测结果

- published 后 Page 晚编辑：`normalized-push-runtime.test.ts` 的既有 `late edit=false/true` 参数化用例，并新增严格包裹真实 `finalize()` 成功返回后再编辑的用例。专用错误分别为 `TREE_TRANSACTION_AMBIGUOUS` / `STALE_PULL_PREVIEW`；用户正文保留，父 journal 维持 `local_pending`，原子 plan 和 fixed target 保留，old baseline 不前推，`Finalize` 仍只有 1 次。
- create 成功后仅返回丢失：`recovers an accepted create response loss after a rename with a fresh runtime epoch`。重建 Runtime 沿用原 `operationId` / idempotency key；两次 create 请求只对应一个幂等 session，最终 1 次 `Finalize`、0 chunk 重传、固定 `rev-push-2`。
- accepted batch 成功后仅返回丢失：`recovers the actual Runtime after an accepted batch success response is lost`。恢复保留原 plan / operation ID；batch 持久记录只有 1 份，1 次 `Finalize`，0 chunk 上传，baseline 推进至唯一发布 revision。
- `Finalize` 已发布后仅返回丢失：`recovers the actual Runtime after Finalize publishes and only its success response is lost`。fault hook 先 `await` 真实成功边界并使远端 head 成为 `rev-push-1`，再丢弃返回；恢复只读固定 revision，新 head 查询被故意改为抛错仍可完成；create/finalize 均只产生一个远端事实，attachment ID 稳定，0 chunk 重传；随后完整 Pull/Push 均为零动作。
- confirmed 父 journal `.next` 写成功后仅返回丢失：`replays the original Runtime plan when the confirmed parent write succeeds but its return is lost`。MemoryControlStore 真实写入先完成，已持久 `confirmed` 与原 plan 精确匹配，故障时 0 create 且 baseline 不前推；重建后仅发布一次。
- Page CAS 写成功后仅返回丢失：`recovers the actual Runtime after the Page CAS succeeds but its return is lost`。真实 `compareAndSwap` 先修改 Vault，再丢弃返回；`operationLog` 证明命中 CAS，本地规范正文与原 plan 保留，baseline 在恢复完成后才前推，只有一个发布结果。
- `local_only` 本地中断恢复后再 Pull 新 head：`recovers a local-only repair with zero remote mutations and then Pulls a new head`。pending 时 Pull / new Push 均以 `PUSH_RECOVERY_REQUIRED` 拒绝；本地恢复的 create/batch/chunk/finalize 计数全为 0；恢复后 Pull `rev-2` 并前推 baseline，再次 Push 为零动作。
- terminal schema 4 后产生普通 schema 3 Push：`hands a terminal schema-4 repair forward to the ordinary schema-3 Push owner`。schema 4 `complete` 不阻断后续普通 Page edit；根 journal 由原 owner 产生合法 schema 3 `published/verified`，不清除旧终态证据。

## 生命周期矩阵

- 旧 schema 1/2 的 create-成功-返回丢失、原 owner 恢复、图片升级和 native 后续路径，由 `local-image-upgrade-entry.test.ts` 的 schema 1/2 × confirm-race 四个实际 factory 用例继续覆盖。旧 schema 3 子 Push 恢复由上述 create/batch/Finalize 响应丢失 Runtime 用例覆盖；新增 terminal schema 4 → ordinary schema 3 交接。
- pending schema 4 对 Pull / new Push 的拒绝在 `normalized-push-runtime.test.ts` 新增证据；升级路由 `local-image-upgrade-entry.test.ts` 的旧 pending 优先、取消/重试用例覆盖；删除 mapping 和断开连接由既有 `blocks mapping removal and disconnect...` 及真实 normalized pending 用例覆盖。
- 既有 pending retry 表继续覆盖 origin、公开 credential、本地 credential、mapping、session、unload 与 epoch/restart；本轮只扩展真正缺口：不同 Vault ID、mapping root 和 Space ID。用例不输出凭据内容。
- `local-image-upgrade-plan.test.ts`、`local-image-upgrade-recovery-verifier.test.ts` 和 `plugin-settings-lifecycle.test.ts` 本轮未复制已闭合矩阵；它们作为指定回归集全部通过。

## 原遗留项逐项 triage

- Task 19 I1 真实 production factory 协商：`COVERAGE_PRESENT / FINAL_VERDICT_PENDING`。`local-image-upgrade-entry.test.ts` 已有真实 `ProtocolNegotiator` + plugin factory + 受控 HTTP，覆盖 legacy 无图 strict v2、native 无图 strict v3、旧 v1/v2 图片拒绝及 v3 失败不降级。不重写 I1；等待 `de1582cc…HEAD` whole-branch reviewer 给出显式闭合 verdict。
- Task 19 I2 / I3 与确定性 Finalize 冲突：`CLOSED`。引用 `.superpowers/sdd/2026-09-06-local-first-image-upgrade/task19-i2-i3-fix-review.md` 的独立闭合结论；本轮不重派、不重复修复。
- Task 12 parser parity：`OPEN_CROSS_PROJECT_EVIDENCE`。plugin 本地 parser 的分类/路径/边界单元覆盖仍通过，但原 review 要求的 server/plugin 同一组分类/路径/ID 向量并未在本插件任务中产生；不将本地回归冒充跨仓闭合。
- Task 12 最后引用零读取：`COVERED / PASS`。`sync-runtime.test.ts` 的 `detaches the last reference without deleting local files or reading unreferenced images` 断言 detach、本地图保留、未引用图不读取且上传 requirement 为 0；完整门 1265/1265 包含该用例。
- Task 16 Runtime 职责：`DEFERRED_COHESION_CONCERN`。`sync-runtime.ts` 当前 2846 行；后续已抽出 `tree-snapshot-reader.ts` 275 行和 `tree-local-apply-v3.ts` 311 行，原建议不可原样重发，但 Runtime 仍大且多故障域，留给 whole-branch 职责审查，不称已修复。
- Task 18 async resolver + 分页重渲染：`COVERAGE_PRESENT / FINAL_VERDICT_PENDING`。`preview-modal-interactions.test.ts` 的 `keeps the full repair count across async resolution, small-page pagination and invalidation` 及 rapid latest-choice 用例覆盖当前行为。原 conservative detached-row minor 的最终闭合仍交 whole-branch review，不将“延后”写成“已修复”。
- U6 entry 职责：`DEFERRED_COHESION_CONCERN`。`local-image-upgrade-entry.ts` 当前 1028 行；本轮只扩展消费它的真实 factory 矩阵，没有以测试任务名义重构产品。
- 17 条 lint warnings：`BASELINE_RETAINED`。本轮 `npm run check` 仍为 0 errors / 17 warnings，文件和规则列表保存在 `fullcheck.log`；本轮改动的两个测试文件没有新 warning，未关闭规则或伪称 pristine lint。
- single-Page keep-both 非空 proper subset：`SPEC_CONFORMING_LIMIT / FINAL_VERDICT_PENDING`。Core 要求 `0 < redirects < affectedPages`。对单引用 Page 不存在非空真子集；若全部 redirect，原 identity 将退出当前受管引用集合，不是规格中“保留两份”。因此当前限制与权威规格的原子引用集合和用户显式 Page 分流相符；这仍是可见产品限制，最终 verdict 由 whole-branch reviewer 确认，本轮不扩展语义。

## 本地命令证据

唯一日志目录：`/tmp/agentwiki-shortlinks-final.y4w3YG`。

- 指定 focused 命令：exit 0；5 文件 / 140 测试通过。分文件为 normalized Runtime 25、upgrade entry 77、upgrade plan 19、recovery verifier 5、settings lifecycle 14。日志 `focused.log`，SHA-256 `cc675bc179e10607f4d98e4a0b9bfc21c2e19d6ee88e788cda3d78bc87fb911f`。
- `npm run check`：exit 0；Prettier PASS，lint 0 errors / 17 baseline warnings，`tsc --noEmit` PASS，65 文件 / 1265 测试 PASS，production build PASS，bundle checker 报告 1,706,379 bytes，release metadata 0.4.0 PASS。日志 `fullcheck.log`，SHA-256 `5f673b544d332c3c835b34891bafaa0042ee419979924082a53fed99ce68cfda`。
- `env -u npm_config_allow_scripts npm audit --json`：exit 0；info/low/moderate/high/critical/total 全为 0，450 个 dependency metadata 记录。`audit.stderr.log` 为空；`audit.json` SHA-256 `b63dea58ad002d03edb35fdf9c749d9d17f65322a6923a289fc382bbc9a2baa0`。
- 构建产物指纹：`main.js` 文件实际 1,707,095 bytes，SHA-256 `f70cc7cd824a6eb6b49fa950eb398f888c5cb0b8b4ba31b2a9c747265606a1b9`；`manifest.json` SHA-256 `7b001849eafc37311a720c56d62f37704b1697ea75a4a5b801423d4be443daee`；`styles.css` SHA-256 `5dfe15839220724a57a64ad7ab136761ba2ffaaff3c0235faac1cf1238e762b8`。`main.js` 文件大小与 bundle checker 口径分开记录，不互相替代。

## TDD / 回归说明与外部边界

本任务没有改动产品实现。新增的故障 hook 在当前产品实现上直接通过，因此记录为现有安全行为的 regression PASS，不通过篡改断言或产品逻辑制造假 RED。编写过程中一次 fixture control root 路径写错、一次把真实专用错误 `STALE_PULL_PREVIEW` 预期为另一错误；两者都是测试自身修正，不记为产品 RED。

真实桌面 Obsidian、Android、真实 Vault 中断恢复、真实 AgentWiki 服务器、公网 API/UI、安装、GitHub/npm/marketplace、tag/release/部署及发布后哈希：**NOT_RUN**。不将本地 fake/runtime 通过记为任一外部门成功。
