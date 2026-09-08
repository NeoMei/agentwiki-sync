# 最短图片链接生产 Runtime 故障矩阵

验证日期：2026-09-08（Asia/Shanghai）。候选分支：`codex/referenced-image-sync-v3`。本记录只证明受控 FakeTreeRemoteV3、MemoryControlStore 和 VaultPort 后的实际插件 Runtime/factory 入口；不等于真实服务器、设备、Vault 安装或发布验收。

2026-09-08 追加确认后的 move_page 异常恢复语义：成功 rename/CAS 的返回丢失、需要回滚恢复源或删除目标时，现有端口不具备条件 mutation，故在该移动操作任何回滚业务写入前持久化 ambiguous，保留当前文件、before/result sidecar 和旧 baseline。两次重建恢复保持停止；不再承诺移动异常能自动回滚成功。完整 before 状态仍可无操作恢复，正常前向移动仍可完成。此前 `final-fix-report.md` 的 CAS 丢返回自动回滚记录属于旧候选历史，已由 `rollback-safe-stop-report.md` 的定向证据替代；下列普通 write_page CAS 用例不因此改变。

## Runtime 故障断点与可观测结果

- published 后 Page 晚编辑：`normalized-push-runtime.test.ts` 的既有 `late edit=false/true` 参数化用例，并新增严格包裹真实 `finalize()` 成功返回后再编辑的用例。专用错误分别为 `TREE_TRANSACTION_AMBIGUOUS` / `STALE_PULL_PREVIEW`；用户正文保留，父 journal 维持 `local_pending`，原子 plan 和 fixed target 保留，old baseline 不前推，`Finalize` 仍只有 1 次。
- create 成功后仅返回丢失：`recovers an accepted create response loss after a rename with a fresh runtime epoch`。重建 Runtime 沿用原 `operationId` / idempotency key；两次 create 请求只对应一个幂等 session，最终 1 次 `Finalize`、0 chunk 重传、固定 `rev-push-2`。
- accepted batch 成功后仅返回丢失：`recovers the actual Runtime after an accepted batch success response is lost`。恢复保留原 plan / operation ID；batch 持久记录只有 1 份，1 次 `Finalize`，0 chunk 上传，baseline 推进至唯一发布 revision。
- `Finalize` 已发布后仅返回丢失：`recovers the actual Runtime after Finalize publishes and only its success response is lost`。fault hook 先 `await` 真实成功边界并使远端 head 成为 `rev-push-1`，再丢弃返回；恢复只读固定 revision，新 head 查询被故意改为抛错仍可完成；create/finalize 均只产生一个远端事实，attachment ID 稳定，0 chunk 重传；随后完整 Pull/Push 均为零动作。
- confirmed 父 journal `.next` 写成功后仅返回丢失：`replays the original Runtime plan when the confirmed parent write succeeds but its return is lost`。MemoryControlStore 真实写入先完成，已持久 `confirmed` 与原 plan 精确匹配，故障时 0 create 且 baseline 不前推；重建后仅发布一次。
- Page CAS 写成功后仅返回丢失：`recovers the actual Runtime after the Page CAS succeeds but its return is lost`。真实 `compareAndSwap` 先修改 Vault，再丢弃返回；`operationLog` 证明命中 CAS，本地规范正文与原 plan 保留，baseline 在恢复完成后才前推，只有一个发布结果。
- `local_only` 本地中断恢复后再 Pull 新 head：`recovers a local-only repair with zero remote mutations and then Pulls a new head`。pending 时 Pull / new Push 均以 `PUSH_RECOVERY_REQUIRED` 拒绝；本地恢复的 create/batch/chunk/finalize 计数全为 0；恢复后 Pull `rev-2` 并前推 baseline，再次 Push 为零动作。
- terminal schema 4 后产生普通 schema 3 Push：`hands a terminal schema-4 repair forward to the ordinary schema-3 Push owner`。该 Runtime 用例证明 schema 4 `complete` 不阻断后续普通 Page edit，根 journal 由原 owner 产生合法 schema 3 `published/verified`。旧 terminal envelope/generation 留存另由 `src/storage/push-journal-router.ts` 的 retain 路径及 `tests/integration/normalized-push-storage.test.ts` 的留存回归证明，不能归为此 Runtime 单用例的断言。

## 生命周期矩阵

- 旧 schema 1/2 的 create-成功-返回丢失、原 owner 恢复、图片升级和 native 后续路径，由 `local-image-upgrade-entry.test.ts` 的 schema 1/2 × confirm-race 四个实际 factory 用例继续覆盖。旧 schema 3 子 Push 恢复由上述 create/batch/Finalize 响应丢失 Runtime 用例覆盖；新增 terminal schema 4 → ordinary schema 3 交接。
- pending schema 4 对 Pull / new Push 的拒绝在 `normalized-push-runtime.test.ts` 新增证据；升级路由 `local-image-upgrade-entry.test.ts` 的旧 pending 优先、取消/重试用例覆盖；删除 mapping 和断开连接由既有 `blocks mapping removal and disconnect...` 及真实 normalized pending 用例覆盖。
- 既有 pending retry 表继续覆盖 origin、公开 credential、本地 credential、mapping、session、unload 与 epoch/restart；本轮只扩展真正缺口：不同 Vault ID、mapping root 和 Space ID。用例不输出凭据内容。
- `local-image-upgrade-plan.test.ts`、`local-image-upgrade-recovery-verifier.test.ts` 和 `plugin-settings-lifecycle.test.ts` 本轮未复制已闭合矩阵；它们作为指定回归集全部通过。

