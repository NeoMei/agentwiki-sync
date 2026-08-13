# AgentWiki Sync Obsidian 插件设计

## 文档状态

- 产品名称：`AgentWiki Sync`
- Obsidian 插件 ID：`agentwiki-sync`
- 设计确认日期：2026-08-13
- 状态：已完成对话确认，等待书面 spec 复核
- 依赖契约：[`docs/contracts/agentwiki-obsidian-sync-api-v1.md`](../../contracts/agentwiki-obsidian-sync-api-v1.md)

## 1. 背景与目标

AgentWiki Sync 是独立发布、独立版本化的 Obsidian 社区插件。首版目标是让一个 Obsidian Vault 通过 AgentWiki 同步多个 Space，从而以 AgentWiki 替代传统公共 Vault 的多端共享方式。

首版交付一个可验证的手动同步闭环：

1. 用户在 Obsidian 设置页内以 AgentWiki 人类身份连接设备。
2. 一个 Vault 可以映射多个 AgentWiki Space，每个 Space 对应一个互不重叠的目录。
3. 用户通过 `Status`、`Pull`、`Push` 完成 Git 风格同步。
4. 所有本地写入和远端发布均先预览、后确认。
5. 同步同时支持 Obsidian 桌面端和移动端。

未来 Claudian 等 Agent 可以调用相同的同步用例，但不属于首版。未来 Agent 只能发起预览，不能读取设备凭据，也不能绕过 Obsidian 内的人类确认。

## 2. 首版范围

### 2.1 包含

- 一个 Vault 连接一个 AgentWiki 服务。
- 一个 Vault 映射多个 Space。
- 每个 Space 映射一个 Vault 相对目录。
- 映射目录互不相同、互不嵌套。
- 仅同步映射目录中 Obsidian Vault API 可见的 `.md` 文件。
- 保留 Markdown 的嵌套相对目录结构。
- 提供设置页、功能区入口、同步中心、命令面板命令、预览和冲突解决界面。
- 提供首次绑定、Status、Pull、Push、可恢复删除、三方合并和事务回滚。
- 使用人类设备同步凭据，按当前用户和实时 Space 角色授权。
- 支持分页 Snapshot/Delta、分批上传和原子 finalize。
- 在单 Space 5,000 篇 Markdown、正文总计 100 MiB、单篇不超过 1 MiB 的基线下验收。

### 2.2 不包含

- 图片、音频、视频、PDF、Canvas 或其他二进制附件同步。
- AgentWiki Relation、Memory、Source 或附件模型同步。
- 自动检查、定时轮询、自动 Pull 或自动 Push。
- Stage、Unstage、Commit、部分文件 Push 或一键同步全部 Space。
- 在 Markdown 中写入 AgentWiki page ID、Space ID 或其他同步 frontmatter。
- 将 YAML frontmatter 解释为同步元数据；frontmatter 作为正文原样同步。
- Claudian、MCP 或其他 Agent 的实际接入。
- 在当前仓库修改 AgentWiki 主项目。
- 在首版中支持一个 Vault 连接多个 AgentWiki 服务。

## 3. 核心产品决策

### 3.1 Space 与目录

- Space 是同步、版本、事务和冲突处理的最小边界。
- 一个 Vault 可以绑定多个 Space。
- 每个 Space 绑定一个 Vault 相对目录，例如 `Knowledge/Product/`。
- 未映射目录完全不参与扫描和同步。
- 两个映射目录不能相同或相互嵌套。
- 映射目录不能包含 Vault 根目录的 `.agentwiki/` 控制目录。
- 首版不提供跨 Space 移动。把文件从一个映射目录移动到另一个映射目录，会在源 Space 中表现为归档、在目标 Space 中表现为新增，并分别预览确认。

### 3.2 Git 风格操作

首版采用轻量 Git 语义：

- `Status`：计算本地变化并轻量检查远端 revision head。
- `Pull`：取得远端变化、三方合并、预览并原子应用到 Vault。
- `Push`：确认远端没有领先后，预览并条件式发布本地变化。

