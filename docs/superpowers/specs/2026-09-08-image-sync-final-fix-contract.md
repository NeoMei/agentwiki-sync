# 图片同步最终修复与跨仓解析契约

2026-09-08 用户已明确同意：扩展原 shortest-link 补充设计的“不修改服务器”边界，单独修复服务端解析器，与插件一起复审、部署和验收。本文只覆盖已复现的 wholebranch C1/I1/I2 及 M1–M3，不重新设计图片同步。

## 授权和隔离

- 插件继续原 isolated worktree / branch，修复基线 c2f286ff6557eaad5dd9985afd8d21b799a5b5ed。服务端建立独立命名 worktree 与提交，不在主目录或其他任务工作树写入。
- 服务端允许范围是 code-span backtick run 识别修正、对应测试/conformance 与部署验证文档；不改 API、数据库结构、权限、公开协议包、图片类型、短名 wire 规则或 wiki 裸名语义。
- 不读取/复制凭据；生产操作先核对实际目标、应用/数据库可恢复备份和当前版本，不覆盖其他任务新提交；发布/部署须等代码审查及适当验证。
- 同候选双端、公网和 GitHub 资产仍分别验收。旧记录、样例、事务日志、未跟踪用户文档保留。不得手改 Android 失败短链接来冒充修复。

## C1 移动笔记的晚编辑保护

保持现有 TreeTransaction 的持久事实、操作顺序及 CAS 端口。move_page 重命名后需要改正文时，expected 必须来自原持久 source before 字节，不能把刚读到的任意目标正文追认为授权。合法 after 字节的幂等识别仍须有同事务归属。检测 rename 后或 CAS 边界第三方修改时保留其字节和原证据，保持可诊断 ambiguous，不推进 baseline，不以回滚删除第三方内容。普通移动、规范化移动及恢复/回滚均覆盖真实 Runtime/事务路径。

## I1 local_only 已确认恢复

新确认仍重验当前 head。已 durable、同 owner 的 confirmed local_only 恢复只校验原固定 revision/hash，不要求后来 current head 不变。当前身份/权限、原计划/授权、实际本地原字节、能力和日志归属校验不得省略，不能以 WeakMap 缺失作为授权；不改变原 operation/hash/epoch/目标。remote_push create/Finalize 的新鲜 head 门不放宽。恢复两次只修本地、零 session/blob/batch/finalize，完成后才 Pull 新版本。

窄接口：`NormalizedPushAuthority.revalidate(plan: NormalizedPushPlan, mode?: "current_head" | "confirmed_local_only"): Promise<string>`，默认 `current_head`；Coordinator 私有重验传递同一 mode。仅 recover 的 local_only/confirmed 分支传后者；Runtime 对后者强制 durable 同 owner、mode=local_only、phase=confirmed、loadConfirmed 原计划精确一致，缺失或不符即失败。此条件只略过 remote.head，不略过其他校验或固定 snapshot 读取；不新增持久字段。

## I2 双端 code-span 契约

唯一主复现向量：

````json
{
  "body": "``a ``` b`` ![A](../assets/photo.png) `c`",
  "pagePath": "pages/note.md",
  "expectedTarget": "assets/photo.png"
}
````

识别规则：code span 的关闭反引号必须是完整、同长度的连续 run，不能匹配更长 run 的子串；未闭合 opening run 不允许屏蔽后续普通正文。代码内部图片仍排除，代码外标准图片保留。保留原 source ranges、escaping/fence/comment/路径和配额行为；不引入完整新 parser 或生产依赖。

双端使用相同的新增中性 JSON conformance 向量：包括主失败、长/短 run 混合、未闭合 run 后的图片，以及代码内部图片排除。最终比较 syntax/classification/target/path/range，并用相同显式 attachment IDs 验证 plugin actual scan 与 server actual resolver 集合相等。测试 fixture 数据可共享；插件不得导入/复制服务端内部实现。

原40组一致性结果只覆盖原集合，不能关闭本缺陷。旧服务器与新插件不得被宣称兼容此向量；服务端修正经独立审查/部署验收后才开放插件发布门。数据库历史内容不自动重写、不重建旧 revision、不补造引用或覆盖原 receipt；若发现既有受影响数据，先只读列出影响再明确确认迁移。

## M1–M3

- bundle 安全门检查实际 UTF-8 字节而不是字符串长度；上限维持现有2,000,000，输出单位准确，增加非ASCII边界回归。不得在 mobile product bundle 引入 Node API。
- Task6 文档分别归因 Runtime handoff 与已有 router/storage 留存证据；可用小幅文案修正，不必为文案扩大产品变更。
- 单 Page 无可行分流时不提供可执行“同时保留”，或禁用并说明；两个可完成选择保留。Core 非空真子集规则不扩大，不自动插引用或创建未引用附件。

## 执行与验收

### C1 残余的追加确认（2026-09-08）

单次最终复审在 `89bfac1` 仍复现 move_page 异常回滚的 classify→trash 晚编辑丢失，用户随后明确确认保守处理方案。该确认授权一个单独、窄范围的补充修复和独立审查，不是接受风险，也不重新开启无界全分支修复。

move_page 回滚需要恢复/删除业务文件而现有端口不能保证条件 mutation 时，必须在该移动操作的任何回滚业务 mutation 前持久停止为 ambiguous，保留当前文件、before sidecar 和旧 baseline。不得先重建源文件再停止，不得在分类后重新读取并无条件删除，不新增条件文件系统 API。若操作确实仍是完整 before 状态，可保持现有无操作恢复；已成功完成的普通移动仍正常提交。代价是异常移动后可能需要人工处理，不再承诺这类情况自动回滚成功。连续两次重建恢复不得清除晚编辑、推进 baseline 或丢弃恢复证据。

补充测试须覆盖实际 Runtime 成功 CAS 后丢返回、原 classify→trash 窗口、源路径晚创建、rename 成功丢返回，以及已有普通成功移动。不能只断言错误文案或把未触发的注入 hook 当成已保存第三方字节的证据；禁止向生产类增加测试专用入口。受影响旧测试仅按明确批准的异常停止语义调整，保留各自文件/日志/基线不变量。

1. 单个插件最终 fix wave 作者处理完整 C1/I1/I2/M1–M3，先精确 RED 后最小 GREEN，完整 check/audit 一次，冻结提交。
2. 服务端独立 bounded task 仅处理 I2 对应 parser/conformance/测试，记录独立提交和覆盖回归；不与插件 writer 并行修改。
3. 单次插件 fix scoped re-review 加服务端独立 task review；双端中性向量对照。审查残余按现有 SDD breaker 处理，不能默认风险已接受。
4. 重冻候选，按原 Task7 真机/公网/发布门验收。生产部署与历史数据迁移是不同动作；本修复不需要数据库 schema 迁移。
