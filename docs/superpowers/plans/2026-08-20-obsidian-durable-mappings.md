# Obsidian Durable Space Mappings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist Space-to-Vault mappings durably across restart/update, block sync safely when a mapped directory is missing, and verify readable server path renames without modifying Markdown bodies.

**Architecture:** Split Vault-portable non-secret settings from device-local connection identity. Store schema-v2 Vault settings through Obsidian `loadData/saveData`, migrate the 0.2.7 local envelope once, retain device/session/credential state in local/Secret Storage, and make SyncRuntime reject a missing root instead of treating it as an empty directory.

**Tech Stack:** Obsidian API 1.11.4 typings / min app 1.11.5, TypeScript, Vitest, ESLint Obsidian rules, esbuild, npm.

## Global Constraints

- Work in `/Users/neomei/项目/codexprojects/AgentWiki-Obsidian`; preserve the untracked `.codegraph/` directory and never stage it.
- `data.json` stores only schemaVersion 2, serverUrl, and mappings (`spaceId/rootPath/status`).
- `serverInstanceId`, connection-state, deviceId, vaultId binding, credential IDs, Secret Storage references, connection codes, and secrets never enter `data.json`.
- A missing root keeps the mapping and blocks scan/Pull/Push with a user-actionable error; it must never be interpreted as an empty local Space.
- Remote canonical path renames use the existing three-way merge and Pull transaction. Concurrent local and remote renames remain explicit path conflicts.
- Markdown bodies are byte-preserved apart from the protocol's existing CRLF-to-LF normalization; a leading `# Title` is retained.
- This plan prepares version 0.2.8 but does not publish, tag, deploy AgentWiki, mutate a production database, or submit an Obsidian review scan without separate authorization.

---

### Task 1: Schema-v2 Vault settings and 0.2.7 migration

**Files:**
- Modify: `src/application/settings.ts`
- Modify: `tests/unit/settings.test.ts`

**Interfaces:**
- Consumes: existing `AgentWikiSyncSettings`, `SpaceMapping`, and schema-v1 local envelope payload.
- Produces: `VaultSyncSettings`, `parseVaultSettings()`, `toVaultSettings()`, and `migrateVaultSettings()`.

- [ ] **Step 1: Write failing settings tests**

Add tests for exact separation and migration:

```ts
it('persists only non-secret Vault settings', () => {
  expect(toVaultSettings({
    schemaVersion: 1,
    serverUrl: 'https://wiki.example.com',
    serverInstanceId: 'server-secret-adjacent-id',
    mappings: [{ spaceId: 's1', rootPath: 'AgentWiki', status: 'active' }],
  })).toEqual({
    schemaVersion: 2,
    serverUrl: 'https://wiki.example.com',
    mappings: [{ spaceId: 's1', rootPath: 'AgentWiki', status: 'active' }],
  });
});

it('migrates 0.2.7 local mappings when schema-v2 data is absent', () => {
  expect(migrateVaultSettings(null, legacySettings)).toMatchObject({
    schemaVersion: 2,
    mappings: legacySettings.mappings,
  });
});

it('keeps schema-v2 mappings authoritative over an empty local envelope', () => {
  expect(migrateVaultSettings(v2Settings, { ...legacySettings, mappings: [] }).mappings)
    .toEqual(v2Settings.mappings);
});
```

Also assert: invalid mappings throw rather than reset; future schema versions freeze startup; schema-v1 `data.json` mappings migrate; malformed data does not silently become `[]`; credential/session-shaped fields are absent from the serialized result.

- [ ] **Step 2: Run settings tests and verify RED**

```bash
npm test -- --run tests/unit/settings.test.ts
```

Expected: FAIL because schema-v2 settings functions do not exist.

- [ ] **Step 3: Implement schema-v2 settings functions**

Add:

```ts
export interface VaultSyncSettings {
  schemaVersion: 2;
  serverUrl: string;
  mappings: SpaceMapping[];
}

export function parseVaultSettings(value: unknown): VaultSyncSettings;
export function toVaultSettings(settings: AgentWikiSyncSettings): VaultSyncSettings;
export function migrateVaultSettings(
  stored: unknown,
  legacy: AgentWikiSyncSettings | null,
): VaultSyncSettings;
```

