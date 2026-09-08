# 最终候选真机验收预检与续验记录

最新状态：公网原版六项已 6/6 PASS，最终包双端全新首图、离线完整重启、特殊路径重命名等门禁现已通过，见[最终原生验收报告](2026-09-08-final-native-release-gates.md)。以下按时间保留旧候选和失败记录，不把旧 PASS 混作最终包验收；GitHub 发布及官方资产校验另行记录。

日期：2026-09-08。产品候选 `81b4293b5ad8300d944a874000910a8d0a2b3ffc`，文档 HEAD `60d9761945fa19502dd0701b2dff2101eb839c9c`。

用户在发布准备过程中说明真机已连接、可以开展验收，因此先继续 Task 7；未创建 0.4.0 tag 或 GitHub Release。

## 本轮证据

- 新一轮 `npm run check`：1306 tests PASS；`npm audit`：0 vulnerabilities。日志位于 `/tmp/agentwiki-release-040.tI9O2A/`。
- 桌面隔离库 `/Users/neomei/Obsidian/AgentWiki-Sync-V3-Acceptance-20260905` 的原三个插件资产已备份至 `/tmp/agentwiki-final-device-acceptance.iqmVnP/`；未复制 data.json 或凭据。
- 该隔离库已安装最终 main.js（1708394 bytes，SHA256 `04086e2e6f182bb423d8feab64a8fdebe3a75c39e9fa84cf28643381741c47e5`）。重载后，真实 renderer 返回 vault 名称匹配、agentwiki-sync 已加载、manifest 0.4.0、layoutReady=true，四个既有映射仍在。
- 重载后曾观察到白屏；随后用户切换界面后再次观察，内容和图片正常显示。尚未定位白屏原因，不能据此宣称插件缺陷或已修复。
- Obsidian CLI 报无法找到应用。诊断发现主进程持有 `/Users/neomei/.obsidian-cli.sock`，但文件系统中此 socket 路径不存在；未修改全局配置、删除 socket 或重启全部 Vault。
- 通过实际 renderer 调用了仅限 `U7Desktop70bf4ae` 映射的 `runSyncStrategy(spaceId, "local", {})`。返回 Promise pending，后续读取 modal/notice 均为空；未观察到确认界面、没有点击确认，不计作同步成功。
- Android `da9b6817` 在线，transport 21。前台先是飞书，之后是微信；本轮没有安装手机资产、重启应用、改写笔记或启动同步。
- 桌面用户随后切到 `NeoMei-Docs` 的社区插件搜索界面，已停止继续输入，未操作该真实库。

## 当前边界

最终包真实桌面完整同步、Android 同步/重启/离线矩阵及公网六项恢复验收均未完成。设备在线与 manifest 版本不是验收通过证据。等待用户将手机切到 Obsidian 并暂时留出测试操作时间；桌面也不在用户正在操作时抢占窗口。恢复时先检查隔离库此前 pending 的预览操作，不重复发起或跳过确认。

## 用户允许占用手机后的继续验收

