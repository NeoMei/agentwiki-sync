# Baseline-Aware Page Title Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent server-allocated readable path suffixes such as `标题 (2).md` from being misreported as local title edits while preserving genuine filename-driven title renames.

**Architecture:** Keep path-derived titles during the raw Vault scan, then reconcile the title only after a file has been matched to a baseline page. An exact NFC path match inherits the baseline title; a genuinely changed path keeps the title derived from its new basename. The public types and `resolvePageIdentities()` signature remain unchanged.

**Tech Stack:** TypeScript 5.9, Vitest 3.2, Obsidian 1.11+ plugin APIs, AgentWiki sync v1.

## Global Constraints

- Preserve body bytes and Markdown H1 content; do not add title frontmatter or hidden metadata.
- Do not strip ` (n)` suffixes heuristically because `文章 (2)` can be a legitimate title.
- New local files without a baseline identity continue deriving titles from their basenames.
- Exact-path files inherit the baseline title only when their NFC-normalized paths are equal; case-only or basename renames remain observable changes.
- Do not change the published sync protocol or import AgentWiki server internals.
- Use only the isolated worktree and an isolated test Vault; never install into `/Users/neomei/Obsidian/NeoMei-Docs`.

---

### Task 1: Reconcile Resolved File Titles Against the Baseline

**Files:**
- Modify: `src/core/status.ts:68-104`
- Test: `tests/unit/status.test.ts`
- Test: `tests/e2e/manual-sync-flow.test.ts:190-229`

**Interfaces:**
- Consumes: `ManifestPage.relativePath`, `ManifestPage.title`, `ScannedFile.title`, and `resolvePageIdentities(manifest, files, hints)`.
- Produces: the existing `ResolvedFile[]` return type, with `title` set to the baseline title only for exact NFC path matches.

- [ ] **Step 1: Add the failing unit regression**

Append these tests inside the existing `describe("status", ...)` block in `tests/unit/status.test.ts`:

```ts
  it("keeps the baseline title for an unchanged allocated duplicate path", async () => {
    const body = "# 标题\n\n第二篇";
    const files: VaultFile[] = [
      {
        relativePath: "pages/标题 (2).md",
        bytes: new TextEncoder().encode(body),
      },
    ];
    const scan = await scanMapping(files, {
      complete: true,
      scanEpoch: 1,
      capabilities: {
        pages: 5000,
        bodyBytes: 100_000,
        manifestBytes: 100_000,
      },
    });
    const manifest = {
      p2: {
        pageId: "p2",
        relativePath: "pages/标题 (2).md",
        title: "标题",
        contentHash: scan.files[0]!.contentHash,
      },
    };

    const resolved = resolvePageIdentities(manifest, scan.files, []);

    expect(resolved[0]).toMatchObject({
      pageId: "p2",
      relativePath: "pages/标题 (2).md",
      title: "标题",
      identityStatus: "resolved",
    });
    expect(computeStatus(manifest, resolved, scan).modified).toHaveLength(0);
  });

  it("keeps the new basename title for a genuine local rename", async () => {
    const body = "# 标题\n\n第二篇";
    const files: VaultFile[] = [
      {
        relativePath: "pages/新标题.md",
        bytes: new TextEncoder().encode(body),
      },
    ];
    const scan = await scanMapping(files, {
      complete: true,
      scanEpoch: 1,
      capabilities: {
        pages: 5000,
        bodyBytes: 100_000,
        manifestBytes: 100_000,
      },
    });
    const manifest = {
      p2: {
        pageId: "p2",
        relativePath: "pages/标题 (2).md",
        title: "标题",
        contentHash: scan.files[0]!.contentHash,
      },
    };
    const resolved = resolvePageIdentities(manifest, scan.files, [
      {
        pageId: "p2",
        fromPath: "pages/标题 (2).md",
        toPath: "pages/新标题.md",
        observedVaultByteHash: scan.files[0]!.vaultByteHash,
      },
    ]);

    const status = computeStatus(manifest, resolved, scan);

    expect(resolved[0]?.title).toBe("新标题");
    expect(status.renamed).toHaveLength(1);
    expect(status.modified).toHaveLength(1);
  });
```

