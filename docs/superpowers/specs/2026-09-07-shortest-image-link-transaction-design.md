# Obsidian 短图片链接规范化与可恢复写回

日期：2026-09-07。状态：用户已确认本书面规格；进入实施计划阶段，尚未实施。

基于插件隔离分支 `codex/referenced-image-sync-v3`、源码 `70bf4ae300f325e12b259c10c9ff6d74f83a5c68`。这是既有图片同步和首次图片升级设计的窄范围补充，不重新执行已完成的 U1–U6，不替代原 U7 验收与发布门。

前置权威：[图片同步设计](2026-09-04-referenced-image-sync-v3-design.md)、[首次图片升级设计](2026-09-06-local-first-image-upgrade-design.md)。本补充仅覆盖短链接本地规范化及普通 Push 本地写回所有权；其他约束仍由前置设计决定。

## 1. 问题、目标和非目标

真实 Android FileManager 将图片改名后，Obsidian 在“仅此一次”更新链接中把 `![alt](../assets/old.png)` 改成 `![alt](new.png)`。手机能够显示，但公开 Markdown 规则从 Page 所在目录解析该目标，插件因此阻塞。这个规则本身不应被放宽。

目标：在插件本地边界确认短链接实际指向唯一的受管图片，预览标准相对路径修正；用户确认后，使云端正文与本地规范化写回沿同一份持久计划完成，并能在中断后安全恢复。

固定范围：

- 仅处理映射内 `pages/**/*.md` 引用的、映射内平铺 `assets/<name>` 的 PNG/JPEG/WebP/GIF。
- 不扫描上传整个附件目录，不读取未引用图片字节，不新建附件管理入口。
- 不修改服务器、公开协议包或公共 Markdown 解析语义；标准 Markdown 仍按 Page 相对路径解析，旧裸名 wiki 嵌入规则不变。
- 不修改 Obsidian 全局链接设置，不在 rename 事件、扫描或未确认预览中改业务文件。
- 不自动规范化整个 Vault，不改普通页面链接、外链、正文示例或其他映射。
- 不新增自动覆盖晚编辑、自动降级、强制完成日志或伪造远端成功的功能。

仅在内存改正文无法满足目标：现有普通 v3 Push 会先提交远端基线，未把规范化正文写入 Vault。事后无日志地补一次写入也不能证明崩溃恢复。选择“可恢复的本地计划”，而不采用上述两种方案。

## 2. 本地解析边界

### 2.1 候选与权限范围

复用现有 Markdown 解析器及 source range。只有语法完整的标准 Markdown 图片，且解码目标是无斜杠、无反斜杠的受支持图片文件名，才允许尝试 Obsidian 短链接解析。

排除 URI、绝对路径、盘符、路径穿越、非法编码、非法目标或 title、code span/fence、缩进代码、注释。不得仅因公开解析器返回 invalid 就走兼容路径；“路径不符合受管目录”与“语法非法”必须能区分。

`VaultPort` 增加可选的、只返回受控路径及缺失/歧义/越界结果的短链接解析能力。没有此能力时维持现有严格阻塞，不按文件名猜测。

Obsidian adapter 使用公开 metadata API 获取实际链接目标，并用仅含路径的文件元数据索引证明整个 Vault 中 basename 的 NFC/case-fold 唯一性。必须同时满足：

1. 只有一个同名文件，且它与 Obsidian metadata 解析结果是同一文件；
2. 它属于当前映射的平铺 assets，扩展名受支持；
3. 当前映射的资产路径/身份碰撞校验仍通过。

同名外部文件也构成歧义。拒绝时不暴露其他映射的完整路径或读取其内容。索引随 create/delete/rename 失效；确认前重新验证，不能把预览时的唯一性当作永久授权。

### 2.2 精确改写和扫描证据

复用、必要时提取 `attachment-merge.ts` 已有相对路径及目标样式工具，不复制解析器。只修改 source range 对应的目标 token；保留 alt、title、角括号、可等价保留的百分号编码/反斜杠转义和其他内容。新文件名中的空格、括号、百分号等必须正确编码，改写后重新走公开解析器验证。

canonical Page body、contentHash 和 referencedAttachmentIds 使用规范化结果；`rawPathStates` 始终记录原始 Vault 字节，不能被 canonical hash 替换。

扫描额外返回按 Page path 排序的本地规范化证据：Page ID、映射相对路径、原字节 hash、规范化 contentHash、精确替换列表及解析目标证据。无规范化时返回空集合。只读扫描不持久化业务更改。

