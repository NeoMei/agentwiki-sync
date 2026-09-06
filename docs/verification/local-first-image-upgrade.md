# Local-first image upgrade public contract verification

Date: 2026-09-06

Status: **U1 public contract gate passed after the independently authorized server hotfix**. U2–U7 may now proceed. This is not completed plugin implementation, release or real-device acceptance. Earlier failed runs below remain historical evidence.

## Server correction and final U1 reproof

The separately authorized main-project hotfix `4a824e74d69b7c149a608db08b943f28149f38c3` preserves root null and converts Prisma Folder timestamps to RFC3339. It was reviewed independently (C0/I0), merged through [AgentWiki PR #9](https://github.com/NeoMei/AgentWiki/pull/9) at `ef9f20dae4937941e5ba9579dccd0091657ca02b`, and deployed on 2026-09-06. No schema/protocol/package version change was required. The deployed source SHA-256 matches the candidate, all three services are active, and public health reports all checks ok.

Before the switch, the actual new legacy pair reproduced list500. After the switch, the same pair returned strict list200, retained exact source revisions and `legacy_v2`, with owner/read/publish bindings intact. Reads did not publish an upgrade.

The unchanged strict plugin verifier at `40db5bc` then passed **4/4**, exit0:

- Populated source R `cmtp6620x024x2jx0dapa9c1v`, sequence4 → R3 `cmtp6v0kv006bbktfvelsn8f1`, sequence5; candidate and fixed-published hash `af365f4ef81e6eef196a50b2c68093e27303dbce2c984c44beb0b6bfc3e0f277`.
- Strict empty source R `0`, sequence0 → R3 `cmtp6v1qc006obktflo5pvivl`, sequence1; candidate and fixed-published hash `b60db33064a60cb6bcf621e4e2b6e267610e5b71c2dc67ccfc0cb1a699a72203`.
- Exact canonical candidate/full tree, unchanged Page/folder metadata, fixed R3, attachment metadata and downloaded PNG bytes passed the existing strict assertions.

Seven controller-owned synthetic Spaces are retained across all U1 attempts; earlier fixtures were not deleted or repurposed. The two final fixtures are now native and must not be reused as fresh legacy sources for U7. Android is currently absent from ADB; its actual acceptance remains NOT_RUN. No main Vault was modified and plugin0.4.0 remains unreleased.

## Scope and transport

The live verifier used the public v2/v3 wire schemas and the plugin's actual `AgentWikiClient`, `V2TreeRemote`, and `V3TreeRemote`. A transient opt-in provider delegated credential-free requests to an already authenticated isolated Obsidian renderer. Across the initial proof and independent-review reproof it allowed only five controller-owned synthetic Space IDs (three preserved from the initial run plus two fresh review fixtures), public sync routes, and session IDs returned during each run; it capped responses at 2 MiB. Each run selected only its current populated/empty pair. No credential was read, serialized, logged, created, or written to disk. The controller owns cleanup of all synthetic Spaces.

The verifier itself contains no server URL or credential. Missing `AGENTWIKI_UPGRADE_LIVE_CONTEXT_MODULE` is an error rather than a skipped test.

## Results

### Fixed readers and projection

- Reader/projection unit/integration gate: 7/7 passed.
- Verifier gate: 5/5 passed after first observing the three original-gap negative cases fail against the weak assertions. It separately rejects candidate-hash and full-canonical-tree mismatches, schema-invalid Space rows, and wrong mode/revision/role/permission bindings, while accepting the exact owned legacy contract.
- Fixed revision requests remain pinned to R across pagination.
- The reader rejects cross-Space data, changing pagination metadata, missing or duplicate IDs, unknown parents, page-body hash mismatch, declared/body/manifest byte mismatch, revision-hash mismatch, cumulative-limit overflow, and HTTP 404.
- Revision `0` is accepted only with sequence/count/body/manifest zero fields and the public SHA-256 empty digest. It is not inferred from an error response.
- Legacy projection preserves Page/Folder IDs, timestamps, metadata and order, adds empty reference arrays, and keeps revision identity outside the calculation tree. It rejects invalid or remotely managed image references and asks the caller to refresh Space mode.

### Actual public cross-protocol publication

Server label: `agentwiki-public-production-isolated-synthetic`.

1. Populated legacy Space: fixed v2 R `cmtp4mmy301v22jx0sauqvein`, sequence 4, two folders and two plain-text Pages. Public session/chunk/complete/batch/finalize produced exactly one v3 Revision `cmtp4okbu01vn2jx07cmd7rod`, sequence 5. Candidate/fixed-published SHA: `ca94452b03419f3d554738a00806dcfe4704003a73f5a22dc9fd596a2fc09f08`.
2. Strictly empty legacy Space: fixed v2 R `0`, sequence 0 and literal zero evidence. First Page plus its referenced PNG produced exactly one v3 Revision `cmtp4ole301w02jx0xp67gggg`, sequence 1. Candidate/fixed-published SHA: `1d4016d8d9e7909ee1d92a84abc954308670a6aaa7dee7d2f88ab9e38ab8acc3`.

Both cases used a valid decoded 1x1 PNG and canonical `![[assets/<name>.png]]` Markdown. Fixed R3 reads proved the published tree hash, exact folder metadata/order, untouched Page equality, one expected attachment ID, and byte-for-byte attachment download. Blob upload was conditional on the actual `missingContentHashes`, so public dedup remains valid.

### Independent-review reproof with strict candidate and mode bindings

The review runner precomputed and cached candidate C's public hash before the first write. Its fixed R3 proof required `published.revisionContentHash` to equal that cached hash, required the changed Page to equal the candidate Page, and compared the entire canonical calculation tree (folders, Pages, attachments, order and fields) with candidate C.

1. Fresh populated legacy Space: fixed v2 R `cmtp5atjy022p2jx0xlfzuwwq`, sequence 4 → fixed v3 R `cmtp5eulj023d2jx0hgpkmb71`, sequence 5. Candidate/fixed-published SHA: `ccd5162a38233aa3b895dee0ba392588282676cca59f3a07a3d58fab00f6a4b6`.
2. Fresh strictly empty legacy Space: fixed v2 R `0`, sequence 0 → fixed v3 R `cmtp5evqu023q2jx0zepcitqd`, sequence 1. Candidate/fixed-published SHA: `999cdc8e954f8c4bf04e75378192c434a894de2109ba5fa4161478a9a2e8ac79`.

The pre-upgrade list probe now uses `TreeSyncSpaceListResponseV3Schema` and, if the endpoint returns 200, requires both selected rows to be `legacy_v2` with the exact current v2 source revision, `role: owner`, `canRead: true`, and `canPublish: true`. The public endpoint still returned HTTP 500 before parsing, so this mandatory gate remains failed. The strict empty read and both fresh atomic publications continued independently and passed; the live command again exited non-zero at 3 passed / 1 failed.

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
