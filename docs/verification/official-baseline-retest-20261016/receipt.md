# 官方 0.5.10 基线重映射复测与 0.5.11 发布回执

日期：2026-10-16。源码基线为正式 `2df7cfa`（0.5.10）。修复以 `7e81b9f1163083928033dc311fd14d87e5d3d055` 发布为 0.5.11；本文保留初始红测、审查补修和发布各阶段的证据。真实用户 Vault 的正式升级由主协调者另行验证，不以这里的临时 Vault 验收替代。

## 可复现问题与边界

- 官方代码可复现：已有合法基线的映射被允许移除后，设备/Space 控制目录仍原样存在。以另一根目录重新添加同一 Space 后，真实 `collectSyncDiff` → `runtime` → `TreeBaselineRepository.requiredProtocolVersion` 在首次 HTTP 请求前报“基线损坏: 指针身份/哈希不匹配”。
- 改成仅大小写不同的根 `Wiki` → `wiki` 也会触发；这是旧根控制状态被新映射复用，不是 Windows 路径分隔符自动转换。
- 新建连接/映射且没有旧基线的对照可以到达 HTTP；移除后使用完全相同根的对照也可以到达 HTTP。`Wiki\\Sub`、绝对盘符路径、前后 `/` 在映射校验时被拒绝；Unicode 组合形式统一为 NFC。
- 初始官方复现运行：10 项中 8 通过、2 失败，二者均是上述换根后基线身份错误。移除使用产品 SyncRuntime、ObsidianControlStore、ObsidianVaultPort、基线/状态扫描实现；底层 Obsidian API/文件系统为测试 harness，远端为确定性 fixture，不是 Obsidian 原生文件系统验收。
- 原报告没有记录之前是否移除/重建映射，最初也未定位黄金书屋原 Vault。后续主协调者已在官方 0.5.10 打开黄金书屋只读差异（24 本地、0 远端）；本次修复是同错误的已确认重映射机制，不能据此将黄金书屋原案归因为该机制。
- Windows 正式插件曾发现的 `/api/sync/v2/spaces/.../head` 410 是另一个问题，由服务端处理，本版本不通过更改或删除基线绕过。

## 实现

- 同 Space 操作锁覆盖差异刷新获取 runtime、恢复及扫描，也覆盖移除到设置落盘/恢复的完整过程。移除过程中无法启动旧映射刷新；刷新等待网络时不能移除。
- 移除前严格检查 v1/v2/v3 Push、Pull、基线、Pull 控制收尾及图片升级事务，保留原连接和设备双身份检查。未完成或损坏的事务证据不清理。
- 移除只将当前设备/Space 控制目录迁入 `detached`，保留所有 generation、journal、prev/next 和二进制；不删除或写入用户 Markdown。
- 使用设备本地写前意图，以持久设置决定提交还是回滚；设置先成功后报错、目录迁移故障和重启均有恢复用例。保留严格 Space、根目录和清单哈希校验，并拆分错误提示。
- add/remove/saveSettings 串行。添加其他 Space 保留现有 runtime 的映射对象，避免首次 Pull 后 active 状态丢失。失败恢复也保留未移除映射的对象。
- 断开连接同样取得映射操作锁。移除清空该 Space 的缓存 runtime，并等待已经排队的 Vault rename hint 落盘，再移动控制目录，避免后台写重建旧目录。

存储事务实现参考已撤回候选 `85b4078`；以官方 0.5.10 为父提交重新整合，保留官方目录归档/旧任务恢复修复，补齐其并发缺口。旧集成候选没有复活或安装。

## 验证

- 官方初始红测日志：`/tmp/agentwiki-official-baseline-retest-red.log`。
- 刷新/移除并发补丁前红测：2 项均失败；其中真实 scan 重建已归档目录，导致 `MAPPING_DETACH_RECOVERY_REQUIRED`。日志 `/tmp/agentwiki-official-detach-race-red.log`。
- 修复后：重映射 10 项、可恢复归档 37 项、并发/后台写 7 项全部通过。
- 完整 `npm run check`：格式、lint、typecheck、74 文件 1523 测试、production build、bundle safety、release metadata 全通过。lint 为 19 个已有 warning；版本仍 0.5.10。最终日志 `/tmp/agentwiki-official-baseline-check-final.log`。

该阶段后续门禁为独立代码审查、独立测试 Vault 原生验收，以及原用户环境回放。后两阶段结果见下文；fixture 不作为原 Vault 验收。

## 独立审查补修：断开连接后的后台 writer

对 `4b6b44b` 的独立审查复现了一条 P2：真实 rename hint 写暂停时，`disconnect` 直接清空缓存；随后移除映射失去对旧 writer 的引用，归档期间旧 writer 重建原控制目录，触发 `MAPPING_DETACH_RECOVERY_REQUIRED`。独立证据为 `/tmp/agentwiki-official-disconnect-race.test.ts` 和同名 `.log`，该版本未放行。

所有缓存删除现在统一退役：先停止新 rename、从事件目标摘除，保留 `retiringRuntimes` 的排空 Promise，等在途 writer 结束后才允许断开、重新创建 runtime 或归档。错误失效、v3 身份替换、同 Space runtime key 替换和正常移除共用此路径；同步卸载钩子启动退役并保留 Promise，不宣称宿主会等待该钩子。