没有暂存区和本地 commit。一个 Space 映射目录内的所有可同步变化进入该 Space 的 Push 预览。

### 3.3 页面映射

对映射目录 `Knowledge/Product/` 下的 `Guides/Setup.md`：

- AgentWiki `path`：`Guides/Setup.md`
- AgentWiki `title`：`Setup`
- AgentWiki `body`：文件的完整 Markdown 字符串
- AgentWiki `pageId`：稳定 UUID，由远端 Snapshot 取得或在本地新增页面第一次发布时生成

正文不要求首行是 H1。为避免远端 title 无法在纯 Markdown 中无损表示，title 使用以下方向性规则：

- 本地新增页面时，title 取文件名 stem。
- 本地移动但文件名未变时，只更新 path，保留 base title。
- 本地重命名文件时，title 更新为新文件名 stem。
- 远端 title-only 变化写入 manifest，不改名本地文件；后续 body-only Push 保留 manifest 中的远端 title，不用文件名覆盖它。

因此，只有本地新增或文件名变化会从文件名派生 title。移动或重命名不会生成新的 page ID。

### 3.4 文本规范化

- 传输编码为 UTF-8。
- 计算正文 hash、比较和上传前，将 `CRLF` 和单独的 `CR` 规范化为 `LF`。
- 是否包含末尾换行属于正文内容，必须保留在比较结果中。
- 正文不做 Unicode 归一化。
- 路径分隔符统一为 `/`，路径段进行 Unicode NFC 归一化。
- 为保证跨平台恢复，Status 必须拒绝 Unicode 归一化后重复或仅大小写不同的路径碰撞。
- 禁止绝对路径、空路径段、`.`、`..`、NUL 和逃逸映射根目录的路径。
- 路径最长 1,024 个字符，标题最长 500 个字符，规范化正文最长 1 MiB。

## 4. 架构

```mermaid
flowchart TB
    UI["Obsidian UI：设置页 / 同步中心 / 冲突视图"]
    CO["Sync Coordinator"]
    ST["Status Engine"]
    ME["Merge Engine"]
    TX["Transaction Engine"]
    VA["Vault Adapter"]
    CS["Control Store"]
    AC["AgentWiki Client"]
    PP["@neomei/agentwiki-sync-protocol"]
    API["AgentWiki HTTPS API"]

    UI --> CO
    CO --> ST
    CO --> ME
    CO --> TX
    ST --> VA
    ST --> CS
    ME --> CS
    TX --> VA
    TX --> CS
    CO --> AC
    AC --> PP
    AC --> API
```

### 4.1 Obsidian UI 外壳

负责展示状态、收集选择和取得确认。UI 不直接发 HTTP、不直接写 Vault，也不直接修改 manifest。

### 4.2 Sync Coordinator

负责 Status、Pull、Push 和首次绑定的用例编排：

- 根据活动文件或用户选择确定 Space。
- 对同一 Space 获取排他操作锁。
- 调用状态、合并、事务和 API 端口。
- 在任何写入前生成不可变预览。
- 校验用户确认对应的预览 hash。
- 把结构化进度和错误返回 UI。

不同 Space 逻辑上彼此隔离。首版不主动并行执行多个 Space 操作。

### 4.3 Status Engine

纯 TypeScript 模块，负责：

- 比较当前文件、manifest 和 base。
- 分类新增、修改、删除、移动/重命名和身份歧义。
- 检测路径碰撞、超限文件和不支持的附件链接。
- 生成 Push 输入和 Pull 的本地分支。

### 4.4 Merge Engine

纯 TypeScript 模块，负责 page identity、路径、标题和正文的三方比较。正文使用 `node-diff3` 3.x 逐行合并。输出只包含自动合并结果和结构化冲突块，不包含写文件行为。

### 4.5 Transaction Engine

负责把 Pull 计划转换为持久化事务：准备 journal、保存受影响文件快照、依序应用、推进 manifest、提交或回滚。

### 4.6 适配器

