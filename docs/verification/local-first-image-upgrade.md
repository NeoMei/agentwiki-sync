# Local-first image upgrade public contract verification

Date: 2026-09-06

Status: **cross-protocol publish contract passed; public Space-mode list gate failed**. This is a bounded U1 checkpoint, not authorization to continue U2+, release, deploy, or claim full acceptance.

## Scope and transport

The live verifier used the public v2/v3 wire schemas and the plugin's actual `AgentWikiClient`, `V2TreeRemote`, and `V3TreeRemote`. A transient opt-in provider delegated credential-free requests to an already authenticated isolated Obsidian renderer. It allowed only three controller-owned synthetic Space IDs (the first published fixture was preserved after an assertion-only test error, and two fresh Spaces supplied the final cases), public sync routes, and session IDs returned during this run; it capped responses at 2 MiB. No credential was read, serialized, logged, created, or written to disk. The controller owns cleanup of all synthetic Spaces.

The verifier itself contains no server URL or credential. Missing `AGENTWIKI_UPGRADE_LIVE_CONTEXT_MODULE` is an error rather than a skipped test.

## Results

### Fixed readers and projection

- Unit/integration gate: 7/7 passed.
- Fixed revision requests remain pinned to R across pagination.
- The reader rejects cross-Space data, changing pagination metadata, missing or duplicate IDs, unknown parents, page-body hash mismatch, declared/body/manifest byte mismatch, revision-hash mismatch, cumulative-limit overflow, and HTTP 404.
- Revision `0` is accepted only with sequence/count/body/manifest zero fields and the public SHA-256 empty digest. It is not inferred from an error response.
- Legacy projection preserves Page/Folder IDs, timestamps, metadata and order, adds empty reference arrays, and keeps revision identity outside the calculation tree. It rejects invalid or remotely managed image references and asks the caller to refresh Space mode.

### Actual public cross-protocol publication

Server label: `agentwiki-public-production-isolated-synthetic`.

1. Populated legacy Space: fixed v2 R `cmtp4mmy301v22jx0sauqvein`, sequence 4, two folders and two plain-text Pages. Public session/chunk/complete/batch/finalize produced exactly one v3 Revision `cmtp4okbu01vn2jx07cmd7rod`, sequence 5. Candidate/fixed-published SHA: `ca94452b03419f3d554738a00806dcfe4704003a73f5a22dc9fd596a2fc09f08`.
2. Strictly empty legacy Space: fixed v2 R `0`, sequence 0 and literal zero evidence. First Page plus its referenced PNG produced exactly one v3 Revision `cmtp4ole301w02jx0xp67gggg`, sequence 1. Candidate/fixed-published SHA: `1d4016d8d9e7909ee1d92a84abc954308670a6aaa7dee7d2f88ab9e38ab8acc3`.

Both cases used a valid decoded 1x1 PNG and canonical `![[assets/<name>.png]]` Markdown. Fixed R3 reads proved the published tree hash, exact folder metadata/order, untouched Page equality, one expected attachment ID, and byte-for-byte attachment download. Blob upload was conditional on the actual `missingContentHashes`, so public dedup remains valid.

### Blocking public list defect

Before publication, real authenticated `GET /api/sync/v3/spaces` repeatedly returned HTTP 500 with the strict `INTERNAL_ERROR` envelope. This is an actual public contract failure and is not treated as fallback or hidden by a fake. After both owned legacy Spaces became native v3, the same endpoint returned 200.

Read-only inspection of release source at `d295fcc26e3e7574a2abb678c9b3dc72b5313316` identifies a likely cause, not a production stack-trace proof: legacy folder projection uses nullish fallback for `parentFolderId` and forwards a Date-valued `updatedAt`, while the published strict v3 schema requires root `null` and RFC3339 text. The normal writer path already preserves null and formats timestamps, which is consistent with actual Push success.

Do not suppress this 500 in the plugin, strip folders, or pre-upgrade fixtures to mask it. Remediation belongs in a separately authorized AgentWiki main-project task with mixed native/legacy/empty list regression coverage and its own release/deploy gate.

## Commands

```text
npx vitest run tests/integration/local-image-upgrade-contract.test.ts
npm run typecheck
AGENTWIKI_UPGRADE_LIVE_CONTEXT_MODULE=<credential-free-provider> npx vitest run --config vitest.live.config.ts
```

The live run result was 3 passed / 1 failed: strict-empty read and both actual atomic publication cases passed; the independent pre-upgrade public v3 Space-list assertion failed on HTTP 500. The command therefore correctly exited non-zero.