- 用户答复“可以”后，手机停在 Launcher。备份 Android 原三个插件文件至上述证据目录的 `android-*-before.*`，未读取或复制凭据；停止 Obsidian、安装最终三个文件并完整启动。
- 设备三文件 SHA256 与候选一致；新进程 PID 23469，真实 WebView 返回 Vault `NeoMei-Docs`、插件 0.4.0、协议 3、目标映射 active。仅另有一个非测试映射，未改变。
- 原笔记仍为 `![Android local image](u7-renamed.png)`，没有手工改成相对路径。
- 实际插件 `runSyncStrategy` 打开“推送预览（以本地内容为准）”：本地链接修正 1 Page、更新 `assets/u7-renamed.png`（12997 B）、更新 `pages/Android First Image Baseline.md`。窄屏截图中的取消、确认执行均可见，没有裁切。
- 预览期间读取审计只出现目标 Markdown 和已引用的 `u7-renamed.png`，没有读取 `u7-unreferenced.png`。笔记仍等于原始文本，其他映射序列化值未变。
- 远端固定版本 `cmtqy8eva006yo3im34ufiiu5`，sequence 3；1 Page/1 attachment。附件 ID `4190a38b-9498-45ab-8890-f25b8c8e4372`，旧路径 `assets/u7-android.png`；其内容 SHA256 与手机重命名后的图片相同：`73ec9c4efc4245505911494867b3f59a6ace2995f25866440a8198383b5a9bc4`。因此后续要验证身份保留及零图片字节上传，不能仅凭预览文字宣称已证明。
- 证据：上述目录中 `android-preview.json`、`android-preview-state.json`、`android-remote-before.json`、`android-preview.png`。已对真实 transport 加入不记录 headers/凭据的请求方法、路径、二进制长度和状态审计。
- 当前停在“确认执行”前。按仓库规则，展示这次实际上传预览并取得明确确认后再执行；没有点击确认、没有发布新版本。完整验收仍未完成。

## 本次预览确认后的实际结果

用户明确答复“确认”，于 `2026-09-08T09:45:19.954Z` 点击精确匹配的预览确认按钮。

| 检查                 | 结果              | 权威证据                                                                                                                                      |
| -------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 原短链接自动修正     | PASS              | 真实笔记变为 `![Android local image](../assets/u7-renamed.png)`，未手改正文                                                                   |
| 原子发布一次         | PASS              | sequence 3 → 4；新 revision `cmtshhmmw006l1368c5d8b50v`；session `104c3583-b698-445b-9bd9-1f80ef8b9a6d` create 201 / batch 200 / finalize 200 |
| 图片内容去重         | PASS              | 全部记录请求 binaryBytes=0，没有 Blob 上传请求；前后图片 hash 相同                                                                            |
| 附件/页面身份保留    | PASS              | 附件 ID 保持 `4190a38b-9498-45ab-8890-f25b8c8e4372`；Page ID 保持 `0eec16fc-e2aa-4ccb-b01b-d76534841a4c`，固定快照仍 1 Page/1 attachment      |
| 未引用文件与其他映射 | PASS              | 未读取 `u7-unreferenced.png`，另一个映射序列化值不变                                                                                          |
| 本地事务终结         | PASS              | schema 4 父日志 phase=complete，completion/verifiedTarget 指向同一新 revision                                                                 |
| 第二次同步           | PASS              | 提示“本地没有待推送的变更。”；两次 GET head，无写请求                                                                                         |
| 手机与网页显示       | PASS              | 手机阅读模式、刷新后的网页均加载 480×270 图片；网页变更时间 `2026/9/8 17:45:26`，本轮浏览器 error/warn 日志为空                               |
| 固定版本真实下载     | PASS（transport） | 原生 V3 remote 下载固定 revision 中 12997 B 图片并通过 hash 校验、480×270 解码；不冒充完整 Pull 本地应用                                      |
| 单独插件重载         | PASS              | unload/load 后 0.4.0，其他映射不变，同步仍无变更                                                                                              |
| 完整进程离线重启     | PASS              | PID 29092 → 30994，重启时 wifi_on/mobile_data 均 0；本地图片 hash 相同、480×270 显示                                                          |
| WebView/原生离线请求 | PASS              | fetch 返回 Failed to fetch；真实插件同步返回原生 UnknownHostException，未弹写入确认                                                           |
| 网络恢复后同步       | PASS              | finally 恢复 wifi_on/mobile_data=1；实际同步再次返回无变更                                                                                    |

上述对应证据均在 `/tmp/agentwiki-final-device-acceptance.iqmVnP/`：`android-confirm.json`、`android-after-confirm.json`、`android-remote-after.json`、`android-noop.json`、`android-render.json/png`、`android-download-reload.json`、`android-offline-round1.jsonl`、`android-offline-restarted.png`、`android-online-restored.json`。网页截图留在当前工具记录。