- `Vault Adapter`：仅通过 Obsidian Vault、FileManager、MetadataCache 和 Adapter API访问 Vault；不得使用 Node `fs`。
- `Control Store`：读写 `.agentwiki/` 下的 config、manifest、base 和 transaction。
- `AgentWiki Client`：通过 Obsidian 跨平台请求 API 调用公开 HTTPS API，并用稳定协议包做运行时校验。

### 4.7 公开协议包

`@neomei/agentwiki-sync-protocol` 只包含：

- 版本化 DTO 和运行时 Schema。
- 错误码。
- 规范化与 canonical serialization 规则。
- Snapshot、Delta 和 Push session 的协议类型。

协议包必须支持浏览器 ESM，不得依赖 Node 内置模块，不执行网络请求，不保存凭据。插件不得导入 AgentWiki 服务端或 `packages/local-sync` 的内部源码。

## 5. 本地状态模型

### 5.1 控制目录

```text
.agentwiki/
├── config.json
├── spaces/
│   └── <space-id>/
│       ├── manifest.json
│       └── base/
│           └── <page-id>.md
└── transactions/
    └── <transaction-id>/
        ├── journal.json
        └── snapshots/
```

`.agentwiki/` 永不进入 AgentWiki 同步 payload。所有内容只在本地 Vault 中使用。

### 5.2 `config.json`

```ts
interface AgentWikiConfigV1 {
  schemaVersion: 1;
  serverUrl: string;
  vaultId: string;
  credentialSecretId: string;
  spaces: Array<{
    spaceId: string;
    displayName: string;
    rootPath: string;
  }>;
}
```

- `serverUrl` 必须是无用户名和密码的绝对 URL。非 loopback 地址只允许 HTTPS。
- `vaultId` 是该 Vault 的随机 UUID，不是凭据。
- `credentialSecretId` 只是 Obsidian Secret Storage 中条目的引用名。
- 真正的设备凭据只存 Secret Storage。
- `deviceId` 使用 Obsidian vault-local local storage 保存，不进入 `.agentwiki/`，确保每台设备独立连接。

### 5.3 `manifest.json`

```ts
interface SpaceManifestV1 {
  schemaVersion: 1;
  protocolVersion: "1";
  spaceId: string;
  rootPath: string;
  baseRevision: string;
  lastSuccessfulSyncAt: string;
  pages: Record<string, {
    pageId: string;
    relativePath: string;
    title: string;
    contentHash: string;
    updatedAt: string;
  }>;
}
```

manifest 只在成功建立基线或成功完成 Pull/Push 后整体替换。临时或部分执行结果不得写入有效 manifest。

### 5.4 `base/`

`base/<page-id>.md` 保存对应 manifest 的共同基线正文，用于真正的 diff3。路径和标题在 manifest 中保存，因此页面移动不需要移动 base 文件。

### 5.5 重命名识别

重命名识别按以下优先级进行：

1. 插件运行期间监听到 Obsidian `rename` 事件时，记录原 page ID 到新路径的本地 move hint。
2. 事件缺失时，使用消失页面的 base hash 与新增路径的正文 hash 做唯一精确匹配。
3. 同一 hash 对应多个候选，或文件同时重命名和修改而没有 move hint 时，标记“身份需确认”。

不得使用内容相似度自动猜测 page identity。用户确认身份后，选择结果进入当前预览，不在确认前改写 manifest。

### 5.6 事务日志

事务 journal 使用 `kind: "pull_apply" | "push_upload"`。Pull journal 状态为：

- `prepared`
- `applying`
- `committing`
- `committed`
- `rolling_back`
- `failed`

快照记录受影响路径在事务前是否存在及其完整字节内容。插件启动和每个写操作前检查未清理事务：

- `prepared`、`applying`、`committing`：执行回滚。
- `committed`：完成安全清理。
- `rolling_back`：继续回滚。
- `failed`：冻结对应 Space，等待用户查看诊断并人工恢复。

Push journal 状态为：

- `uploading`
- `ready_to_finalize`
- `finalizing`
- `published`
- `aborted`
- `expired`