- [ ] **Step 2: Extend the duplicate-title E2E test before changing production code**

Add the following assertions to the existing `materializes duplicate readable titles at distinct paths without stripping either H1` test immediately after its current H1 assertions:

```ts
    const clean = await runtime.status();
    expect(clean.local).toEqual({
      added: [],
      modified: [],
      renamed: [],
      deleted: [],
      ambiguous: [],
    });
    expect((await runtime.previewPush()).changes).toHaveLength(0);

    await vault.rename(
      "Wiki/pages/标题 (2).md",
      "Wiki/pages/真正改名.md",
    );
    await runtime.recordRename(
      "Wiki/pages/标题 (2).md",
      "Wiki/pages/真正改名.md",
    );

    const renamed = await runtime.status();
    expect(renamed.local.renamed).toEqual([
      expect.objectContaining({
        pageId: "p2",
        relativePath: "pages/真正改名.md",
        title: "真正改名",
      }),
    ]);
    expect((await runtime.previewPush()).changes).toEqual([
      expect.objectContaining({
        operation: "upsert",
        pageId: "p2",
        path: "pages/真正改名.md",
        title: "真正改名",
      }),
    ]);
```

- [ ] **Step 3: Run both regressions and verify RED**

Run:

```bash
npm test -- tests/unit/status.test.ts tests/e2e/manual-sync-flow.test.ts
```

Expected: FAIL because the resolved exact-path file still has title `标题 (2)`, `local.modified` contains `p2`, and `previewPush().changes` contains an unwanted upsert. The genuine rename assertions may already pass and must not be weakened.

- [ ] **Step 4: Implement the minimal baseline-aware title reconciliation**

In `resolvePageIdentities()`, replace the first result construction with:

```ts
  for (const file of files) {
    const page = byPath.get(portablePathKey(file.relativePath));
    const resolvedTitle =
      page !== undefined &&
      page.relativePath.normalize("NFC") ===
        file.relativePath.normalize("NFC")
        ? page.title
        : file.title;
    if (page) resolvedIds.add(page.pageId);
    result.push({
      ...file,
      title: resolvedTitle,
      pageId: page?.pageId ?? null,
      identityStatus: page ? "resolved" : "new",
    });
  }
```

Do not change the later move-hint/hash identity branch: renamed files must retain their scanned basename title.

- [ ] **Step 5: Run the focused regressions and verify GREEN**

Run:

```bash
npm test -- tests/unit/status.test.ts tests/e2e/manual-sync-flow.test.ts
```

Expected: both files pass; the duplicate-title Pull is clean and the genuine local rename still produces one title/path upsert.

- [ ] **Step 6: Run the complete plugin gate**

Run:

```bash
npm run check
git diff --check
```

Expected: 30 test files and 168 tests pass; Prettier, ESLint with no errors, strict typecheck, production build, bundle safety, release metadata, and diff check all succeed.

- [ ] **Step 7: Commit the isolated fix**

```bash
git add src/core/status.ts tests/unit/status.test.ts tests/e2e/manual-sync-flow.test.ts
git commit -m "fix(sync): preserve baseline titles for allocated paths"
```

### Task 2: Re-run the Trusted Local HTTPS Acceptance Matrix

**Files:**
- Modify: `docs/verification/agentwiki-sync-v1.md`

**Interfaces:**
- Consumes: the 0.2.8 release bundle, AgentWiki `codex/readable-sync-paths`, local PostgreSQL 16, Redis, Nginx, and a temporary user-trusted CA restricted to `localhost` and `127.0.0.1`.
- Produces: a verification record containing only observed pass/fail evidence and a fully cleaned local trust/database/Vault state.

