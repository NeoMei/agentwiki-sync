# 官方 0.5.10 基线重映射复测与修复候选

日期：2026-10-16。源码基线为正式 `2df7cfa`（0.5.10）。本候选未升级版本、未安装到用户 Vault、未发布。

## 可复现问题与边界

- 官方代码可复现：已有合法基线的映射被允许移除后，设备/Space 控制目录仍原样存在。以另一根目录重新添加同一 Space 后，真实 `collectSyncDiff` → `runtime` → `TreeBaselineRepository.requiredProtocolVersion` 在首次 HTTP 请求前报“基线损坏: 指针身份/哈希不匹配”。
- 改成仅大小写不同的根 `Wiki` → `wiki` 也会触发；这是旧根控制状态被新映射复用，不是 Windows 路径分隔符自动转换。
- 新建连接/映射且没有旧基线的对照可以到达 HTTP；移除后使用完全相同根的对照也可以到达 HTTP。`Wiki\\Sub`、绝对盘符路径、前后 `/` 在映射校验时被拒绝；Unicode 组合形式统一为 NFC。
- 初始官方复现运行：10 项中 8 通过、2 失败，二者均是上述换根后基线身份错误。移除使用真实 SyncRuntime、真实 Vault adapter、真实基线/状态扫描，只将远端替换为确定性 fixture。
- 原报告没有记录之前是否移除/重建映射，黄金书屋原 Vault 尚未定位，因此这是同错误的已确认机制修复，不能宣称原案已完成复验。
- Windows 正式插件当前发现的 `/api/sync/v2/spaces/.../head` 410 是另一个问题，不由本候选更改服务端或基线绕过。

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

后续门禁：独立代码审查、独立测试 Vault 原生验收，以及用户原黄金书屋环境回放。本文不把 fixture 当原 Vault 验收。

## 独立审查补修：断开连接后的后台 writer

对 `4b6b44b` 的独立审查复现了一条 P2：真实 rename hint 写暂停时，`disconnect` 直接清空缓存；随后移除映射失去对旧 writer 的引用，归档期间旧 writer 重建原控制目录，触发 `MAPPING_DETACH_RECOVERY_REQUIRED`。独立证据为 `/tmp/agentwiki-official-disconnect-race.test.ts` 和同名 `.log`，该版本未放行。

所有缓存删除现在统一退役：先停止新 rename、从事件目标摘除，保留 `retiringRuntimes` 的排空 Promise，等在途 writer 结束后才允许断开、重新创建 runtime 或归档。错误失效、v3 身份替换、同 Space runtime key 替换和正常移除共用此路径；同步卸载钩子启动退役并保留 Promise，不宣称宿主会等待该钩子。

新增断开/缺连接两项回归先红，日志 `/tmp/agentwiki-official-runtime-retirement-red.log`。修复后并发组 10 项全绿，另覆盖身份错误清缓存，及真实连接服务 exchange/session/activate 后重新绑定不同根、构造新 v3 runtime、原正文保持、退休 runtime 不再写入。

补修完整检查：`npm run check` 退出 0，74 文件 1526 测试、格式、typecheck、production build、bundle/release 校验通过；19 个既有 lint warning。日志 `/tmp/agentwiki-official-baseline-check-retirement.log`。

## 0.5.11 发布准备

产品源码 `becc0a1` 独立复审 PASS，回执 `/tmp/agentwiki-official-baseline-review-becc0a1.md`，包含独立竞态回放及恢复兼容检查。随后仅更新版本、发布说明、元数据断言与验收文档；0.5.11 完整 `npm run check` 再次退出 0，仍为 74 文件 1526 项通过、19 个已有 lint warning。日志 `/tmp/agentwiki-0511-release-preparation.log`。

候选 main.js 1781422 B，SHA-256 `95bf589b188c31850df105440ff0c766856339248382e0ed49cde411f5512e66`；manifest.json `25b54b8a5acb87a80807c5f3931a423ee262b11639ae7897479ed83943417cfa`；styles.css `5dfe15839220724a57a64ad7ab136761ba2ffaaff3c0235faac1cf1238e762b8`。

准备时远端 main 仍为 `2df7cfab531d04282b57cc1e3fce0ba1bd368f6d`，最新正式 Release 仍为 0.5.10，没有 0.5.11 tag。feature branch 可供 Windows 固定 SHA 独立检出；尚未创建正式 tag/Release，也未安装到用户 Vault。Windows 步骤见 [windows-acceptance.md](windows-acceptance.md)，执行结果需要另记。