Push journal 保存 base revision、不可变预览 hash、idempotency key、远端 session ID 和已确认批次 receipt，不保存设备凭据。插件启动时不自动联网恢复 Push；用户下次打开同步中心时，插件查询 session 状态并显示“继续上传”“重新确认并 finalize”或“丢弃”。`finalizing` 状态必须先查询服务端结果，不能假定请求失败，也不能创建不同 payload 的新 session。

## 6. 身份、连接与权限

### 6.1 设置页内联连接

设置页依序显示：

1. AgentWiki 服务地址。
2. 一次性 Obsidian 连接码输入框。
3. `连接` 按钮和原地验证状态。
4. 连接成功后原地展开 Space 目录映射。

插件不自动打开浏览器、不弹出多步向导。用户可主动点击帮助链接或 AgentWiki 地址。

### 6.2 人类设备凭据

- 安装码只在交换请求期间存在内存，交换结束立即清除输入状态。
- 换取的凭据代表创建安装码的人类用户，而不是 Agent。
- 每台设备独立交换、独立撤销、独立审计。
- 每次请求重新检查用户有效状态。
- 每个 Space 操作重新检查实时角色。
- `viewer` 可 Status/Pull，不可 Push。
- `editor`、`admin`、`owner` 可在 Obsidian 内确认后直接发布。
- 设备凭据只允许 Obsidian 同步 API，不允许成员、Agent、凭据或审核管理。

完整服务端契约见 `docs/contracts/agentwiki-obsidian-sync-api-v1.md`。

## 7. Status

1. 活动文件位于某个映射目录时，默认选择该 Space；否则显示 Space 选择器。
2. 扫描该映射目录的可见 Markdown。
3. 与 manifest 和 base 比较，产生本地状态。
4. 请求远端 revision head，不下载正文。
5. 显示本地变化、远端是否领先、附件链接警告和阻塞错误。

状态分类：

- `clean`
- `added`
- `modified`
- `deleted`
- `renamed`
- `identity_required`
- `invalid`

离线或请求失败时仍显示本地分类，远端状态显示 `unknown`。Status 永不修改 Vault、manifest、base 或服务端。

## 8. Pull

### 8.1 常规 Pull

1. 获取 Space 操作锁。
2. 恢复或冻结未完成事务。
3. 从 `baseRevision` 分页获取 Delta；服务端无法提供该历史 revision 时获取固定 revision 的分页 Snapshot。
4. 构造 base、local、remote 三个分支。
5. 按 page ID 合并路径、标题和正文。
6. 非重叠正文改动自动合并；冲突转换为结构化冲突块。
7. 展示新增、修改、移动、回收站删除和冲突解决后的最终预览。
8. 用户确认后生成 journal 和文件快照。
9. 应用全部 Vault 变化。
10. 写入新的 base 和 manifest。
11. 标记 committed 并清理事务。

这是应用层原子性，不宣称操作系统级原子写入。

### 8.2 冲突条件

- 同一正文区间被两端修改。
- 一端删除、另一端修改。
- 同一页面被两端移动到不同路径。
- 多个页面最终占用同一路径。
- 本地 page identity 无法唯一判定。
- 两台设备基于同一 base 独立新增相同路径但产生不同 page ID。

存在任何未解决冲突时，不修改任何文件。相同路径的并发新增解决后必须保留一个 page ID；远端已存在 page ID 时优先沿用远端 ID，本地临时 ID 被丢弃。

### 8.3 删除

远端归档经 Pull 预览确认后，通过 Obsidian 回收站 API 移除本地文件。回收站操作失败会使整个 Pull 事务失败并回滚。

## 9. Push

1. 获取 Space 操作锁。
2. 计算本地变化并请求远端 revision head。
3. 远端领先或状态未知时禁止 Push，要求先 Pull。
4. 验证路径、正文大小、身份和协议限制。
5. 展示新增、修改、移动、归档和附件链接警告。
6. 以确认时的不可变内容快照计算 `confirmationHash` 和幂等键。
7. 建立 push session，并按服务端能力限制分批上传变更。
8. 所有批次完成后，携带 `baseRevision` 和 `confirmationHash` 执行原子 finalize。
9. 服务端重新检查用户、角色、base revision、批次 hash 和完整 payload hash。
10. 成功后用已确认快照更新 base 和 manifest revision。

