# Task 14 implementation report

## Status and range

- Status: DONE
- Repository: `/Users/neomei/项目/codexprojects/AgentWiki-Obsidian/.worktrees/referenced-image-sync-v3`
- Branch: `codex/referenced-image-sync-v3`
- BASE: `b8d6486d78529002dc1a596fd3fe4b34f3a666fc`
- Server public-contract evidence was read-only at frozen candidate `6ee4a50`; no server files were changed.

## Implemented

- Added an independent `TreeRemotePortV3` derived from the exact public `@neomei/agentwiki-sync-protocol@0.5.1` schemas. Legacy `TreeRemotePort`, v1/v2 shapes and the explicit v3 runtime-unavailable gate remain unchanged.
- Added `V3TreeRemote` for strict capabilities/Space/head/snapshot/delta/bootstrap preview+confirmed bootstrap/Push session/batch/status/finalize/abort/Blob chunk/complete/fixed-Revision download routes. All successful JSON objects use public strict schemas; strict v3 error envelopes are validated before retry classification.
- Snapshot iteration pins a `current` first page to the returned fixed Revision, rejects metadata/cursor/entity replay, checks published counts and manifest/body/attachment byte budgets while paging, then recomputes the canonical complete v3 manifest metrics and Revision hash. Delta iteration pins target metadata, rejects repeated entities/cursors, and applies negotiated target/item budgets.
- Added bounded HTTP response modes. JSON response text is measured before `JSON.parse`; binary success reads ArrayBuffer without touching JSON; declared and actual binary length are bounded; uploads send raw ArrayBuffer octets; 204 abort requires no JSON. The actual v3/v2 capabilities discovery path now uses this bounded-before-parse API.
- Added `BlobTransfer`: only `missingContentHashes` are uploaded; each Blob is loaded singly, chunked at the negotiated <=1 MiB limit, and run by at most `min(2, serverLimit)` workers. No Promise is created per attachment.
- Idempotent chunk and complete retries preserve the same session/hash/index/bytes and use bounded exponential attempts/time. 401/403, schema/size/hash/cursor/limit errors and strict `retryable:false` errors are not retried. A lost first chunk response is safely replayed with identical bytes.
- Upload receipts are immediately passed to a durable callback. `receiptFor(hash,index)` supports crash recovery: Task17 must supply receipts only from the already validated journal bound to the exact same input `sessionId`; the public receipt deliberately has no session field, so it must never be reused across sessions and no receipt digest is invented. Recovered receipts are strict-schema parsed and hash/index/chunkHash checked before skipping a chunk.
- Download deduplicates identical content hashes only after rejecting inconsistent size/MIME/dimensions, budgets the unique transfer before I/O, downloads fixed-Revision routes without query keys, verifies bytes against the manifest hash, and persists through the accepted Task13 `BlobStagingRepository`. Matching live partial journals resume and completed hashes are skipped; deterministic integrity failures clean staging while transient/abort state is retained for recovery.
- Bootstrap remains preview-only until a caller passes an explicit `{ userConfirmed: true }` input to the write method. Task16 runtime activation, parser changes, user Vault writes, publish/deploy and real-Vault work remain out of scope.

## TDD evidence

### RED

- Command: `npx vitest run tests/integration/v3-tree-remote.test.ts tests/integration/blob-transfer.test.ts`
- Result: 2 failed suites / no tests collected. The expected failures were `Cannot find module '../../src/agentwiki/v3-tree-remote'` and `Cannot find module '../../src/application/blob-transfer'`, proving both new production boundaries were absent before implementation.

### GREEN

- Focused command: `npx vitest run tests/integration/v3-tree-remote.test.ts tests/integration/blob-transfer.test.ts tests/unit/retry.test.ts tests/performance/bounded-space.test.ts tests/unit/protocol-negotiator.test.ts tests/unit/obsidian-adapters.test.ts`
- Focused result before final additions: 6 files passed, 93/93 tests passed. Later full check includes 10 v3 adapter tests and 8 Blob transfer tests.
- Final fresh command: `npm run check`
- Final result: format PASS; lint PASS with 0 errors and the same 21 pre-existing warnings; typecheck PASS; 47 test files and 505/505 tests PASS; build PASS; bundle safety PASS (1,271,916 bytes); release metadata PASS (0.3.0).

## Files changed

- `src/agentwiki/v3-tree-remote.ts` (new)
- `src/application/blob-transfer.ts` (new)
- `src/agentwiki/client.ts`
- `src/agentwiki/retry.ts`
- `src/application/protocol-negotiator.ts`
- `src/ports/http.ts`
- `src/ports/tree-remote.ts`
- `src/obsidian/adapters.ts`
- `tests/integration/v3-tree-remote.test.ts` (new)
- `tests/integration/blob-transfer.test.ts` (new)
- `tests/fakes/fake-http.ts`
- `tests/fakes/obsidian-mock.ts`
- `tests/unit/obsidian-adapters.test.ts`
- `tests/unit/retry.test.ts`

`tests/fakes/fake-tree-remote.ts` required no modification because Task14 preserves the legacy runtime gate and the fake remains a v1/v2 runtime fake; forcing v3 into it would wrongly broaden the frozen consumer union before Task16.

## Self-review