失败尝试保留：首轮离线辅助脚本误用 Android 全局不存在的 `require`，在探测阶段失败，finally 恢复网络；该轮不计 PASS。修正辅助脚本后使用 WebView fetch 与原插件 runSyncStrategy（RequestUrlHttp）分别证明断网，未修改产品包。单独重载时观察到 BRAT 的既有更新失败通知；未操作 BRAT，随后设备 main.js hash 仍是最终候选 `04086e2e…`，该通知不计作 AgentWiki 同步失败，也不能宣称 BRAT 更新通过。

## 新发现：同版本无法恢复本地丢失图片

补测在已备份合成图片后，使用实际 Obsidian `vault.trash(file, false)` 将 `U7Android70bf4ae/assets/u7-renamed.png` 移入库回收站，确认原路径不存在。随后调用实际“以服务器内容为准”策略：只 GET head、无拉取预览/下载，返回后原路径仍不存在。状态：**FAIL**。

根因：`src/main.ts` 的 `openV3PullFlow` 在 `remoteDeltaV3().ahead` 为 false 时直接结束，没有检查同一远端版本下的本地缺失。底层 `previewPullV3` 本身包含扫描本地和下载 missing attachment 的流程，但此用户入口没有到达该流程。不能用直接调用底层方法绕过入口来把本项改为 PASS。

证据：`android-missing-pull-preview.json`、`android-missing-pull-state.json`，均只有 GET head 且 exists=false。这项是额外的同版本缺失恢复补测，既有正常增量 Pull 全链路仍需完成最终包验收。

已从本机独立备份 `android-image-before-pull.png` 手工恢复原路径（12997 B，hash `73ec9c4e…`），确认 exists=true、其他映射未变，随后重新启动 Obsidian 刷新文件状态。回收站和备份保留；此手工恢复不计作同步修复或通过。最终候选源码未改，未创建 tag/Release。桌面其余矩阵、公网六项恢复与此新缺口仍待处理。

## 2026-09-08 修复补充启动

用户再次答复“继续”，授权修复上述同版本缺失图片的拉取入口并续验。当前源码基准 `60d9761945fa19502dd0701b2dff2101eb839c9c`；新鲜完整基线测试 66 files / 1306 tests PASS，日志 `/tmp/agentwiki-same-revision-baseline-20260908.log`。当前只有独立实现子代理修改源码/回归测试，后续需要独立审查和重冻，不把旧包手机结果冒充新包通过。

复测前已验证手机 `da9b6817` 在线、前台 Obsidian，测试映射 active，另一映射未增加；测试图片与独立备份 SHA256 相同。受限复测脚本 `phone-repair-result.js`、`phone-repair-noop.js`、`verify-repair-evidence.mjs` 已准备并通过 Node 语法检查，尚未运行新包修复断言。脚本强制检查原图片字节、固定 revision/sequence、complete 父日志、其他映射不变、真实固定版本下载和无远端写入。

桌面 CLI 仍无法找到应用；只读窗口检查显示用户真实库处于编辑界面，未重启/修改该库。旧公网 provider 依赖不可用的桌面 CLI 且缺少目前必需的 recoveryCases 字段，不运行旧 provider 来制造成功。剩余公网恢复门继续保持 NOT_RUN。

## 同版本恢复补充：本地最终检查