- [ ] **Step 1: Establish isolated HTTPS infrastructure**

Create a new `mktemp -d /tmp/agentwiki-https-e2e.XXXXXX` directory. Use CA common name `AgentWiki Codex Temporary Test Root 20260820-02`, disposable database `agentwiki_codex_https_e2e_20260820_02`, API port 3100, and HTTPS port 3443.

Generate a unique two-day CA and localhost server certificate. The leaf extension file must contain:

```text
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
```

Run from the temporary directory:

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout ca.key -out ca.crt -days 2 -sha256 \
  -subj '/CN=AgentWiki Codex Temporary Test Root 20260820-02' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -addext 'subjectKeyIdentifier=hash'
openssl req -new -newkey rsa:2048 -nodes \
  -keyout server.key -out server.csr -sha256 \
  -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out server.crt -days 2 -sha256 -extfile server.ext
openssl x509 -in ca.crt -noout -fingerprint -sha1
security add-trusted-cert -r trustRoot \
  -k /Users/neomei/Library/Keychains/login.keychain-db ca.crt
```

Configure Nginx with an absolute-path equivalent of:

```nginx
worker_processes 1;
pid /tmp/agentwiki-https-e2e-20260820-02/nginx.pid;

events { worker_connections 128; }

http {
  server {
    listen 127.0.0.1:3443 ssl;
    server_name localhost;
    ssl_certificate /tmp/agentwiki-https-e2e-20260820-02/server.crt;
    ssl_certificate_key /tmp/agentwiki-https-e2e-20260820-02/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 12m;
    location / {
      proxy_pass http://127.0.0.1:3100;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For $remote_addr;
    }
  }
}
```

The executor must replace only the `/tmp/agentwiki-https-e2e-20260820-02` prefix in that config with the actual `mktemp` result before starting Nginx.

Create and migrate the disposable database:

```bash
createdb agentwiki_codex_https_e2e_20260820_02
DATABASE_URL='postgresql://neomei@localhost:5432/agentwiki_codex_https_e2e_20260820_02' \
  pnpm --filter @agentwiki/server exec prisma migrate deploy
```

Start `apps/server/dist/main.js` with the disposable `DATABASE_URL`, `REDIS_URL=redis://localhost:6379`, fixed test-only application secrets, a base64 value decoding to exactly 32 bytes for `AGENTWIKI_DEPLOYMENT_SEED`, `PORT=3100`, `PROCESS_ROLE=api`, and `NODE_ENV=development`. Add only the uniquely named CA to the login keychain, record its SHA-1 fingerprint, and start Nginx with the generated config.

Expected checks:

```bash
/usr/bin/curl --fail --silent --show-error https://localhost:3443/api/health
openssl verify -CAfile ca.crt -verify_hostname localhost server.crt
security verify-cert -c server.crt -p ssl -s localhost -k /Users/neomei/Library/Keychains/login.keychain-db
```

The health response must report database, Redis, and audit persistence as `ok`; both certificate verifiers must succeed without `-k` or a certificate-warning bypass.

- [ ] **Step 2: Execute the real Obsidian lifecycle**

Use an isolated Obsidian user-data directory and Vault containing the exact built `main.js`, `manifest.json`, and `styles.css`. Through the real plugin UI:

1. Connect with a temporary one-time code over `https://localhost:3443`.
2. Map the temporary Space to `Wiki`.
3. Pull two server pages titled `重复标题` at `pages/重复标题.md` and `pages/重复标题 (2).md`.
4. Confirm both bodies and H1 text match their server SHA-256 hashes.
5. Reopen the sync center and require zero local changes and no push preview.
6. Restart Obsidian and require the mapping to remain active.
7. Rename the second file locally and require one path/title Push preview.
8. Rename a page on the AgentWiki Web/API side and require the next Pull to rename the local file without altering its body.
9. Rename the same page differently on both sides and require an explicit path conflict.
10. Stop the local HTTPS/API service, require an actionable offline error without deleting the mapping, restart services, and require status recovery.

