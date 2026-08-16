# AgentWiki Sync

AgentWiki Sync 是一个移动端兼容的 Obsidian 社区插件，用 Git 风格的 Status、Pull、Push 将映射目录与 AgentWiki Space 同步。

## Installation

### From Obsidian Community Plugins

1. Open Obsidian Settings → Community Plugins
2. Disable Restricted mode if enabled
3. Click Browse and search for "AgentWiki Sync"
4. Click Install, then Enable

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/NeoMei/agentwiki-sync/releases/latest)
2. Create a folder `agentwiki-sync` in your vault's `.obsidian/plugins/` directory
3. Copy the three files into that folder
4. Restart Obsidian and enable the plugin in Settings → Community Plugins

## Usage

### 1. Connect to AgentWiki

1. Open Settings → AgentWiki Sync
2. Enter your AgentWiki server URL (e.g., `https://agentwiki.quukk.com`)
3. Enter the connection code from your AgentWiki account settings
4. Click Connect

### 2. Map Folders to Spaces

1. After connecting, select an AgentWiki Space from the dropdown
2. Choose a vault folder to map to that Space
3. Click Add Mapping

### 3. Sync Your Notes

Use the three sync commands from the ribbon or Command Palette:

- **Status** — Check what changed locally and remotely since last sync
- **Pull** — Download remote changes to your vault (merges with local edits)
- **Push** — Upload local changes to AgentWiki (requires preview confirmation)

Conflicts are resolved with Git-style three-way merge. When both sides changed the same block, the plugin keeps both versions with conflict markers for you to resolve manually.

## Features

- Bidirectional sync between Obsidian folders and AgentWiki Spaces
- Git-style Status / Pull / Push workflow with three-way merge
- Human-readable file paths (no hash filenames)
- Conflict markers for manual resolution
- Mobile compatible (no desktop-only APIs)
- Credentials stored in Obsidian Secret Storage only

## Security

- The plugin only connects when you run Connect, Status, Pull, or Push
- Push requires preview confirmation before uploading
- Credentials and connection codes never enter your vault or diagnostics
- All remote Markdown paths pass NFC/casefold portable path validation

## Development

Requires Node.js 24 LTS:

```bash
npm ci
npm run check
```

产物为 `main.js`、`manifest.json`、`styles.css`。开发和测试只能使用独立测试 Vault。

## 安全边界

- 插件只在用户执行连接、Status、Pull、Push 时联网。
- Push 必须先确认预览，远端 head 领先时被阻止。
- credential 与连接码只进入 Obsidian Secret Storage，不进入 Vault 或诊断。
- `.agentwiki/` 控制状态按 device/space 隔离，通过 DataAdapter 相对路径访问；基线采用不可变 generation + current pointer，不使用 Node `fs` 或桌面专属 API。
- 所有远端 Markdown 路径须先通过 NFC/casefold 可移植路径校验，Vault 适配器写入时再次执行 mapping-root containment。
- Secret Storage 不防御用户主动安装的恶意 Obsidian 插件。