`migrateVaultSettings` precedence is: valid schema 2 → valid schema 1 `data.json` → valid schema 1 local envelope → default. An invalid present candidate throws; only an actually absent candidate permits fallback. Clone mappings before `validateMappings()` because validation normalizes root paths in place.

- [ ] **Step 4: Run tests, format, and typecheck**

```bash
npm test -- --run tests/unit/settings.test.ts tests/unit/coordinator.test.ts
npm run check:format
npm run typecheck
```

Expected: selected tests PASS; format and typecheck exit 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/application/settings.ts tests/unit/settings.test.ts
git commit -m "fix(settings): separate durable Vault mappings"
```

### Task 2: Plugin lifecycle loads and saves durable mappings

**Files:**
- Modify: `src/main.ts`
- Create: `tests/integration/plugin-settings-lifecycle.test.ts`
- Modify: `tests/fakes/obsidian-mock.ts`

**Interfaces:**
- Consumes: Task 1 migration functions and existing `MutableControlRepository` legacy local envelope.
- Produces: startup/save lifecycle that never resets mappings and never persists device identity in `data.json`.

- [ ] **Step 1: Write a failing lifecycle harness**

Create a minimal test plugin subclass/fake App that records `loadData`, `saveData`, `loadLocalStorage`, and `saveLocalStorage`. Test:

```ts
it('imports 0.2.7 local mappings once and survives reload with local storage gone', async () => {
  const first = makePlugin({ data: oldEmptyData, localEnvelope: legacyWithMapping });
  await first.onload();
  expect(first.savedData).toEqual(expect.objectContaining({
    schemaVersion: 2,
    mappings: [{ spaceId: 's1', rootPath: 'AgentWiki', status: 'active' }],
  }));

  const second = makePlugin({ data: first.savedData, localEnvelope: null });
  await second.onload();
  expect(second.settings.mappings).toEqual(first.settings.mappings);
});
```

Add cases for restart, plugin disable/enable, connection-state absent, connection-state present, server URL normalization, and `saveSettings()` omitting serverInstanceId/credential identifiers.

- [ ] **Step 2: Run lifecycle test and verify RED**

```bash
npm test -- --run tests/integration/plugin-settings-lifecycle.test.ts
```

Expected: FAIL because onload still writes `DEFAULT_SETTINGS` and saveSettings only writes local storage.

- [ ] **Step 3: Implement lifecycle split**

Refactor onload to:

```ts
const legacy = await this.settingsRepo().read();
const vaultSettings = migrateVaultSettings(await this.loadData(), legacy?.payload ?? null);
this.settings = {
  schemaVersion: 1,
  serverUrl: vaultSettings.serverUrl,
  serverInstanceId: null,
  mappings: vaultSettings.mappings,
};
await this.saveData(vaultSettings);
```

Then load `connection-state.json`; only a valid connected state sets runtime `serverInstanceId/serverUrl`. Change `saveSettings()` to validate and call `saveData(toVaultSettings(this.settings))`. Keep the old local settings repository read-only for one-version migration; do not clear it until a later compatibility release. Remove `saveData(DEFAULT_SETTINGS)`.

- [ ] **Step 4: Run lifecycle and connection regressions**

```bash
npm test -- --run tests/integration/plugin-settings-lifecycle.test.ts tests/integration/client-connection.test.ts tests/unit/settings.test.ts
npm run typecheck
```

Expected: all selected tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/main.ts tests/integration/plugin-settings-lifecycle.test.ts tests/fakes/obsidian-mock.ts
git commit -m "fix(plugin): restore mappings across restart and update"
```

### Task 3: Missing roots block sync without deleting mappings

**Files:**
- Modify: `src/application/sync-runtime.ts`
- Modify: `src/core/user-errors.ts`
- Modify: `src/obsidian/settings-tab.ts`
- Modify: `tests/integration/sync-runtime.test.ts`
- Modify: `tests/unit/user-errors.test.ts`

**Interfaces:**
- Consumes: `VaultPort.rootStatus(rootPath)` returning `folder | missing | file`.
- Produces: stable error codes/messages `MAPPING_ROOT_MISSING` and `MAPPING_ROOT_NOT_DIRECTORY`.

- [ ] **Step 1: Write failing missing-root tests**

Add runtime assertions:

```ts
it('blocks a missing mapping root instead of scanning an empty Space', async () => {
  vault.setRootStatus('missing');
  await expect(runtime.status()).rejects.toThrow('MAPPING_ROOT_MISSING');
  expect(remote.finalizeCalls).toBe(0);
});

it('blocks a file used as the mapping root', async () => {
  vault.setRootStatus('file');
  await expect(runtime.previewPush()).rejects.toThrow('MAPPING_ROOT_NOT_DIRECTORY');
});
```

Assert the plugin settings still contain the original mapping after either error and `userErrorMessage()` returns a Chinese instruction to recreate the folder or change the mapping.

- [ ] **Step 2: Run selected tests and verify RED**

```bash
npm test -- --run tests/integration/sync-runtime.test.ts tests/unit/user-errors.test.ts
```

Expected: missing root currently scans as an empty directory, so the new assertion FAILS.

- [ ] **Step 3: Implement root guards and UI status**

At the start of `SyncRuntime.scan()`:

```ts
const status = await this.vault.rootStatus(this.mapping.rootPath);
if (status === 'missing') throw new Error('MAPPING_ROOT_MISSING');
if (status === 'file') throw new Error('MAPPING_ROOT_NOT_DIRECTORY');
const source = this.vault.listMarkdown(this.mapping.rootPath);
```

Map both codes in `userErrorMessage`. In settings display, preserve the mapping row and show the actionable error after a local existence check; do not remove or recreate a directory automatically.

- [ ] **Step 4: Run runtime, adapter, and UI regressions**

```bash
npm test -- --run tests/integration/sync-runtime.test.ts tests/unit/user-errors.test.ts tests/unit/obsidian-adapters.test.ts
npm run lint
npm run typecheck
```

Expected: selected tests PASS, lint has 0 errors, typecheck exits 0.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/application/sync-runtime.ts src/core/user-errors.ts src/obsidian/settings-tab.ts tests/integration/sync-runtime.test.ts tests/unit/user-errors.test.ts
git commit -m "fix(sync): retain mappings when local roots are missing"
```

### Task 4: Canonical rename and body-preservation regression coverage

**Files:**
- Modify: `tests/integration/sync-runtime.test.ts`
- Modify: `tests/e2e/manual-sync-flow.test.ts`

**Interfaces:**
- Consumes: existing Pull preview/apply path merge and `FakeAgentWiki` revisions.
- Produces: regression proof for AgentWiki readable path migrations and title-driven rename conflicts.

- [ ] **Step 1: Write failing/characterization tests**

Add scenarios:

```ts
it('renames an unchanged local opaque file to the new canonical title path', async () => {
  // Base/local: pages/p-<64hex>.md with '# 吃饭\n\n正文'
  // Remote: same pageId/body/hash, path pages/吃饭.md, title 吃饭
  // Expect one rename action and identical bytes after apply.
});

it('reports a path conflict when local and remote rename the same page differently', async () => {
  // Base opaque path, local Guides/吃饭.md, remote pages/吃饭.md.
  // Expect conflict.field === 'path' and no silent rename.
});
```

Also add an E2E flow with two remote pages titled identically at `pages/标题.md` and `pages/标题 (2).md`, verifying both materialize and the H1 body line remains present.

- [ ] **Step 2: Run tests and inspect whether they characterize or expose a defect**

```bash
npm test -- --run tests/integration/sync-runtime.test.ts tests/e2e/manual-sync-flow.test.ts
```

Expected: the ordinary remote rename should PASS through existing merge logic; any failure is a real regression to fix minimally. The dual-rename test must produce an explicit conflict.

- [ ] **Step 3: Confirm the existing merge path is the implementation under test**

Inspect `src/application/sync-runtime.ts` and confirm the no-conflict branch calls:

```ts
const pathMerge = mergeField(
  basePage.relativePath,
  local.relativePath,
  remotePath,
);
actions.push(
  await this.resultAction(
    'rename',
    joinRoot(this.mapping.rootPath, pathMerge.value),
    bodyMerge.body,
    joinRoot(this.mapping.rootPath, local.relativePath),
  ),
);
```

No production change is expected for this characterization task. If either new test fails because the implementation differs from this invariant, stop the task, apply `systematic-debugging`, and amend this plan with the demonstrated root cause before changing production code.

- [ ] **Step 4: Rerun both suites and body hash assertions**

```bash
npm test -- --run tests/integration/sync-runtime.test.ts tests/e2e/manual-sync-flow.test.ts
```

Expected: both suites PASS; the post-apply content hash equals the pre-rename content hash.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/application/sync-runtime.ts tests/integration/sync-runtime.test.ts tests/e2e/manual-sync-flow.test.ts
git commit -m "test(sync): cover readable canonical path renames"
```