本地删除在 Push payload 中表示 AgentWiki 页面归档，不执行物理删除。

用户可能在网络请求期间继续编辑。远端发布的是用户确认时的快照；发布成功后 base 也更新为该快照，之后的新编辑仍留在 Vault，并在下一次 Status 中显示为 `modified`。

服务端 finalize 返回 `BASE_STALE` 时不推进本地基线。网络重试复用幂等键；相同幂等键和相同 payload 返回原结果，相同幂等键和不同 payload 返回错误。

Push 上传和 finalize 状态写入 `kind: "push_upload"` 的本地 journal。finalize 响应丢失时，下次用户主动打开同步中心后查询同一 session；服务端已发布则按原确认快照推进 base，未发布则允许以同一 idempotency key 安全重试。

## 10. 首次绑定

首次绑定不假设共同基线：

- 本地空、远端有内容：显示 Clone 预览，确认后按 Pull 事务写入。
- 本地有内容、远端空：显示发布预览，确认后为每页生成 page ID 并按 Push session 发布。
- 两边都有内容：按规范化相对路径形成首次合并候选；同路径不同正文必须解决，确认后才创建共同 base。
- 两边都空：直接记录当前远端 revision 为空基线。

首次绑定失败或取消不得写入有效 manifest。换设备没有控制目录时，重新获取远端 Snapshot 并进入同一首次绑定流程。

## 11. 用户界面

### 11.1 同步入口

- 功能区图标打开轻量同步中心模态框。
- 命令面板注册 `AgentWiki: Status`、`AgentWiki: Pull`、`AgentWiki: Push`。
- 活动文件可确定 Space 时直接使用该 Space，否则显示选择器。
- 同步中心始终允许明确选择一个 Space。
- 首版不提供 `Push All` 或 `Pull All`。

### 11.2 同步中心

每个 Space 显示：

- 显示名和映射目录。
- 当前角色与读写能力。
- base revision。
- 本地新增、修改、删除和移动数量。
- 远端状态：一致、领先或未知。
- 当前操作、进度和可执行动作。

### 11.3 预览与取消

所有写操作必须显示文件级摘要和最终动作。扫描、下载、合并、上传阶段允许取消；Pull 开始事务写入后，以及 Push 开始 finalize 后，不允许用户中断，界面必须解释当前原子阶段。

### 11.4 冲突视图

- 桌面端并排显示 Base、Local、Remote。
- 移动端使用 Base、Local、Remote 标签页。
- 每个冲突块可以选择 Local、Remote 或直接编辑最终结果。
- 用户必须查看完整合并结果后才能确认。
- 不把 Git 冲突标记写入 Markdown。

## 12. 后台行为

首版严格手动：

- 插件加载时不发起远端请求。
- 文件事件只使本地状态缓存失效，并记录可靠的 rename hint。
- 只有打开同步中心或执行 Status/Pull/Push 才访问网络。
- 不注册定时轮询。
- 不在 Obsidian 启动或获得焦点时自动检查。

## 13. 错误处理与恢复

- 网络失败：不推进 manifest；Pull 不写文件；Push 保留可重试预览或上传会话信息。
- 权限撤销：停止当前操作并刷新该 Space 能力，不影响其他 Space 配置。
- `BASE_STALE`：停止 Push 并提示先 Pull。
- 协议不兼容：禁止同步，只显示诊断和升级建议。
- 控制目录损坏或 base 缺失：禁止 Push，通过首次绑定预览重新建立基线。
- Pull 应用失败或应用退出：下次启动根据 journal 回滚。
- 回滚失败：标记 `failed` 并冻结该 Space，同步操作不得继续覆盖。
- 同一 Space 的并发操作：第二个操作立即拒绝并显示正在进行的动作。
- 远端分页 cursor 失效：放弃当前预览并从固定 revision 重新请求，不混用两次分页结果。
- Push session 过期：重新检查 head、重新生成预览并取得确认；不得仅重建上传 session 后静默 finalize。
- finalize 响应丢失：保留 `finalizing` journal；下次用户主动操作时查询 session 状态，禁止猜测发布结果。

