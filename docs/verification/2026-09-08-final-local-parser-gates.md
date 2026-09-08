# 图片同步最终本地修正验证（2026-09-08）

## 范围与状态

本记录只覆盖用户追加批准的两项本地修正：插件 inline-code 扫描性能、服务端 bundled OpenCode 测试环境隔离。不是插件已发布、服务器已部署或真机同步已完整验收的证明。

- 插件候选：`81b4293b5ad8300d944a874000910a8d0a2b3ffc`，分支 `codex/referenced-image-sync-v3`。
- 插件初次性能修正 `b1e61c9` 经独立审查发现转义多反引号语义回归；`81b4293` 恢复原逐字符扫描的转义后缀 opener 行为，复审 I1 已关闭，新增 C/I/M 为 0/0/0。
- 服务端最终测试候选：`287bcd803d52cf1153fe446fe4d681db58ed1652`，分支 `codex/image-parser-final-20260908`；测试 fixture 准备阶段清理保护已补齐，最终完整测试通过，独立复审 I1 已关闭，新增 C/I/M 为 0/0/0。
- 原 C1 move_page 保守回滚停止策略及 I1 local_only 固定版本恢复未在本轮改动。

## 插件验证

- 有界字符访问回归：旧实现 N100/N200 为 344,256 / 2,708,456 次，新索引实现为 11,056 / 42,056 次；原始输入大小约增长 3.85 倍。计数是确定性回归检测，不是计时跑分。
- 保留完整等长 closing run、未闭合字面量、masked-region closer、转义单反引号与多反引号后缀行为。
- 直接 parser 81/81、parser/normalization/实际 Runtime focused 148/148。
- 作者及控制器在最终代码上分别运行完整 `npm run check`：66 文件、1,306 项全部通过，format/type/build/bundle 检查通过；17 条既有 lint warning，0 error。
- `env -u npm_config_allow_scripts npm audit --json`：0 漏洞。
- 实际本地插件与服务端 parser 对照：44 个中立样例及精确 source range 一致；4 个已有真实 Runtime/resolver 引用 ID 场景通过；另加转义 2/3 反引号两例，均保持 ID、只产生 upsert_page、不读取代码段 inside 图片。
- 上述 Runtime 使用合成 MemoryVault/ControlStore，不等于真实 Android 或公网验收。

最终插件资产：

| 文件          | 实际 bytes | SHA-256                                                            |
| ------------- | ---------: | ------------------------------------------------------------------ |
| main.js       |  1,708,394 | `04086e2e6f182bb423d8feab64a8fdebe3a75c39e9fa84cf28643381741c47e5` |
| manifest.json |        232 | `7b001849eafc37311a720c56d62f37704b1697ea75a4a5b801423d4be443daee` |
| styles.css    |      4,880 | `5dfe15839220724a57a64ad7ab136761ba2ffaaff3c0235faac1cf1238e762b8` |

## 服务端验证

- 旧测试将 host 实际 bundled executable 路径写死为 Windows `opencode.exe`，正确 cwd 本轮复现 1 failed / 29 skipped；不是生产 runner 缺陷。
- test-only 修正采用自建临时 Node CLI fixture，实际执行 runner → bundled resolver，保留精确 executable/args、未配置 OPENCODE_BIN、shell false 断言，仅 spawn 使用既有 mock。
- 冻结 `6450f33` 后 focused/关联 5 suites 72 passed / 1 Windows skip，typecheck/lint exit 0。
- 控制器专用 PostgreSQL/Redis + 随机 schema full harness 在 `6450f33` 和最终 `287bcd8` 分别通过：148/148 suites、2,570 passed / 1 Windows skip，exit 0。数据库后查 0 遗留测试 schema / 0 public tables；未使用生产库。
- 第一次完整 harness 启动因遗漏 PG_DUMP_BIN 在测试前退出，单独保留日志；补齐绝对路径后的完整执行才记为通过。
- fixture 所有 fallible setup 已纳入 finally 保护；受控 throw 的同一测试修复前遗留 1 个自建临时目录、修复后遗留 0 个。临时故障探针未提交；验证生成的唯一临时目录已清理，日志保留。最终 named/runner/typecheck/lint、完整门及独立复审均通过。
- 最终完整服务端日志 SHA-256：`4f76783b7b138558ff4e22196dcc88ae2f703f5f11e91bbf757860798141e809`，文件 `/tmp/agentwiki-final-local-gates.5q9Mwu/server-fullgate-round1.log`。
- 既有关联测试的预期 logger warning 作为非阻断维护项保留，不改变业务代码或扩大本次 test-only 修正范围。

## 证据与未完成边界

- 详细实现、RED/GREEN、独立审查、复审及命令退出状态存于本工作树 `.superpowers/sdd/2026-09-07-shortest-image-link-transaction/` 下对应 `plugin-parser-linear-*` / `server-opencode-test-*` 文档与 `progress.md`。
- 控制器本地证据目录：`/tmp/agentwiki-final-local-gates.5q9Mwu`；作者插件最终证据：`/tmp/agentwiki-plugin-parser-linear-fix1.UsyDMg`。原失败尝试和用户三份未跟踪 verification 文档均保留。
- 未改真实 Vault、手机插件、生产配置/数据库、GitHub 分支/tag/release 或 npm；未删除旧验收资源。
- 后续 Task 7：同候选桌面与 Android 全链路、公网 upgrade/recovery、生产部署验证和发布资产验证仍未关闭。SSH/Android 连接是实时环境条件，执行前需重新核验。
