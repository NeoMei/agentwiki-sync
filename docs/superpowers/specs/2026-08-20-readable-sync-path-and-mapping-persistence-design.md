# AgentWiki 可读同步路径与 Obsidian 映射持久化设计

## 目标

解决 AgentWiki Sync 0.2.7 实际同步中的两个发布阻断问题：

1. Obsidian 中已配置的 Space 与 Vault 目录映射在重启、升级或设备本地存储变化后丢失，导致用户反复设置同步目录。
2. AgentWiki 网页创建的页面使用 `pages/p-<opaque-key>.md` 作为规范同步路径，导致 Obsidian 文件名不可读。

最终行为由用户确认：文件名优先为 `文章标题.md`，重名时依次为 `文章标题 (2).md`、`文章标题 (3).md`；AgentWiki 标题变化时自动重命名 Obsidian 文件；正文字节保留，不删除与标题相同的一级标题。

## 范围与仓库边界

- 插件仓库 `AgentWiki-Obsidian`：负责 Vault 相对映射的持久化、迁移、缺失目录状态和同步 UI。
- AgentWiki 主仓库：负责规范 `syncPath`、标题驱动的路径重命名、全 Space 唯一性、旧 opaque 路径迁移和 Revision 写入。
- 同步协议保持 `pageId/path/title/body/contentHash` 字段不变；`path` 仍是各客户端共享的权威规范路径，不引入插件私有别名协议。
- 不修改正文内容，不从正文中提取或删除 Markdown 标题。
- 凭据、deviceId、vaultId 和连接会话仍为设备本地状态，不写入 Vault。

## 方案选择

### 采用：服务端规范可读路径 + 插件持久映射

服务端分配且持久化可读 `syncPath`，所有客户端使用同一路径。插件仅将返回的权威路径安全映射到 Vault，不维护另一套本地别名。

### 未采用：仅插件本地别名

该方案可避免服务端改动，但会让远端 path、本地 path 与 Push path 分裂，显著增加双端改名、基线恢复和路径冲突的复杂度。

### 未采用：Pull 后立即重命名并 Push

该方案会产生额外 Revision，首次绑定可能出现路径竞争，且无法保证其他客户端观察到一致语义。

## 规范路径分配

### 候选名生成