## 14. 诊断与隐私

诊断允许包含：

- 插件、Obsidian 和协议版本。
- Space ID、revision ID、事务 ID 和错误码。
- 文件相对路径、大小和内容 hash。
- 事务阶段、批次索引和 HTTP 状态码。

诊断默认禁止包含：

- Markdown 正文或 diff 内容。
- 安装码、设备凭据或 Secret Storage 值。
- Authorization、Cookie 或完整请求头。
- 未脱敏服务端响应正文。

复制诊断前必须展示最终文本预览。

## 15. 技术基线

- TypeScript 严格模式。
- Obsidian 原生 UI 组件，不引入 React。
- esbuild 生成单一插件运行时 bundle。
- Vitest 运行纯核心和适配器契约测试。
- `node-diff3` 3.x 提供浏览器兼容三方合并。
- Node.js 24 LTS 仅用于开发和 CI。
- npm lockfile 固定依赖树。
- `manifest.json` 设置 `minAppVersion: "1.11.5"`、`isDesktopOnly: false`。
- 运行时禁止 Node 内置模块、Shell、本地服务、daemon 和桌面专属文件系统 API。

## 16. 验证策略

### 16.1 单元测试

- 路径规范化、非法路径、Unicode/大小写碰撞和目录重叠。
- 状态分类和 rename hint/hash fallback/身份歧义。
- LF 规范化、hash、canonical serialization 和 confirmation hash。
- diff3 非重叠合并、重叠冲突、删除/修改和双向移动。
- 首次 Clone、本地首次发布和首次双方合并。
- 权限能力映射和错误码到 UI 状态的转换。
- 诊断脱敏。

### 16.2 适配器与故障注入测试

- 使用内存 Vault 和 fake HTTP 实现测试端口契约。
- 在每个 Pull journal 阶段注入异常，验证回滚或冻结结果。
- 验证回收站失败、控制目录损坏、分页 cursor 失效和 push session 过期。
- 验证 Secret 从不进入普通设置、控制目录和日志。
- 验证插件加载、文件事件和闲置状态不产生网络请求。

### 16.3 API 契约测试

- 协议包同时验证插件请求、服务端响应和错误 envelope。
- 分页 Snapshot/Delta 固定 revision，不混入后续发布。
- 分批上传支持相同批次幂等重试，拒绝同索引不同 hash。
- finalize 原子检查 base、确认 hash、用户状态和实时角色。
- AgentCredential 无法调用人类设备直接发布路径。

### 16.4 端到端验收

使用独立测试 Vault 和本地 AgentWiki：

1. 一个 Vault 映射两个互不重叠 Space，操作和失败完全隔离。
2. 桌面 Push 后移动端 Pull，再由移动端 Push、桌面 Pull。
3. 两设备修改不同段落后自动合并。
4. 两设备修改同一区间后在 Obsidian 内解决冲突。
5. 远端归档进入本地回收站，本地删除发布为远端归档。
6. Push 期间角色降为 viewer，服务端拒绝且本地 base 不推进。
7. Pull 应用中断后，下次启动恢复到事务前状态。
8. 5,000 篇、100 MiB 的 Space 完成分页 Pull、Status 和分批 Push；界面持续显示进度且保持可交互。

### 16.5 持续集成门禁

- 格式检查。
- ESLint。
- TypeScript typecheck。
- Vitest 全量测试。
- 生产构建。
- 构建产物扫描，禁止 Node 内置模块和意外凭据模式。
- `manifest.json`、版本映射文件和发布产物一致性检查。

## 17. 实施依赖与顺序

本设计包含两个仓库边界明确的交付物：

1. AgentWiki 主项目独立任务：实现并发布人类设备身份、同步 API v1 和浏览器兼容协议包。
2. 当前插件项目后续任务：基于已发布契约实现 AgentWiki Sync。

主项目在当前任务中保持只读。插件可以先针对 fake client 开发纯核心和 UI，但真实端到端验收必须使用已发布的公共契约，不得复制主项目内部 DTO 作为临时替代。