If any step fails, preserve the exact failing state, return to systematic debugging, and do not mark the release gate complete.

- [ ] **Step 3: Remove every temporary trust and data artifact**

Close only the isolated Obsidian process, stop the isolated Nginx/API processes, delete the CA by its recorded SHA-1 fingerprint, drop only the explicitly named disposable database, and move the temporary workspace to Trash.

Verify:

```bash
if security find-certificate -c "AgentWiki Codex Temporary Test Root 20260820-02" /Users/neomei/Library/Keychains/login.keychain-db >/dev/null 2>&1; then exit 1; fi
psql -d postgres -Atc "select count(*) from pg_database where datname = 'agentwiki_codex_https_e2e_20260820_02';"
lsof -nP -iTCP:3100 -iTCP:3443 -sTCP:LISTEN
```

Expected: certificate lookup fails, database count is `0`, and no process listens on ports 3100 or 3443. The user's normal Obsidian process may remain running; no file under `/Users/neomei/Obsidian/NeoMei-Docs` is opened or modified.

- [ ] **Step 4: Record only verified results**

Update `docs/verification/agentwiki-sync-v1.md` to state:

```markdown
真实 HTTPS Obsidian 验收使用受信任的临时 localhost CA 和隔离数据库完成。两篇同名页面首次 Pull 后本地状态为零变更；规范 `(2)` 后缀未产生标题 Push。真实本地改名仍产生 path/title upsert；远端改名保持正文并重命名本地文件；双端改名进入显式 path conflict；离线时映射保留，服务恢复后状态可重新加载。验收后临时 CA、数据库、监听进程和活动测试目录均已清理。
```

Do not claim mobile-device, production, marketplace, deployment, or independent-review results that were not executed.

- [ ] **Step 5: Verify and commit the acceptance record**

```bash
git diff --check
git status --short
git add docs/verification/agentwiki-sync-v1.md
git commit -m "docs: record trusted HTTPS Obsidian acceptance"
```

Expected: only the verification record is included in this commit; the plugin product worktree is clean afterward.

### Task 3: Final Cross-Repository Completion Audit

**Files:**
- Verify only: plugin and AgentWiki worktrees

**Interfaces:**
- Consumes: Task 1 code commit, Task 2 verified UI record, AgentWiki behavior HEAD `13f9fbbb6aa5c96e7a0a89e33a6a947a22acebaf`.
- Produces: an evidence-backed merge/readiness decision without mutating production, the marketplace, or the dirty primary AgentWiki checkout.

- [ ] **Step 1: Re-run plugin and server gates from committed heads**

```bash
# Plugin worktree
npm run check
git diff --check
git status --short

# AgentWiki product worktree
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
git status --short
```

Expected: all commands exit 0. Plugin status is empty. AgentWiki product code is clean; only the two pre-existing outer `.superpowers/sdd/task-*.md` reports may remain modified.

- [ ] **Step 2: Review the complete behavior diff**

```bash
git diff --check
git log --oneline --decorate --no-merges e5a620f..HEAD
git diff --stat e5a620f..HEAD
git diff e5a620f..HEAD -- src tests manifest.json package.json package-lock.json versions.json docs
```

Check every design invariant: unchanged allocated paths retain baseline titles, real renames retain basename titles, bodies remain unchanged, mappings persist, missing roots do not delete mappings, and no credential enters `data.json`.

- [ ] **Step 3: Report the actual readiness boundary**

Report implementation, automated gates, real HTTPS UI evidence, remaining independent-review availability, dirty-primary integration risk, and all non-actions. Do not merge, migrate production, deploy, publish, push, install into the user Vault, or submit to the marketplace without a new explicit instruction.