### Task 5: Version 0.2.8 metadata and release gates

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `versions.json`
- Modify: `CHANGELOG.md`
- Modify: `docs/verification/agentwiki-sync-v1.md`

**Interfaces:**
- Consumes: Tasks 1-4 and a verified AgentWiki server branch implementing the companion plan.
- Produces: locally release-ready 0.2.8 artifacts; no publication.

- [ ] **Step 1: Add a failing release metadata assertion**

Update `tests/unit/release-metadata.test.ts` to expect package/manifest/lock version `0.2.8` and `versions['0.2.8'] === '1.11.5'`.

- [ ] **Step 2: Run the metadata test and verify RED**

```bash
npm test -- --run tests/unit/release-metadata.test.ts
```

Expected: FAIL because metadata is still 0.2.7.

- [ ] **Step 3: Align 0.2.8 metadata and changelog**

Set exact version 0.2.8 in package, lock root/package, manifest, and versions map. Add changelog entries for durable mappings, missing-root safety, readable canonical rename compatibility, and body preservation. Do not change `minAppVersion`, runtime dependency pins, or the release workflow.

- [ ] **Step 4: Run clean-install full verification**

```bash
npm ci --ignore-scripts
npm run check
git diff --check
```

Expected: 0 failures; ESLint 0 errors; all tests, typecheck, build, bundle and release metadata checks PASS. Record exact counts in `docs/verification/agentwiki-sync-v1.md`.

- [ ] **Step 5: Commit Task 5**

```bash
git add package.json package-lock.json manifest.json versions.json CHANGELOG.md docs/verification/agentwiki-sync-v1.md tests/unit/release-metadata.test.ts
git commit -m "release: prepare AgentWiki Sync 0.2.8"
```

### Task 6: Two-repository acceptance and independent review

**Files:**
- Modify: `docs/verification/agentwiki-sync-v1.md`
- Review only: plugin feature branch and companion AgentWiki feature branch.

**Interfaces:**
- Consumes: locally verified AgentWiki readable-path branch and plugin 0.2.8 branch.
- Produces: interactive acceptance evidence and a release decision; no automatic external mutation.

- [ ] **Step 1: Build an isolated acceptance environment**

Use a disposable AgentWiki database/instance and a dedicated test Vault, never `/Users/neomei/Obsidian/NeoMei-Docs`. Install the locally built plugin bundle and record its manifest version and SHA-256 before testing.

- [ ] **Step 2: Execute the user-visible matrix**

Verify: connect; save mapping; restart Obsidian; disable/enable plugin; remove device-local legacy settings; mapping remains; create two same-title Web pages; Pull yields `Title.md` and `Title (2).md`; Web title edit renames local file; matching H1 remains; simultaneous local/remote rename opens path conflict; missing root preserves mapping and blocks sync; restored root resumes normally; offline recovery does not lose configuration.

- [ ] **Step 3: Run independent reviews**

Use `superpowers:requesting-code-review` separately for the AgentWiki commit range and plugin commit range. Treat every Critical/Important finding as blocking; add a failing regression test before each fix and rerun both full matrices.

- [ ] **Step 4: Repeat completion audit until clean**

Perform at least two fresh review passes after fixes: first requirement-to-code coverage, then state-machine/data-migration/recovery variance. The terminal result must be 0 Critical, 0 Important, all required tests green, and interactive acceptance complete.

- [ ] **Step 5: Record and commit acceptance evidence**

```bash
git add docs/verification/agentwiki-sync-v1.md
git commit -m "docs: verify durable mappings and readable sync paths"
```

- [ ] **Step 6: Stop at the release authorization gate**

Report both branch SHAs, exact checks, interactive evidence, rollback notes, and remaining known warnings. Ask separately before merging the dirty AgentWiki integration target, running a production DB migration/deploy, pushing plugin 0.2.8, creating a tag/Release, installing into a user Vault, or submitting the Obsidian preview scan.