1. 使用页面标题生成 Markdown 文件 basename，保留 Unicode 人类可读字符。
2. 将 `/` 和 `\` 等路径分隔符、NUL/控制字符及 Windows 非法尾部字符替换为空格或安全连字符，合并连续空白并去除首尾空白。
3. 若结果为空、`.`、`..` 或 Windows device basename，使用本地化的安全回退名 `未命名文章`。
4. 路径必须通过同步协议的 NFC/casefold 可移植路径校验。

### 目录与重名

- 网页新建页面默认目录为 `pages/`，候选路径为 `pages/<safe-title>.md`。
- 对 Space 内 `syncPathKey` 执行 Unicode full casefold 唯一性检查。若占用，从 `(2)` 开始选择最小可用正整数。
- 分配完成后路径持久化，不因其他页面被删除而自动收缩序号，避免无关重命名。
- 从 Obsidian 创建的页面保留用户确认的合法相对路径。

### 标题与规范路径解耦

- `title` 与文件 basename 不是恒等关系。服务端为解决重名、非法字符、保留名或长度限制而生成的规范路径，不能反向改写页面标题。
- Obsidian 扫描文件后先按基线路径恢复 `pageId`。当本地路径与该页面的基线路径逐字 NFC 一致时，本地候选标题沿用基线 `title`，不再从 basename 推导；因此 `重复标题 (2).md` 可以继续代表标题为 `重复标题` 的第二篇页面。
- 当路径确实改变时，包括大小写变化、目录移动或 basename 改名，仍从新 basename 推导本地候选标题并进入现有 rename/三方合并流程。
- 新建且尚无基线身份的本地文件继续从 basename 推导标题。
- 不使用“剥离 ` (n)`”规则，因为用户可能真的创建标题为 `文章 (2)` 的页面；不向正文或 frontmatter 写入隐藏标题元数据，以满足保留原文要求。

### 标题变更

- AgentWiki Web 修改标题时，在原 `syncPath` 目录中为新标题分配 basename，并在同一数据库事务中更新 `syncPath/syncPathKey`、写入 PageVersion 和新 Revision。
- 标题的安全化结果未改变 basename 时不生成路径变更。
- Obsidian 本地同时改名时，依据 base/local/remote 三方路径比较进入现有 path conflict，禁止静默覆盖。

## 旧 opaque 路径迁移

- 迁移对象仅限于能被严格识别为 `pages/p-<64 hex>.md` 的服务端回退路径，不猜测其他用户路径。
- 按稳定顺序（建议 `knowledgeKey` 升序）为同一 Space 分配标题路径，保证重试得到同一结果。
- 单个 Space 的路径更新、PageVersion 审计和 Revision 推进在一个持有共享 Space 锁的数据库事务中完成。任一碰撞或写入失败时整个 Space 回滚；迁移批次本身幂等，失败后由操作者重新运行，不在 allocator 内重试。
- 迁移不修改 `title`、`content`、`contentHash` 或 `knowledgeKey`，仅产生可观察的 path rename Revision。
- 迁移后插件的普通 Pull 将远端 path 变化应用为 Vault 重命名；不设计额外专用 API。

## Obsidian 映射持久化

### 状态拆分

Vault 插件 `data.json` 只保存可同步、非秘密的配置：

- schemaVersion
- serverUrl
- `mappings[]` 中的 spaceId、rootPath 和 pending/active 状态

设备本地存储继续保存：

- serverInstanceId
- connection-state
- deviceId / vaultId 绑定
- Secret Storage 凭据引用

`data.json` 不保存 credentialId、secretId、连接码或任何密钥。

### 加载与迁移

1. 启动时分别读取并校验 `data.json` 的 Vault 配置和设备本地连接状态。
2. 若新 Vault 配置缺失，从现有 `agentwiki-sync:device-settings.json` envelope 一次性导入 serverUrl 和 mappings，验证后写入 `data.json`。
3. 若两份配置同时存在，新 Vault 配置为映射权威来源；设备连接状态只提供本机身份，不能清空 mappings。
4. 成功加载后不再使用 `saveData(DEFAULT_SETTINGS)` 清空持久配置。
5. 配置写入使用 Obsidian `saveData()` 的原生原子语义；保留现有结构校验和路径重叠检查。

### 目录缺失

- 映射的 `rootPath` 不存在时，映射记录仍保留。
- 同步中心和设置页显示“映射目录不存在”，阻止扫描/Pull/Push，并允许用户重建目录或更换映射。
- 不因目录暂时缺失、移动端延迟同步或启动顺序删除映射。

## 一致性与故障处理

- `ReadableSyncPathService.allocate()` 只是候选路径选择器，不保留路径，也不在内部捕获唯一冲突重试。所有生产调用点必须先在同一个数据库事务内取得共享 Space advisory lock，再执行候选路径读取和 Page 写入。
- 数据库 `UNIQUE(spaceId, syncPathKey)` 是最终不变量。Web、ChangeSet、版本恢复、Obsidian finalize、可读路径迁移和旧 `backfill:sync-v1` 必须共用同一 Space 锁键；backfill 在每 Space 的相关变更窗口全程持锁。
- 只有明确支持的外层事务边界可以做有界重试；例如 Obsidian finalize 对精确的 PostgreSQL serialization failure 重试整个事务。不允许对普通 `P2002` 或不明确的异常扩大重试范围。
- Revision 只能在 Page 路径变更与审计版本同一事务中成功后推进。
- 插件持久化校验失败时保留上一份可读配置，显示可操作错误，不退回空 mappings。
- 路径重命名继续使用现有 Pull transaction、Vault CAS 和回滚机制；双端改名继续进入显式冲突。

## 测试与验收

### AgentWiki 主项目

- 中文、英文、emoji、斜杠、控制字符、空标题和 Windows device basename 的安全文件名。
- Unicode NFC/casefold 碰撞、大小写碰撞、并发创建和最小序号分配。
- Web 创建、标题修改、标题不变、子目录保留、PageVersion 和 Revision 原子性。
- 只迁移严格 opaque 路径，不改正文/标题/pageId，迁移可重试，碰撞整 Space 回滚。
- Snapshot/Delta/head/finalize 的 `revisionContentHash` 一致。

### Obsidian 插件

- 从 0.2.7 设备本地 envelope 迁移映射到 `data.json`。
- 重启、禁用/启用、插件更新和无连接状态时映射仍存在。
- 另一设备的 Vault 配置不复制设备凭据，但保留相对映射。
- 目录缺失时显示错误且不清空配置。
- 两篇同名远端页面首次 Pull 为 `标题.md` 与 `标题 (2).md` 后，本地状态必须为零变更，不得立即产生标题 Push；正文与基线哈希保持一致。
- 用户真实重命名 `标题 (2).md` 时仍应同时得到 path rename 与新 basename 对应的标题变化，不能被基线标题吞掉。
- 远端 path rename 在本地无改名时自动重命名，双端改名时产生 path conflict。
- `# 标题` 等正文保持逐字节一致。
- PC 和移动端真实 Obsidian 接受测试：连接、重启、首次 Pull、标题改名、重名、双端冲突、再次同步及断网恢复。

## 发布门槛

- 两仓的定向测试、全量测试、lint、typecheck 和 build 全部通过。
- AgentWiki 服务端升级与旧路径迁移先于插件新版发布，并保留可验证回滚点。
- 在独立测试 Vault 完成真实交互验收，不使用用户主 Vault 作为开发测试场。
- 新版发布后再运行 Obsidian 社区审核预扫描；当前 0.2.7 不提交审核通过声明。