- 源码冻结 `c3dba0c68e3c9c8ae96990c738149fc7bb81e080`；仅四个源码/测试文件改变。作者报告位于 SDD 目录的 `same-revision-pull-report.md`，独立审查进行中。
- Controller 新鲜运行 `npm run check`：exit 0，66 files / 1311 tests；format、typecheck、build、bundle、release metadata 均通过，lint 0 errors / 17 既有 warnings。日志 `/tmp/agentwiki-same-revision-controller-check-20260908.log`。`env -u npm_config_allow_scripts npm audit --json` exit 0，0 vulnerabilities。
- 新 main.js 为 1713226 bytes，SHA256 `73e288f4532595eeaec7daa435dafe3a177fc421f11ddec6809b4c592008f887`。此次尚未安装手机，旧包真机结果不算新包通过。
- 手机只读预检：Vault `NeoMei-Docs`，测试笔记为标准相对引用；目标图片 12997 B、SHA256 `73ec9c4efc4245505911494867b3f59a6ace2995f25866440a8198383b5a9bc4`；远端 revision `cmtshhmmw006l1368c5d8b50v` / sequence 4 / attachmentCount 1；其他映射 1 个、无 modal。前台为 Obsidian。
- GitHub 只读核验：origin 为 `NeoMei/agentwiki-sync`，latest Release 0.3.0，精确 `tags/0.4.0` 查询 404；未创建 tag/Release。桌面 CUA 仍显示真实库编辑界面，未进行桌面输入或写入；CLI socket 仍不存在。

## 同版本恢复：修复、复审与真机闭环 PASS

独立审查发现 I1：附件目标被目录或祖先文件占用时，扫描器仍可能输出 ATTACHMENT_MISSING；不能只检查 rawPathStates。作者增加真实 VaultPort.pathStatus 资格检查，先对目标目录、祖先文件两例取得 RED，再通过 101 项覆盖测试。修复提交 `15ad6e2dbb9c21cc34a1f85ad2d3796e2fbcba8e`，独立 scoped re-review 判定 I1 ADDRESSED，新增 C/I/M 均 0。审查报告 `same-revision-pull-round1-review.md` 留存于本计划 SDD 目录。

Controller 再次完整检查 exit 0：66 files / 1313 tests，format、typecheck、build、bundle、release metadata 全通过，lint 0 errors / 17 既有 warnings；最终 audit exit 0 / 0 vulnerabilities。日志 `/tmp/agentwiki-same-revision-controller-final-20260908.log`、`/tmp/agentwiki-same-revision-controller-final-audit-20260908.json`。

最终候选手机资产：

| 文件                   | SHA256                                                             |
| ---------------------- | ------------------------------------------------------------------ |
| main.js（1713839 B）   | `277116a922367f65c34ec4bc235308876c8003e1d4da5918250c890b410b3c27` |
| manifest.json（0.4.0） | `7b001849eafc37311a720c56d62f37704b1697ea75a4a5b801423d4be443daee` |
| styles.css             | `5dfe15839220724a57a64ad7ab136761ba2ffaaff3c0235faac1cf1238e762b8` |

安装前确认前台 md.obsidian，三个旧文件备份在 `/tmp/agentwiki-reviewed-phone-Mv5fmV/`；未复制 data.json 或凭据。停止 Obsidian 后安装，逐文件比对哈希，启动后 PID 29365，实际 Vault NeoMei-Docs / 插件 0.4.0。

注意：重启后的预检发现测试笔记末尾已有额外本地文字，非 controller 本轮写入。未删除、覆盖或上传它；确认前记录实际正文 hash，再验证修复后完全相同，不能用旧固定文本断言或手改正文掩盖差异。

| 新候选真实操作         | 结果与事实                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 原失败场景复现         | 将已备份合成图片移入 Obsidian 回收站，确认原路径缺失；真实 `runSyncStrategy(..., 'server', {})` 打开新增一张图片的预览  |
| 固定版本下载           | GET 原 revision `cmtshhmmw006l1368c5d8b50v` / attachment `4190a38b-9498-45ab-8890-f25b8c8e4372` / content，200、12997 B |
| 窄屏预览与确认         | 图片文件名、大小、取消及确认执行均可见；严格匹配只有图片恢复的 modal，于 `2026-09-08T10:38:34.279Z` 点击确认            |
| 真实文件应用           | 图片 exists=true，12997 B，SHA256 `73ec9c4efc4245505911494867b3f59a6ace2995f25866440a8198383b5a9bc4`；没有手工恢复      |
| 本地文字及其他映射保留 | 正文确认前后 hash 均为 `8d4b8105370f2a9a448ecadfbe0d9d99b70100c3a2cfee7c363d5a7b21668a33`；otherMappingsUnchanged=true  |
| 零远端写入             | 所有审计请求均 GET；remote revision 不变、sequence 4、attachmentCount 1；complete 父日志 verifiedTarget 仍是该 revision |
| 再次拉取               | “服务器没有新的变更可应用。”；无 modal、无 content 下载、全 GET                                                         |
| 真机显示               | 阅读模式实际 Android local image 已加载，480×270；非仅文件存在                                                          |
| 完整进程重启后持久化   | PID 29365 → 31281；三个安装哈希仍一致，正文及图片哈希保持，480×270 显示，远端 sequence 4，无 modal                      |