## 原遗留项逐项 triage

- Task 19 I1 真实 production factory 协商：`CLOSED`。wholebranch-review.md 已依据真实 `ProtocolNegotiator` + plugin factory + 受控 HTTP 覆盖 legacy 无图 strict v2、native 无图 strict v3、旧 v1/v2 图片拒绝及 v3 失败不降级，显式关闭原 finding；整体发布门仍未闭合。
- Task 19 I2 / I3 与确定性 Finalize 冲突：`CLOSED`。引用 `.superpowers/sdd/2026-09-06-local-first-image-upgrade/task19-i2-i3-fix-review.md` 的独立闭合结论；本轮不重派、不重复修复。
- Task 12 parser parity：`OPEN_CROSS_PROJECT_EVIDENCE`。wholebranch-review.md 确认原 40 组分类/路径/range 与预绑定 ID 为限定向量 PASS，但新 I2 backtick 场景使最终 parser/parity 门重新 OPEN。新增中性向量仍需独立 server 修正与双端实际 resolver/scan 对照，插件本地回归不替代跨仓闭合。
- Task 12 最后引用零读取：`COVERED / PASS`。`sync-runtime.test.ts` 的 `detaches the last reference without deleting local files or reading unreferenced images` 断言 detach、本地图保留、未引用图不读取且上传 requirement 为 0；完整门 1265/1265 包含该用例。
- Task 16 Runtime 职责：`ACCEPTED_NONBLOCKING_MAINTENANCE_DEBT`。wholebranch-review.md 确认已拆出 snapshot reader、shared local apply 与 normalized adapter，未见重复发布引擎；Runtime 仍大，不称已重构完。
- Task 18 async resolver + 分页重渲染：`CLOSED`。wholebranch-review.md 依据 `preview-modal-interactions.test.ts` 实际挂起 digest、翻页后恢复并断言当前确认按钮启用的用例，以及 latest-choice generation，显式关闭 detached-row finding。repair-count 用例仅为补充证据。
- U6 entry 职责：`ACCEPTED_NONBLOCKING_MAINTENANCE_DEBT`。wholebranch-review.md 接受现有职责拆分及原引擎持有事实，不要求按行数重构；本轮没有扩大产品重构范围。
- 17 条 lint warnings：`BASELINE_RETAINED`。本轮 `npm run check` 仍为 0 errors / 17 warnings，文件和规则列表保存在 `fullcheck.log`；本轮改动的两个测试文件没有新 warning，未关闭规则或伪称 pristine lint。
- single-Page keep-both 非空 proper subset：`CORE_SPEC_CONFORMING / UI_M3_FIX_REVIEW_PENDING`。wholebranch-review.md 确认 Core 的 `0 < redirects < affectedPages` 规则符合规格，发现单 Page 仍展示不可完成选项的 UI M3。最终 fix wave 已移除此不可行选项并保持两个可完成选择，待 scoped re-review；不扩展同 Page 单引用分流语义。

## 本地命令证据

唯一日志目录：`/tmp/agentwiki-shortlinks-final.y4w3YG`。

- 指定 focused 命令：exit 0；5 文件 / 140 测试通过。分文件为 normalized Runtime 25、upgrade entry 77、upgrade plan 19、recovery verifier 5、settings lifecycle 14。日志 `focused.log`，SHA-256 `cc675bc179e10607f4d98e4a0b9bfc21c2e19d6ee88e788cda3d78bc87fb911f`。
- `npm run check`：exit 0；Prettier PASS，lint 0 errors / 17 baseline warnings，`tsc --noEmit` PASS，65 文件 / 1265 测试 PASS，production build PASS，bundle checker 报告 1,706,379 bytes，release metadata 0.4.0 PASS。日志 `fullcheck.log`，SHA-256 `5f673b544d332c3c835b34891bafaa0042ee419979924082a53fed99ce68cfda`。
- `env -u npm_config_allow_scripts npm audit --json`：exit 0；info/low/moderate/high/critical/total 全为 0，450 个 dependency metadata 记录。`audit.stderr.log` 为空；`audit.json` SHA-256 `b63dea58ad002d03edb35fdf9c749d9d17f65322a6923a289fc382bbc9a2baa0`。
- 构建产物指纹：`main.js` 文件实际 1,707,095 bytes，SHA-256 `f70cc7cd824a6eb6b49fa950eb398f888c5cb0b8b4ba31b2a9c747265606a1b9`；`manifest.json` SHA-256 `7b001849eafc37311a720c56d62f37704b1697ea75a4a5b801423d4be443daee`；`styles.css` SHA-256 `5dfe15839220724a57a64ad7ab136761ba2ffaaff3c0235faac1cf1238e762b8`。`main.js` 文件大小与 bundle checker 口径分开记录，不互相替代。

## TDD / 回归说明与外部边界

本任务没有改动产品实现。新增的故障 hook 在当前产品实现上直接通过，因此记录为现有安全行为的 regression PASS，不通过篡改断言或产品逻辑制造假 RED。编写过程中一次 fixture control root 路径写错、一次把真实专用错误 `STALE_PULL_PREVIEW` 预期为另一错误；两者都是测试自身修正，不记为产品 RED。

真实桌面 Obsidian、Android、真实 Vault 中断恢复、真实 AgentWiki 服务器、公网 API/UI、安装、GitHub/npm/marketplace、tag/release/部署及发布后哈希：**NOT_RUN**。不将本地 fake/runtime 通过记为任一外部门成功。
