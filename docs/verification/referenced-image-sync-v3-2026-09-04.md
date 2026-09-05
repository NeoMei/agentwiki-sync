# Sync v3 引用图片验证记录

更新时间：2026-09-06

## 证据边界

本文分别记录源码自动化、公开协议、生产服务、生产 Web、真实 Obsidian、Android、GitHub、社区市场和实际安装 bundle。自动化 fake 驱动的是插件真实 `SyncRuntime` 与持久化/事务实现，但不等同于真实设备或生产同步。

## 本地源码与自动化

- 基线：`98379eb447547282b988001732a5ec7733489bef`；Task 18 控制器全门为 661/661 PASS。
- 真实桌面阻断修复 checkpoint `3da81e7d013744e899564388aba75b7a25275d01`：Pull 预览正文 sidecar 统一落在当前 device/space 的 `.agentwiki/` 控制目录。严格 control adapter、同 pageId 双设备隔离、旧 baseline journal 恢复覆盖 3/3 PASS；控制器独立 `npm run check` 为 664/664 PASS。固定候选 `main.js` SHA-256 为 `992e4f9c1ee5a6c96a9275797deba2c8d088e699af7605b6e605f3cc4577c766`。
- 第二个真实阻断修复 checkpoint `e2df559258cca334bd46db3b9e21f8412ae9b31f`：完成态 Pull journal 不再用旧结果复验合法后续编辑；未完成 `verified` 和既有 `ambiguous` 仍严格失败关闭。修复前 RED 为“完成 Pull → 本地编辑 → recover”抛 `TREE_TRANSACTION_AMBIGUOUS`；focused 82/82 与当时全门 685/685 PASS。固定源码构建的 `main.js` SHA-256 为 `abfd32e690b5c3cd36a1e3f288798369198fc2caad79647bbc68dc23797dff95`。
- 第三个真实阻断修复 checkpoint `0084814b491c4acea13cf5abbc3b9f2381032c3e`：将 schema-3 Pull 的 `verified` 未完成态与 `committed` 终态分开；后续 Push 替换 baseline journal 后，已完成 Pull 不再永久要求旧 baseline transaction，但缺失/不一致 control 证据及未完成 baseline 仍 fail closed。非首次 Pull 在 baseline prepare 前崩溃可按当前 base revision 安全回滚。focused 96/96 PASS；按 checkpoint 提交边界的完整 `npm run check` 为 669/669 PASS。固定 `main.js` SHA-256 为 `8b16f005c7da924df72c7a9b537098ab521ef90dd548e443aa56e25b1c6ef061`。
- 新 E2E 兼容矩阵覆盖 v1/v2/v3、带图/无图、旧服务端图片候选阻止。“v3 attached revision + v2 adapter”与“v3 empty projection + v2 adapter”使用真实 `AgentWikiClient → V2TreeRemote → SyncRuntime` 和受控 HTTP 响应，分别验证 409 升级边界与严格空 v2 projection；这仍是旧 adapter 自动化，不是已发布旧插件 binary 的真实设备 E2E。
- 新 E2E 流覆盖 Web 侧 seed → Obsidian Pull、Obsidian 图片替换 Push → 第二设备 Pull、非重叠合并、显式冲突选择、detach 和未引用图片零传输。
- 故障注入覆盖 Blob upload/download、finalize response、Vault 图片写、Markdown 写、generation staging/switch，并从新 runtime 恢复或安全回滚。
- 兼容安全刷新：只把开发依赖链中的 `fast-uri` 从 3.1.5 更新到 3.1.7；不 force、不升级上游 major。刷新后完整 `npm audit` 为 0 known vulnerabilities。

最终提交前重跑并填写：

- `npx vitest run tests/e2e/referenced-image-sync-v3.test.ts tests/e2e/manual-sync-flow.test.ts tests/performance/bounded-space.test.ts`：3 files / 41 tests PASS，exit 0。
- `npm ci`：exit 0；`npm audit --json`：0 known vulnerabilities，exit 0。
- `npm run check`：52 files / 694 tests PASS，format/typecheck/build/bundle/release checks 均 exit 0；lint 0 errors、17 个已记录 warnings；bundle safety 1,486,057 bytes；release metadata 0.4.0。
- `git diff --check` 与源码/fixture/bundle 边界检查：提交前再次执行。

## 公开协议与生产服务

- `@neomei/agentwiki-sync-protocol@0.5.1` 已发布；插件依赖使用精确版本 0.5.1。
- AgentWiki 服务端 runtime `03703df` 已部署为 0.8.0；GitHub PR #8 已合入 `master@ea56d75`，与受测候选 tree 一致。
- 服务端记录：4818 PASS、3 个预期 skip；专用数据库 157 PASS、0 skip；浏览器 6/6 PASS。生产备份、5 个 migration、health、32 项业务检查、24 项图片 API 检查和 Assist canary 均已通过。
- 权威服务端证据位于 AgentWiki 仓库 `docs/verification/sync-v3-production-2026-09-06.md`。本插件任务未修改生产或服务端。

