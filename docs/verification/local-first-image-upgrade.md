# Local-first image upgrade public contract verification

Date: 2026-09-06

Status: **U1–U6 are complete and U7's local response-loss verifier is prepared on the current candidate.** Public recovery, desktop, Android, whole-branch review and release gates remain **NOT_RUN**. This is not completed Task19 acceptance, installation or release. Earlier failed runs below remain historical evidence.

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

### Historical pre-hotfix independent-review reproof

The review runner precomputed and cached candidate C's public hash before the first write. Its fixed R3 proof required `published.revisionContentHash` to equal that cached hash, required the changed Page to equal the candidate Page, and compared the entire canonical calculation tree (folders, Pages, attachments, order and fields) with candidate C.

1. Fresh populated legacy Space: fixed v2 R `cmtp5atjy022p2jx0xlfzuwwq`, sequence 4 → fixed v3 R `cmtp5eulj023d2jx0hgpkmb71`, sequence 5. Candidate/fixed-published SHA: `ccd5162a38233aa3b895dee0ba392588282676cca59f3a07a3d58fab00f6a4b6`.
2. Fresh strictly empty legacy Space: fixed v2 R `0`, sequence 0 → fixed v3 R `cmtp5evqu023q2jx0zepcitqd`, sequence 1. Candidate/fixed-published SHA: `999cdc8e954f8c4bf04e75378192c434a894de2109ba5fa4161478a9a2e8ac79`.

At that historical checkpoint the pre-upgrade list probe used `TreeSyncSpaceListResponseV3Schema` and required both selected rows to retain the exact legacy bindings. The public endpoint returned HTTP 500 before parsing, so that run exited non-zero at 3 passed / 1 failed. The server correction and successful reproof at the top of this document supersede this old failure without erasing it.

### Historical pre-hotfix public list defect

Before publication, real authenticated `GET /api/sync/v3/spaces` repeatedly returned HTTP 500 with the strict `INTERNAL_ERROR` envelope. This is an actual public contract failure and is not treated as fallback or hidden by a fake. After both owned legacy Spaces became native v3, the same endpoint returned 200.

Read-only inspection of release source at `d295fcc26e3e7574a2abb678c9b3dc72b5313316` identifies a likely cause, not a production stack-trace proof: legacy folder projection uses nullish fallback for `parentFolderId` and forwards a Date-valued `updatedAt`, while the published strict v3 schema requires root `null` and RFC3339 text. The normal writer path already preserves null and formats timestamps, which is consistent with actual Push success.

This was repaired and re-proved through the separately authorized server work recorded above. The plugin did not suppress the 500, strip folders, or mutate fixtures to mask it.

## U7 local response-loss verifier preparation

Candidate base: `b29b8111f1f4d917d27df83e3b23bae3a3f665d0`. The new local-only harness uses the actual `LocalImageUpgradeEntry.create()` production assembly with `AgentWikiClient`, protocol negotiation, coordinator, repositories and push service. Its controlled HTTP fixture delegates v3 mutation behavior to the existing fake remote; it is not public-server or device evidence.

- A create 201 response and a finalize 200 response are each dropped only after the public response schema accepts the genuine delegate response.
- Restart rebuilds the actual entry over the same control/vault state. Both cases retain one operation ID, one idempotency key and one server session, reach terminal `complete`, commit the verified v3 baseline, and advance the remote sequence exactly once (`0 → 1`). A final normal recovery clears the in-memory pending state.
- A 503 response is returned normally and a malformed 2xx is rejected before either can be recorded as a dropped success.
- Focused gate: 3 files / 71 tests passed (`local-image-upgrade-recovery-verifier`, `local-image-upgrade-entry`, `local-image-upgrade-push`). Full gate: 60 files / 869 tests passed; formatting, typecheck, build, bundle safety and release metadata passed. `main.js` is 1,596,072 bytes with SHA-256 `9dcd4c40ca1d7419b52f213511324ca4877a1da4f0b5ab70cafbeb46041692aa`.
- `npm audit --json` exited 0 with 450 dependency records and 0 vulnerabilities.
- Running the live config without `AGENTWIKI_UPGRADE_LIVE_CONTEXT_MODULE` exits 1 with `live verification never skips`; therefore public create/finalize recovery remains **NOT_RUN**, not a synthetic PASS. The approved provider must supply fresh scoped control/vault ports and public transport without exposing credentials.

The full lint inventory remains 0 errors / 17 warnings; no rule was disabled and no new U7 file is warned:

1. `src/main.ts:215:38` `obsidianmd/ui/sentence-case`
2. `src/obsidian/settings-tab.ts:15:14` `obsidianmd/settings-tab/prefer-setting-definitions`
3. `src/obsidian/settings-tab.ts:227:24` `obsidianmd/ui/sentence-case`
4. `tests/integration/plugin-settings-lifecycle.test.ts:2:1` `obsidianmd/no-nodejs-modules`
5. `tests/integration/protocol-conformance.test.ts:177:19` `@typescript-eslint/no-deprecated`
6. `tests/performance/bounded-space.test.ts:2:1` `obsidianmd/no-nodejs-modules`
7. `tests/performance/bounded-space.test.ts:76:5` `obsidianmd/no-global-this`
8. `tests/performance/bounded-space.test.ts:88:5` `obsidianmd/no-global-this`
9. `tests/performance/bounded-space.test.ts:91:9` `obsidianmd/no-global-this`
10. `tests/setup.ts:1:1` `obsidianmd/no-nodejs-modules`
11. `tests/setup.ts:3:23` `obsidianmd/no-global-this`
12. `tests/setup.ts:8:23` `obsidianmd/no-global-this`
13. `tests/setup.ts:10:10` `obsidianmd/no-global-this`
14. `tests/unit/preview-modal-layout.test.ts:1:1` `obsidianmd/no-nodejs-modules`
15. `tests/unit/release-metadata.test.ts:2:1` `obsidianmd/no-nodejs-modules`
16. `tests/unit/test-collection-config.test.ts:1:1` `obsidianmd/no-nodejs-modules`
17. `vitest.config.ts:1:1` `obsidianmd/no-nodejs-modules`

The tracked Task14 report belongs to the original adjacent Task14 work (`a5670ca`, following `c5f5fc9`) and is preserved. It is not U7 scratch and was not deleted or rewritten.

| Channel | U7 status |
| --- | --- |
| Local verifier and complete test gate | PASS on the candidate described above; final commit is recorded in the controller handoff |
| Public create/finalize response-loss recovery | NOT_RUN; awaits the controller's fresh scoped provider and authorized CLI path |
| GitHub / npm / server production refresh | NOT_RUN by this local-only verifier author; controller-owned evidence pending |
| Desktop isolated Vault | NOT_RUN; no bundle was installed and no Vault was changed |
| Android Obsidian | NOT_RUN; requires the user's unlocked device |
| Whole-branch review / plugin release | NOT_RUN |

## Commands

```text
npx vitest run tests/integration/local-image-upgrade-contract.test.ts
npm run typecheck
AGENTWIKI_UPGRADE_LIVE_CONTEXT_MODULE=<credential-free-provider> npx vitest run --config vitest.live.config.ts
```

The live run result was 3 passed / 1 failed: strict-empty read and both actual atomic publication cases passed; the independent pre-upgrade public v3 Space-list assertion failed on HTTP 500. The command therefore correctly exited non-zero.