原字节 hash、规范化计划、映射及身份绑定共同参与本地授权。确认时重新计算，元数据目标、正文、路径或身份有变化均使旧预览失效。

## 3. 预览、授权与所有权

预览在既有同步弹窗展示“本地图片链接修正”、受影响 Page 数及相对路径，保留现有远端变化/图片传输/冲突列表。显示的本地变化必须进入授权 hash，不能只有 wire confirmationHash。

授权至少绑定：server origin/instance、Space、device、credential ID、Vault ID、映射根、基线 revision/hash、capabilitiesHash、wire confirmationHash、规范化候选 hash、本地计划 hash、预览扫描证据。只存非秘密身份 ID。

本地计划仅含 `write_page` 动作：明确 Page ID、目标路径、原字节预条件、canonical payload hash/长度及受控 sidecar 引用。复用原有配额；原字节证据与 canonical 暂存各自有界，不绕过 Page/累计正文限制。

允许 scoped 私有暂存；确认前禁止 session/create、Blob 上传、远端发布、业务文件写入和基线切换。取消仅清理本预览自己的暂存。

确认后、任何网络写入之前，先验证授权并持久化操作及完整 payload 证据。恢复只能重放这份计划，不根据当前文件重新猜一个“相近计划”。

## 4. 普通 Push 的协调边界与日志版本

### 4.1 采用父协调日志，复用两个现有子引擎

为包含本地规范化动作的普通 v3 Push 引入 schema 4 父日志，放在既有 device/Space 的 `push/journal.json` 调度入口。它拥有确认绑定、本地计划及跨阶段归属；不复制上传引擎。

- 远端子操作复用现有 `TreePushServiceV3` 和 schema 3 子日志，独占 session、receipt、Finalize result 事实。
- 本地子操作复用现有 deferred `TreeTransaction`，独占文件操作、回滚和应用事实。
- 父协调器只引用子操作身份及已校验目标 revision/hash，不另外维护一套可独立推进的 session/result。
- 没有本地规范化动作的现有普通 Push 保留既有 schema 3 路径；首次图片升级继续由已有升级父意图拥有，不能再套一层普通 Push 父操作。

每个操作使用一个固定 operationId。其私有目录为 `push/operations/<operationId>/`，远端子根为 `remote/`、本地子根为 `local/`、计划正文为 `payload/`、身份后状态为 `control-after.json`。所有引用必须严格推导并校验，禁止任意 path 注入。

父日志字段：schemaVersion=4、protocolVersion=3、mode、操作/身份绑定、源 revision/hash、capabilitiesHash、wire confirmationHash、candidateHash、localPlanHash、authorizationHash、localTransactionId、受控 payload 描述、本地计划、phase、verifiedTarget（未校验时 null）。

`mode` 为 `remote_push` 或 `local_only`；`phase` 为 `confirmed | remote_pending | local_pending | complete | superseded`。阶段不能替代子日志证明。remote_push 的 operationId 同时作为远端幂等键；local_only 不创建远端子日志。

严格状态关系：local_only 不允许 remote_pending 或远端子日志；local_pending 必须有 verifiedTarget；remote_push 的 verifiedTarget 必须与同归属已发布子日志一致。complete 必须有同归属 committed 文件事务、正确 baseline/身份完成证明，且 remote_push 子日志已 locally verified。superseded 不允许已发布证明或任何未终结/已成功的本地子事务。不能通过只改 phase 满足这些条件。

终结 guard 验证保留的事务/版本完成证据，不要求完成后的当前 Vault 或 current baseline 永远不变；后来的正常编辑和 Pull 不能使旧 complete 反向变成 pending。已完成清理后不再依赖被合法删除的正文 sidecars。local_only 的既有目标证明不是本操作“已发布”证明，不能显示为新增发布成功。

### 4.2 兼容与恢复优先

公共协议仍为 v3，私有 schema 4 不代表服务器协议升级。