## 生产 Web 图片证据

- 2026-09-06 已使用合成的可完整解码 480×270 PNG/JPEG/WebP/GIF 验证：上传元数据、规范 Page 引用 refetch、固定 v3 metadata/hash、授权下载字节一致和未授权拒绝；fixture 清理 PASS。
- 真实 UI 流完成登录、空白合成 Page、四格式上传、保存、API refetch、重载与 Preview；四图均 decode 为 480×270/private blob，console/page error 为 0，390 px 无文档横向溢出，清理 PASS。
- 以上仅证明生产 Web/API 上传与渲染，不证明 Obsidian 同步。

## 真实 Obsidian 桌面

- 环境：Obsidian 1.13.7；专用隔离 Vault `AgentWiki-Sync-V3-Acceptance-20260905`。未使用主 Vault。
- 冻结 `98379eb` 候选可连接、列 Space、建立 mapping，并完成 Sync v3 预览（四图合计 46,608 bytes）；实际确认 Pull 因裸 sidecar 路径触发 `Unsafe control path`，0 个用户文件写入。该问题由 `3da81e7` 修复。
- 安装 `3da81e7` 固定候选后，四格式 Pull、字节核对、阅读视图显示及离线重新 decode 均 PASS。
- 随后新增本地引用图时，已完成 Pull journal 错误复验合法编辑并触发 `TREE_TRANSACTION_AMBIGUOUS`；真实 journal 证据为 `.prev` state committed、当前 state ambiguous，同 transaction 的 v3 control phase applied 和 baseline journal phase committed。该问题由 `e2df559` 修复。
- `e2df559` 新 synthetic Space/mapping 完成四图 Pull、新引用 PNG Push（源文件 1,103 B）、远端 Page refetch/固定 revision hash 与真实 Web 五图渲染；未引用图 0 read。随后暴露已完成 Pull 对新 Push baseline journal 的错误永久依赖，该问题由 `0084814` 修复。
- 真实安装 `0084814` 后：reload/recover clean；auto 与 server 重复同步均为 0 session/0 Blob；第二次 Page-only Push 后再次 noop PASS；`FileManager.renameFile` 图片改名保持 attachment ID、旧路径消失、引用改写且 0 Blob；二进制替换后远端 hash/size 精确；detach 后远端附件仍 active/not archived，本地已 detach 图和未引用图仍保留；最终 sync-center clean。详细受控证据来自计划目录 `controller-desktop-evidence.md`，未包含 credential。
- Push modal 在 session 建立前显示全部 Blob requirements 的保守候选字节上界；服务端返回 missing hashes 后才能知道实传量。真实 rename 中 modal 显示 1,103 B，但已有 hash 被复用，实际 0 Blob；这是文案精确度 concern，不是公开 URL 或额外传输证据。
- 被置为 ambiguous 的旧 fixture 未被产品代码自动改写绕过。真实 double-rename conflict、keep-both 和中断事务恢复仍 **NOT RUN / PENDING**；keep-both local/remote primary 双路径已有真实 runtime 自动化 apply → Push → 新设备 Pull，不等于真实桌面验收。

## Android / 移动端

- 已知环境：PJE110，Android 16 / API 36，Obsidian 1.13.8（code 367），USB debugging 已授权。
- 实际扫描、下载、Vault/FileManager 写入、rename、journal 恢复和 360 px modal：**NOT RUN / PENDING（控制器执行）**。
- 桌面测试、`dev:mobile` 或自动化 fake 不能替代该项。

## 发布渠道

- 本地分支：`codex/referenced-image-sync-v3`；0.4.0 元数据仅本地准备。
- npm 协议：0.5.1 已发布。插件本身为 Obsidian GitHub Release，不发布 npm 包。
- GitHub 仓库：`NeoMei/agentwiki-sync`；默认分支 `main`。发布工作流监听纯数字 tag `0.4.0`，并要求 tag 与 manifest 版本一致。
- `origin/main`、tag `0.4.0`、GitHub Release、三项资产 SHA-256/attestation：**PENDING（控制器在真实验收和 whole-branch review 后执行）**。
- Obsidian 社区列表已存在 `agentwiki-sync` 条目并指向 `neomei/agentwiki-sync`；无需重复 listing PR。市场搜索可见性和真实安装目录 bundle 0.4.0：**PENDING**。
- 本任务不创建/推送 tag，不改写 0.3.0 Release，不安装真实 Vault，不写生产/npm/GitHub。

## 当前结论

源码自动化和元数据通过不代表完整发布。只有桌面新候选完整同步、Android 功能验收、whole-branch review、远端 tag/Release/assets/attestation 与真实安装 bundle 分别留下证据后，才可声明 Sync v3 插件完整发布。
