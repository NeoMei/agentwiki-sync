# Wiki archive and recovery repair

## Goal

Fix the confirmed Sync v2 archive payload defect and stuck recovery behavior. Restore the user's empty Wiki from the intact remote snapshot only after the stale unpublished archive task is safely retired. User approved the three fixes and local recovery on 2026-10-16. Public release is not part of this new request.

## Global Constraints

- Work only in the isolated plugin checkout. Server repository is read only; public sync protocol dependency remains the integration boundary.
- Never rewrite an existing confirmed journal into different changes and submit it. Preserve its confirmation and evidence. No automatic publication, no silent loss of local modifications, no credential exposure.
- A folder archive recursively owns descendants. Produce a valid, non-overlapping set of archives. If a descendant survives or moves, do not accidentally archive it; fail closed for unrepresentable combinations with a useful message rather than silently broaden deletion.
- Recovery must distinguish confirmed unpublished rejection from ambiguous network failure or already published state. A published response must complete reconciliation, never be discarded.
- Recovery UI must display actual persisted operation counts, including archives. Do not present empty placeholder localChanges as proof of no pending changes.
- Regression tests must model server recursive archive semantics, not merely mirror current plugin output. Preserve existing v1/v3, identity, receipt and crash recovery behavior.
- Implementation/testing use synthetic fixtures only. Root handles authorized original Vault recovery with backup and before/after remote readback. Do not inspect credentials or write to real Vault in subagents.

## Task 1: Repair archive planning and recovery

Base commit: f9004ff6a708744e25c0dbcac6a80603a1082e6d.

Known evidence: local empty Wiki has baseline 1 folder + 10 pages. Pending journal schemaVersion 2 has archive_folder plus 10 archive_page, eight of them under that folder. Server GET still shows original 1 folder/10 pages and original revision; session ready_to_finalize/result null. Folder+descendant archives fail CONTENT_TREE_PAYLOAD_INVALID mapped to PAYLOAD_INVALID.

Code pointers:

- src/application/sync-runtime.ts computePushChanges around2789: emits every missing folder and page with no ancestor coverage.
- src/application/tree-push-service.ts finalizeForResume around658/resume around740: BASE_STALE handled, PAYLOAD_INVALID keeps replaying.
- src/main.ts around1092: unfinished push diff uses empty localChanges placeholder.
- tests/fakes/fake-tree-remote.ts around334: folder archive only Map.delete, lacks server recursive/overlap behavior.
- tests/integration/q3-regression.test.ts around72: codifies redundant archives.
- Server read-only ContentTreeService.publishSyncV2BatchLocked lines971-995 rejects overlapping folder subtrees and explicit descendant page operations. Use CodeGraph first for any server exploration.

Implement smallest coherent repair:

1. Add failing regressions and deduplicate folder/page archive planning with nested folder and surviving/moved descendant cases.
2. Safely retire deterministic PAYLOAD_INVALID confirmed unpublished tasks so recovery can return to a fresh preview. Use existing durable terminal/superseded machinery where suitable; preserve original changes, handle .prev crash fallback, and avoid extra submits or automatic confirmation. Handle new finalize and resume paths consistently. Provide an explicit safe cancel/re-preview path if existing API permits; original Wiki recovery must not need manual journal deletion.
3. Show actual persisted pending operations in recovery UI, explicitly warning for folder/page archive counts. Cover v2 at minimum without regressing v1/v3.
4. Bring fake server semantics in line with known recursive archive contract and amend incorrect tests.
5. Run meaningful red/green regression evidence, targeted tests, format/typecheck/build as needed. Commit source/test changes; do not bump version, publish, install, touch original Vault, or create subagents. Write report with exact commands/outcomes and remaining limitations.

## Acceptance

Task review (spec and quality), full plugin check, whole-branch review, then root-controlled backed-up native recovery. Cloud revision/counts must be unchanged; local Wiki files must match snapshot and native preview must show zero differences. Project management mapping must remain intact.