- Re-read the complete Task14 brief, public server contract, public package declarations, Task13 report/storage implementation, all changed production code and tests.
- Confirmed no internal server imports/copies, query spoof keys, Node runtime APIs, text decoding of upload Blob bytes, JSON parsing of binary success, unbounded attachment Promise fan-out, `current` download Revision, legacy shape widening, runtime v3 activation, secrets/Blob logging, server/Vault/release writes, or parser normalization.
- Confirmed limits clamp against both negotiated values and hard ceilings; snapshot response, object/count/byte/image limits and final canonical hash are enforced. The unavoidable Obsidian requestUrl whole-body allocation is bounded to one response/Blob rather than accumulated transfer bytes.
- Confirmed transient parallel worker failures finish only the already-current workers and stop assigning new hashes; deterministic download failures wait for bounded workers to settle before staging cleanup, preventing cleanup/write races.

## Concerns / next-task caller contracts

- `requestUrl` necessarily allocates one response body before the adapter can inspect its actual ArrayBuffer/text length. Declared binary length is rejected first when present; actual length is still checked before exposing/copying into transfer logic. This is the bounded single-Blob constraint accepted by the brief, not streaming fetch.
- Task17 owns the durable upload journal schema. Its `receiptFor` and `persistReceipt` implementations must serialize with that journal and enforce the exact session binding described above. Task14 intentionally does not create a second receipt repository or derive an undocumented receipt digest.
- Full lint retains 21 existing warnings in unrelated files; Task14 adds zero lint errors or warnings.

## Fix round 1

### Status and commit

- Status: DONE
- Fix BASE: `c5f5fc9f0fa9752a73088bc1c6b109f4226962db`
- Atomic implementation commit: `36594cd065bbc7fce4aedd5cd7a37e37d6c93137` (`fix(sync): enforce v3 remote transfer bounds`)

### Four Important findings repaired

- Removed the incorrect 100 MiB new-transfer cap from full Snapshot and Delta target Revision attachment-byte metrics. Snapshot still recomputes and compares the complete manifest/count/body/attachment metrics and Revision hash. The public Delta schema and fixed metadata checks still validate its target metrics. Upload transfer budgeting remains over only the unique `missingContentHashes`; download budgeting remains over the unique missing attachment input supplied to `downloadMissing`.
- Enforced negotiated `maxPageItems` on every parsed Snapshot response's combined Folder/Page/Attachment count and every Delta response's item count, before any entity is retained or yielded.
- Added `BlobStagingIntegrityError` with `retryable: false` for repository-detected missing/chunk-conflict/chunk-hash/chunk-verification/incomplete/size/complete-hash/complete-verification states. Exceptions thrown by underlying control-store reads and writes remain ordinary transient errors. `BlobTransfer` cleans its fixed staging root only for these typed integrity failures and the previously classified deterministic transfer/remote failures, after bounded workers settle.
- Bound Head, Snapshot and Delta response `spaceId` to the configured Space. A non-`current` Snapshot now rejects a first response whose Revision differs from the requested fixed Revision. Delta continues to bind `fromRevision`; metadata signature pinning still protects subsequent pages.

### TDD evidence

RED adapter command:

`npx vitest run tests/integration/v3-tree-remote.test.ts`

Result before production repair: 1 test file failed; 8 failed and 11 passed. The failures specifically showed large valid Snapshot/Delta metrics rejected, over-`maxPageItems` responses accepted, and wrong Space/fixed Revision responses accepted.

RED staging/transfer command:

`npx vitest run tests/integration/blob-transfer.test.ts tests/integration/blob-staging.test.ts`

Result before production repair: 2 test files failed; 2 failed and 23 passed. The storage assertion had no exported typed integrity constructor, and the real repository's complete-time verification failure left the staging tree present. The test-only corrupting store was tightened before production edits so the corruption occurs during `BlobStagingRepository.complete()` rather than during remote-byte validation.

GREEN focused command:

`npx vitest run tests/integration/v3-tree-remote.test.ts tests/integration/blob-transfer.test.ts tests/integration/blob-staging.test.ts`

Result: 3 test files passed; 44/44 tests passed. Coverage includes a valid 110 MiB full Revision, low unique missing transfer under a reduced budget despite larger complete requirements, reduced Snapshot/Delta `maxPageItems`, wrong target responses, actual repository complete-time integrity cleanup, and transient staging I/O preservation.

Fresh full command:

`npm run check`

Result: exit 0; format PASS; lint PASS with 0 errors and the same 21 pre-existing warnings; typecheck PASS; 47 test files and 518/518 tests PASS; build PASS; bundle safety PASS (1,271,916 bytes); release metadata PASS (0.3.0).

### Fix files changed

- `src/agentwiki/v3-tree-remote.ts`
- `src/application/blob-transfer.ts`
- `src/storage/blob-staging.ts`
- `tests/integration/v3-tree-remote.test.ts`
- `tests/integration/blob-transfer.test.ts`
- `tests/integration/blob-staging.test.ts`

### Fix self-review and caller contracts

- Re-read all four review findings against the changed control flow and confirmed per-response limits and target binding happen after strict schema parsing but before retention/yield.
- Confirmed the staging type change does not change the journal schema, integrity rules, fixed private root, locking, or cleanup scope and does not classify arbitrary underlying I/O by message text.
- Confirmed legacy v1/v2 behavior, the v3 runtime gate, parser, server, user Vault, publish and deploy remain untouched.
- Task16 must fully exhaust Snapshot iteration and terminal metric/hash validation before any download, merge, preview, or persistent effect. Task17 must supply `downloadMissing` only the locally absent unique hashes and bind recovered upload receipts to the exact persisted session journal; neither caller responsibility was moved into this fix.