`verify-repair-evidence.mjs` 对原图字节、固定 revision、真实下载、正文不变、其他映射不变、父日志以及重复 no-op 的断言全部 PASS。证据在 `/tmp/agentwiki-final-device-acceptance.iqmVnP/`：`android-repair-preview.json/png`、`android-repair-confirm.json`、`android-repair-result.json`、`android-repair-noop.json`、`android-repair-render.json/png`、`android-repair-restarted.json`、`android-repair-restarted-render.json`。回收站图片及独立备份保留，可恢复；最终原路径已由插件恢复。

### 尚未完成的独立门

- 新候选桌面完整矩阵：NOT_RUN，桌面 CLI socket 缺失且真实库处于编辑窗口，未重启全部 Vault 或修改 CLI 配置。
- 公网四个独立 legacy fixture 的六项升级/丢响应恢复：NOT_RUN，旧 renderer provider 不满足当前契约，且桌面通道不可用。
- 更广的新候选设备场景（首次图片升级、特殊路径、冲突分页等）仍按 Task 7 待补；旧候选历史 PASS 不自动升级为新候选 PASS。
- GitHub 0.4.0 发布与正式资产验收：未进行；服务器本轮未更改/重部署。本段关闭的是明确的同版本缺图恢复缺口，不代表全部发布任务完成。

## 最终 277116a9 候选：完整进程离线补验

在当前最终包再次执行真实 Android 断网与进程重启：PID 31281 → 20989，重启时 Wi-Fi 和移动数据均为 0；本地图片实际解码 480×270，SHA256 仍为 `73ec9c4efc4245505911494867b3f59a6ace2995f25866440a8198383b5a9bc4`。WebView fetch 失败，真实插件原生同步返回 UnknownHostException，无写入确认。脚本 finally 恢复两种网络为 1；独立复查也均为 1。

恢复网络后，真实 v3 head 返回 sequence 4 / revision `cmtshhmmw006l1368c5d8b50v`，Push 预览可生成，笔记前后完全相同，两个映射保持。测试笔记已有用户后续本地文字，未删除、覆盖或确认上传；本轮因此只证明网络恢复和预览可用，不把它宣称为“无变更同步”。

证据：`/tmp/agentwiki-public-recovery.pgeSQl/android-final-offline.jsonl`、`android-final-offline.png`、`phone-restored-check.js`。先前旧包离线记录仍单独保留，不混用候选。

## 公网门关闭与当前设备边界

2026-09-08 21:42:19 开始的原版公网六项验收已 **6/6 PASS**，最终候选 main.js 仍为 `277116a9…`；迁移、完整恢复日志、原失败记录及临时凭据撤销见 [公网恢复记录](2026-09-08-public-recovery-setup.md)。此结果不替代真实 Android 首图升级等设备场景。

本轮末次 ADB 检查：`da9b6817` / PJE110 / transport 21 在线，但当前前台为抖音而非 Obsidian。未抢占应用、绕过锁屏或修改手机文件；已异步请用户方便时切回 NeoMei-Docs 并留出操作时间。剩余真机项和发布资产验收保持未完成，不将设备连接状态记为 PASS。
