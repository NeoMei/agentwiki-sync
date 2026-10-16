# Windows 隔离验收

只能在新临时检出和专用临时 Vault 操作；不读取或复制用户 Vault 的 data.json、连接凭据或控制目录。测试内容全部为合成 fixture。本文是执行步骤；已完成项目与未执行边界见 [receipt.md](receipt.md) 的 Windows 隔离验收回执。

## 固定源码与 Windows 模块测试

正式 tag `0.5.11` 对应已经审查和验收的完整 40 位候选 SHA。以下 PowerShell 在远程 Windows 上执行；不要用浮动 main 代替固定候选。换行设置只作用于本次新临时检出，不更改全局 Git 配置。

```powershell
$candidate = '7e81b9f1163083928033dc311fd14d87e5d3d055'
$acceptRoot = Join-Path $env:TEMP ('AgentWiki-0511-' + [Guid]::NewGuid().ToString('N'))
$sourceRoot = Join-Path $acceptRoot 'source'
New-Item -ItemType Directory -Path $acceptRoot | Out-Null
git clone --config core.autocrlf=false --no-checkout --branch 0.5.11 https://github.com/NeoMei/agentwiki-sync.git $sourceRoot
if ($LASTEXITCODE -ne 0) { throw 'clone failed' }
git -C $sourceRoot checkout --detach $candidate
if ($LASTEXITCODE -ne 0) { throw 'checkout failed' }
if ((git -C $sourceRoot rev-parse HEAD).Trim() -ne $candidate) { throw 'candidate mismatch' }
Push-Location $sourceRoot
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  npm test -- tests/integration/official-baseline-retest.test.ts tests/integration/mapping-detach.test.ts tests/integration/mapping-detach-concurrency.test.ts
  if ($LASTEXITCODE -ne 0) { throw 'mapping tests failed' }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }
  npm run check:bundle
  if ($LASTEXITCODE -ne 0) { throw 'bundle check failed' }
  Get-FileHash main.js,manifest.json,styles.css -Algorithm SHA256
} finally { Pop-Location }
```

预期 57 项通过：根目录/大小写重绑 10 项、完整归档和恢复 37 项、并发/断开/重新连接 10 项。这证明候选在 Windows 上执行实际模块时机制通过，远端是确定性 fixture，Obsidian API 是测试 harness；不能作为原生 UI 或原用户 Space 的成功回执。

干净 npm 构建的预期资产哈希见 [receipt.md](receipt.md)。main.js 应为 1774928 B、SHA-256 `7c12b84aaf82af1ec5d8eeab9edee1f727ed0f5264ef157ec36c2062be3c2926`。不要使用复用 pnpm 依赖目录产生的旧 `95bf…` 哈希作为发布门禁。

## 原生临时 Vault

审查通过且协调者放行临时安装后，执行：

```powershell
$vaultRoot = Join-Path $acceptRoot 'AgentWiki-0511-Acceptance'
$pluginRoot = Join-Path $vaultRoot '.obsidian\plugins\agentwiki-sync'
New-Item -ItemType Directory -Path $pluginRoot -Force | Out-Null
foreach ($asset in @('main.js', 'manifest.json', 'styles.css')) {
  Copy-Item (Join-Path $sourceRoot $asset) (Join-Path $pluginRoot $asset)
}
Get-FileHash (Join-Path $pluginRoot 'main.js'),(Join-Path $pluginRoot 'manifest.json'),(Join-Path $pluginRoot 'styles.css') -Algorithm SHA256
```

通过 Obsidian 的“打开文件夹作为仓库”打开精确的 `$vaultRoot`，只在此临时 Vault 启用插件。核实实际运行的 Vault、插件版本、加载状态及三文件哈希，并重新加载插件再次核对。不得复制业务 Vault 设置。这一门只证明原生加载和包身份，不证明原案重绑已验收。

以下真实 DataAdapter 文件系统机制回放在本轮为 **NOT_RUN**，不是已完成验收。若后续补验，基线、连接和远端返回只允许人工合成 fixture；不要把生产 token 放进脚本。可复用已通过测试的 TreeBaselineRepository、SyncRuntime、FakeTreeRemote，且明确记录 HTTP 与异步故障 gate 为 fixture：

1. 建立合成设备/Space 身份，以 `Wiki` 映射写入合法空 v2 基线和一条根外保留正文。由真实 runtime 扫描确认本地干净且远端与基线一致。
2. 调用实际插件移除映射，检查当前设备/Space 控制目录移入 detached，旧 generation/prev/next 字节保留。重新添加同一 Space 到 `NewWiki`；打开差异入口应越过本地基线校验到受控 HTTP。重复 `Wiki` → `wiki`，Windows 大小写等价文件系统也不能复用旧身份基线。
3. 暂停差异入口的 runtime 获取，尝试移除；应提示已有活跃操作，旧基线不移动。恢复差异后移除成功。
4. 用真实 runtime 排队一条 `pages/old.md` → `pages/new.md` rename hint，暂停 `move-hints.json.next` 写；触发断开。断开应等待，恢复写后才完成。随后移除/重新添加映射，旧源目录不会重建，原 Markdown 字节保持。
5. 新合成连接通过 exchange/session/activate 后，候选应能为新根创建新 runtime；被退役的旧 runtime 再收到 rename 不写控制数据。

第 4 项用受控异步 gate 稳定交错，不用人工点击速度猜测竞态。辅助模块必须检查 Vault 位于本次 `$acceptRoot` 且名字含 `AgentWiki-0511`，不满足立即退出。真实插件实例的方法、Vault adapter、路径操作用于验收；仅 HTTP 与故障 gate 为 fixture。完成后恢复钩子并关闭临时 Vault，保留脱敏回执和 fixture 供复查。

验收记录必须分列 Windows 模块测试、临时 Vault 原生加载/文件系统、原用户环境只读复验，不互相替代。黄金书屋现有 0.5.10 只读差异已能打开，不把本次合成重绑机制宣称为该原案已定位。