- 新版本继续读取旧 schema 1/2/3，并按原所有者恢复；不把旧记录补字段伪装成已确认规范化。
- schema 4 必须使用新的严格 guard；旧 schema 3 guard 不接受它。首次升级的旧子日志 guard 保持原语义。
- 普通 Push 调度、最低协议判断、状态/取消/删除映射入口和日志候选选择都要识别 schema 4；未完成父操作先恢复，不能被普通 Push/Pull 或升级绕过。
- 主文件、prev、next 按现有 envelope/hash/generation 规则读，允许经过验证的终结旧 schema 3 向新 schema 4 代际推进；高代际未知版、损坏、同代际分叉或归属不匹配保留并阻止继续。
- 新操作只能替代已证实终结的旧操作。先保留所需旧证据，再按既有 envelope 原子代际写入，不能清掉 pending 后重建。
- 后续无规范化的普通 Push 在 schema 4 完成后使用新 writer 对终结记录的兼容转换，不把 schema 4 交给旧 schema 3 service 强行解析。旧插件遇 schema 4 应明确不支持而停下；禁止自动降级/覆盖。

## 5. 正常顺序和无远端变化的情况

### 5.1 有远端变化

1. 固定读取/校验基线与远端 head，生成规范化候选和完整预览。
2. 用户确认，重验固定输入和授权，持久父计划；再创建同 operationId 的远端子操作。
3. 复用现有 session、分块、batch、Finalize；创建与 Finalize 前仍重验权限、能力、源 head 和完整本地授权。
4. 获得已发布结果后，读取返回的固定 revision，验证快照/正文/附件集合/hash 与确认候选一致；不把当前更晚 head 替代它。
5. 持久 verifiedTarget，进入 local_pending。核对所有受影响路径的原字节预条件，再准备 deferred TreeTransaction；记录同 transactionId 的身份后状态。
6. 应用并验证本地规范化结果，`markVerified`；之后才切换到该目标的 baseline，提交身份后状态，`markCommitted`。
7. 标远端子日志本地 verified；再交叉验证所有归属及完成证据，标父日志 complete，定向清理父操作不再需要的 sidecars。远端子日志清理不能删除父操作仍需的独立计划/payload 证据。完整终结元数据保留供重试和旧候选判别。

规范化只写已确认的 Page，不重写全部本地树。验证必须比较真实字节对应的 canonical 正文，不能再次虚拟规范化后掩盖未写回。未改动页面的后续本地编辑仍按原 pending 规则保留，不要求整个 Vault 字节等于远端。

### 5.2 只有本地链接需要修正

wire changes 为空而本地计划非空时，显示“确认修正本地链接”，不显示无变更并退出。使用 mode=local_only 的同一协调/事务边界：

- 目标固定为已校验的现有源 revision/hash；该 revision 中对应 Page 必须正好是计划的 canonical 结果。
- 不调用 session/create、Blob 上传或 Finalize，不制造空 Revision，不伪造成功 result。
- 确认时重验 head、权限及所有本地输入，然后只执行本地计划；baseline 保持原 revision。
- 恢复时只校验原固定目标，不追逐后来的 current；完成后再进行正常新版本 Pull。

wire 和本地计划都为空才是无操作。规范化-only 也必须经过用户确认和晚编辑保护。

## 6. 中断、晚编辑与取消

| 已证实状态                           | 必须采取的行为                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| 未确认预览                           | 无远端/业务文件写入；重新预览                                                     |
| confirmed、尚无子操作                | remote_push 重验原授权后创建同归属子操作；local_only 验证固定目标后进入本地事务   |
| create/Finalize 响应丢失             | 查询或幂等重试原 session；网络未知保持 pending，不能当未发布                      |
| 已发布、固定快照尚未验证             | 继续读取校验原 revision；不再次发布、不改 baseline                                |
| 原文件预条件失效                     | 保留新编辑和原证据，显示“远端已发布，本地待处理”；不覆盖、不推进 baseline         |
| 本地应用未验证时中断                 | 由 TreeTransaction 校验并回滚其自己的写入；遇第三方修改保持 ambiguous，不强行还原 |
| 本地已 verified、baseline 未完成     | 校验同一事务及字节，沿既有 baseline journal 恢复；不能无条件回滚或重建计划        |
| baseline 已切换、身份未完成          | 用已持久的同归属 control-after 完成；缺失/冲突证据阻止继续                        |
| tree 已 committed、父日志未 complete | 交叉验证后幂等补齐完成标记；不重复写文件或上传                                    |
| complete                             | 验证终态并仅清理本操作已不再需要的 sidecars                                       |

