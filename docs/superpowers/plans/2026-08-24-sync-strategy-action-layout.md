# Sync Strategy Action Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将同步策略说明与按钮拆成上下两行，并按弹窗容器宽度自适应排列按钮。

**Architecture:** 保持 `SyncCenterModal` 的业务行为不变，只调整 `renderActions()` 生成的 DOM 结构和插件作用域 CSS。回归测试读取真实源码与样式文件，锁定结构边界；最终用完整门禁和渲染检查验证。

**Tech Stack:** TypeScript、Obsidian Plugin API、CSS Container Queries、Vitest

## Global Constraints

- 不改变同步策略执行、权限判断、文案或服务端协议。
- 响应式规则必须依据 `.agentwiki-sync-modal` 容器宽度，不依据操作系统。
- 不新增依赖，不修改 AgentWiki 主项目。

---

### Task 1: 重构同步策略操作区

**Files:**
- Modify: `src/obsidian/sync-center-modal.ts:238-269`
- Modify: `styles.css:1-51`
- Test: `tests/unit/release-metadata.test.ts`

**Interfaces:**
- Consumes: `SyncCenterModal.renderActions(diff: SyncDiff)` 现有策略按钮与回调。
- Produces: `.agentwiki-sync-strategy-description`、`.agentwiki-sync-strategy-setting`、`.agentwiki-sync-actions` 三个稳定布局钩子。

- [ ] **Step 1: 写失败的布局契约测试**

```ts
it("keeps sync strategy guidance above a container-responsive action row", async () => {
  const source = await readFile("src/obsidian/sync-center-modal.ts", "utf8");
  const styles = await readFile("styles.css", "utf8");
  expect(source).toContain('cls: "agentwiki-sync-strategy-description"');
  expect(source).toContain('addClass("agentwiki-sync-strategy-setting")');
  expect(styles).toContain(".agentwiki-sync-modal {\n  container-type: inline-size;");
  expect(styles).toContain("@container (max-width: 440px)");
  expect(styles).not.toContain(".is-phone .agentwiki-sync-actions");
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npm test -- tests/unit/release-metadata.test.ts`

Expected: FAIL，指出新的说明 class 或容器查询不存在。

- [ ] **Step 3: 实现最小 DOM 与 CSS 调整**

在 `renderActions()` 中先创建独立说明段落，再创建无左栏内容的 `Setting`；给 `settingEl` 和 `controlEl` 添加布局 class。CSS 隐藏空的 `.setting-item-info`，让按钮组占满整行并换行；容器小于等于 440px 时改为单列网格。

- [ ] **Step 4: 运行聚焦测试并确认 GREEN**

Run: `npm test -- tests/unit/release-metadata.test.ts`

Expected: 4 tests passed。

- [ ] **Step 5: 运行完整门禁与渲染检查**

Run: `npm run check`

Expected: format、lint、typecheck、test、build、bundle、release metadata 全部通过。随后在 560px 和窄容器复现页检查说明宽度与按钮排列。