新增断开/缺连接两项回归先红，日志 `/tmp/agentwiki-official-runtime-retirement-red.log`。修复后并发组 10 项全绿，另覆盖身份错误清缓存，及真实连接服务 exchange/session/activate 后重新绑定不同根、构造新 v3 runtime、原正文保持、退休 runtime 不再写入。

补修完整检查：`npm run check` 退出 0，74 文件 1526 测试、格式、typecheck、production build、bundle/release 校验通过；19 个既有 lint warning。日志 `/tmp/agentwiki-official-baseline-check-retirement.log`。

## 0.5.11 发布准备

产品源码 `becc0a1` 独立复审 PASS，回执 `/tmp/agentwiki-official-baseline-review-becc0a1.md`，包含独立竞态回放及恢复兼容检查。随后仅更新版本、发布说明、元数据断言与验收文档；0.5.11 完整 `npm run check` 再次退出 0，仍为 74 文件 1526 项通过、19 个已有 lint warning。日志 `/tmp/agentwiki-0511-release-preparation.log`。

候选固定为 `7e81b9f1163083928033dc311fd14d87e5d3d055`。正式资产以干净检出的 `npm ci` 构建为准，三文件身份如下：

| 资产          |    字节 | SHA-256                                                            |
| ------------- | ------: | ------------------------------------------------------------------ |
| main.js       | 1774928 | `7c12b84aaf82af1ec5d8eeab9edee1f727ed0f5264ef157ec36c2062be3c2926` |
| manifest.json |     233 | `25b54b8a5acb87a80807c5f3931a423ee262b11639ae7897479ed83943417cfa` |
| styles.css    |    4880 | `5dfe15839220724a57a64ad7ab136761ba2ffaaff3c0235faac1cf1238e762b8` |

初次记录的 Mac main.js `1781422 B / 95bf589b188c31850df105440ff0c766856339248382e0ed49cde411f5512e66` 来自工作树复用祖先目录中的 pnpm 依赖，已撤回为验收预期。其与干净 npm 产物的差异仅为 183 处依赖路径标签和 8 处嵌套 zod 路径注释；替换这些标签后逐字节一致。对固定候选重新执行 `git archive`、`npm ci`、完整 `npm run check`，74 文件 1526 测试及构建检查均通过，产物与 Windows npm 构建精确相同。证据为 `/tmp/agentwiki-0511-build-layout-proof.json` 和 `/tmp/agentwiki-0511-clean-npm-check.log`。

准备时远端 main 为 `2df7cfab531d04282b57cc1e3fce0ba1bd368f6d`，最新 Release 为 0.5.10，当时未创建 0.5.11 tag；该快照不代表下述正式发布后的状态。

## Windows 隔离验收回执

以下由主协调者收到远程 Windows 验收结果后确认，候选固定为上述完整 SHA，未使用真实 Vault 的设置或凭据。

- Windows `npm ci` 后 57 项机制测试通过，production build 和 bundle 检查退出 0。测试分为重映射 10 项、归档/恢复 37 项、并发/断开/重连 10 项。
- 初次检出时 manifest/styles 受 Git CRLF 转换影响；用 `git show` 的原始字节恢复这两个文件后，三个资产的 SHA-256 均与上表一致。没有更改全局 Git 配置。
- 专用临时 Vault 原生加载 PASS：插件版本 0.5.11，loaded/enabled 均为 true；disable-enable 后插件入口先消失再重现，重载后三资产哈希仍一致。临时 Vault 为零映射、零正文。
- 临时 Vault 的信任提示由外部操作消失，不归因于代理操作。
- 真实 Obsidian DataAdapter 的换根和排队 rename/断开竞态 fixture 为 **NOT_RUN**。57 项模块测试不能替代该原生文件系统机制验收，也不证明原用户 Space 已完成业务同步。

可复现步骤及范围见 [windows-acceptance.md](windows-acceptance.md)。

## 正式发布及资产回读

Windows 上述门禁通过后，主协调者明确放行发布。以无强推的原子推送将 main 从 `2df7cfa` 快进到固定候选，并创建注释 tag `0.5.11`：tag object 为 `94ba5870dbcc6e87753ea7d878e2c7d7dab31889`，解析源码为 `7e81b9f1163083928033dc311fd14d87e5d3d055`。

[Release 工作流 38863788453](https://github.com/NeoMei/agentwiki-sync/actions/runs/38863788453) 已 completed/success。工作流在 Ubuntu 全新 checkout 上执行 Node 24、`npm ci`、完整 `npm run check`、三资产 attest 和发布；没有使用本地 pnpm 构建文件。

[正式 0.5.11 Release](https://github.com/NeoMei/agentwiki-sync/releases/tag/0.5.11) 于 `2026-10-16T06:54:47Z` 发布，非 draft、非 prerelease。已实际下载 main.js、manifest.json、styles.css，三文件均与干净 npm 产物逐字节相同，哈希及大小见上表。

三个资产分别执行 `gh attestation verify`，限定仓库 `NeoMei/agentwiki-sync`、签名工作流 `.github/workflows/release.yml`、source ref `refs/tags/0.5.11`、source digest 为固定候选，并拒绝 self-hosted runner，均退出 0。资产、哈希比较和验证 JSON 保存在 `/tmp/agentwiki-0511-official-release-38863788453/`，CI 完整日志为 `/tmp/agentwiki-0511-official-ci.log`。

本次回执更正属于发布后的独立 docs commit，正式 tag 与被验收的候选源码保持不变。真实 Windows 用户 Vault 的官方升级和只读差异回验由主协调者另记。
