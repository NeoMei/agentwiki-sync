# AgentWiki Sync

AgentWiki Sync 是一个移动端兼容的 Obsidian 插件，通过可预览、可确认的同步中心，将 Vault 映射目录与 AgentWiki Space 双向同步。

## 当前状态

插件核心、事务恢复、Obsidian 原生 UI 和公开 API 客户端已实现。AgentWiki 人类设备同步 API v1 已上线，插件依赖已发布的 `@neomei/agentwiki-sync-protocol@0.1.0` 并通过逐字节一致性测试。仓库同时使用独立 fake AgentWiki 验证端到端客户端流程，不复制 AgentWiki 主项目内部实现。

## 安装与使用

1. 把 `main.js`、`manifest.json`、`styles.css` 放入 Vault 的 `.obsidian/plugins/agentwiki-sync/` 目录，然后在 Obsidian 中启用插件。
2. 在 AgentWiki 网页的「集成 → Obsidian 设备」生成一次性连接码，在插件设置页完成连接。
3. 为可访问的 Space 选择一个互不重叠的 Vault 目录。新映射首次同步时会显式展示绑定与冲突选项。
4. 点击功能区图标、状态栏或命令面板的「打开同步中心」，选择自动合并、使用本地内容或使用服务器内容，并在预览中确认后执行。

同步中断后，下次打开同步中心会先恢复未完成的 Pull/Push 事务；恢复无法唯一判定时会冻结该 Space，不会静默覆盖当前文件。

同步中心可明确切换任意已映射 Space，包括待首次同步和只读 Space。只读 Space 可查看状态并以服务器内容 Pull，不提供 Push 策略。扫描、下载、合并和分批上传会显示进度并可取消；Pull 本地事务开始后和 Push finalize 开始后进入不可中断的原子阶段。

## 开发

要求 Node.js 24 LTS：

```bash
npm ci
npm run check
```

产物为 `main.js`、`manifest.json`、`styles.css`。开发和测试只能使用独立测试 Vault。

## 安全边界

- 插件只在用户连接、打开/刷新同步中心或确认同步时联网。
- Push 必须先确认预览，远端 head 领先时被阻止。
- credential 与连接码只进入 Obsidian Secret Storage，不进入 Vault 或诊断。
- `.agentwiki/` 控制状态按 device/space 隔离，通过 DataAdapter 相对路径访问；基线采用不可变 generation + current pointer，不使用 Node `fs` 或桌面专属 API。
- 所有远端 Markdown 路径须先通过 NFC/casefold 可移植路径校验，Vault 适配器写入时再次执行 mapping-root containment。
- Secret Storage 不防御用户主动安装的恶意 Obsidian 插件。