晚编辑处理不增加隐式覆盖入口。提供查看受影响笔记与重试；恢复只在文件满足原预条件，或有匹配子事务证明已写入确认结果时前进。仅凭文件碰巧等于目标不能冒认事务所有权。需要保留新内容并改变原计划时，必须经过新的显式预览/合并决定，不自动替换旧授权；未获得决定前保持可诊断 pending，不能通过清日志宣称成功。

表中“远端已发布，本地待处理”只用于 remote_push。local_only 遇晚编辑显示“本地链接修正待处理，未发布云端版本”，不能借用远端成功提示。

取消仍分阶段：未开始远端写入可终结为 superseded；传输期间只有权威未发布/abort 证明才可终结；Finalize 已发出先查结果；已发布不能取消成“未发布”。local_only 进入文件应用后也必须先到安全终态。禁止清理未终结子事务的回滚/结果文件。

## 7. Pull 与首次图片升级的接线

短链接规范化在共享本地扫描边界生效，但 wire parser 不变：

- 现有 Pull 和首次图片升级已有 local plan/TreeTransaction，复用其所有权，不引入新父操作。
- 规范化证据必须进入其冻结输入、local plan 和授权 hash；tree-diff 不能因“内存规范化 local 等于 final”而删除实际仍需要的 write_page。
- 若冲突选择丢弃某项本地结果，依据最终已确认 Page 重算动作，不能强制把被丢弃的本地规范化写回来。
- scanEpoch、rawPathStates、before-state 和确认时新碰撞校验不能被规范化层绕开。
- legacy v1/v2 文字路径不因此开始传图；已有首次图片升级分流和一次确认边界不变。

## 8. 模块职责

实施计划应保持以下边界，不把新业务全部堆进 SyncRuntime：

| 模块职责                      | 范围                                                      |
| ----------------------------- | --------------------------------------------------------- |
| Obsidian resolver + VaultPort | 公共 metadata 解析、唯一性/映射边界；不读图片字节         |
| 本地规范化计算                | source range 精确改写、canonical/raw 双证据；无业务写入   |
| 规范化计划/状态仓库           | 严格 schema、授权/sidecar/归属校验、代际兼容              |
| 普通 Push 协调器              | 父日志与既有远端/本地子操作串联；不复制上传或文件事务算法 |
| Runtime 与现有 Pull/升级入口  | 调度、恢复优先、现有计划接线和 UI delegation              |
| 同步预览/恢复 UI              | 展示本地变化、零远端变化确认、准确 pending/取消状态       |

具体文件及类型签名在书面规格通过后的实施计划中确定。只允许为这些职责提取现有共享逻辑，不进行无关结构重写。

## 9. 验收与发布门

TDD 先证明真实行为失败，再实现。重点门如下：

1. 解析/安全：标准短名、编码/转义/title/角括号；跨 Vault 重名、缺失、路径逃逸、类型不符、metadata 分歧拒绝；code/comment 原样保留。
2. 扫描/授权：canonical hash 与原字节 hash 区分；无预览业务写入；未引用图零读取；确认时新重名/本地修改使旧授权失败。
3. 普通 Push：真入口预览→确认→固定远端发布→事务写回→baseline/身份完成；附件 ID 保持、同 bytes 不重传、下一次完整同步零动作。
4. local_only：有确认且本地写回；session/Blob/Finalize 次数全部为零，远端 revision 不变。
5. 日志/恢复：旧 schema 1/2/3、4 的两种 mode、prev/next 混合代际、未来版本、篡改/丢失 sidecar、错误归属、重复恢复、取消；上述每个网络及本地提交边界故障注入。
6. 晚编辑：发布前失效；发布后保留文件且 pending、不提前提交 baseline、不重发；第三方改动不能被 rollback 清除。
7. 共享路径：Pull/首次升级保留真实 write_page，最终冲突选择被尊重；原 v1/v2/v3、稳定身份、detach/re-reference 回归不退化。
8. 真实设备：最终同一 bundle 在原 Android 重命名失败样例复测，不手工换写法绕过；桌面隔离 Vault 与 Android 的首图/下载/离线/窄屏/恢复矩阵补齐。用户在使用手机或设备锁定时暂停，不绕过锁屏。
9. 最终 npm run check、audit、各任务/修复独立审查、原 Task19 与 whole-branch review、真实公网原子升级/丢响应门全部完成后，才恢复0.4.0发布。现有服务器部署及包版本独立核验，不为插件本地修复制定无关服务器部署。

书面规格通过不代表实现、真机通过或发布完成。原合成样例、旧日志、回滚证据及其他用户文件继续保留。
