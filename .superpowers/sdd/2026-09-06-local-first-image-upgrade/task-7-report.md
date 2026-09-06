# Task 7 local verifier implementer report

## Status

`DONE_WITH_CONCERNS`: the bounded U7 local verifier/test/evidence work is ready
for controller review. Public HTTP recovery, desktop Vault, Android, whole-branch
review, installation and release remain `NOT_RUN`; this report does not mark U7
or original Task19 complete.

Base before this change:
`b29b8111f1f4d917d27df83e3b23bae3a3f665d0` (`codex/referenced-image-sync-v3`,
tracked clean).

## Assembly and behavior

- `verification/local-image-upgrade-recovery.ts` wraps an actual delegated
  `HttpPort`. It awaits a 2xx response and validates the public create/finalize
  response schema before recording and dropping it.
- The verifier constructs `AgentWikiClient`, `ProtocolNegotiator`, production
  repositories and `LocalImageUpgradeEntry.create()`. It never substitutes a
  fake coordinator, writes a journal by hand or fabricates publication success.
- Restart uses the same control/vault state. It proves the same operation ID,
  idempotency key and server session are retained, terminal journal phase is
  `complete`, `verifiedPublication` equals the v3 baseline, and head sequence
  advances exactly once. A normal terminal recovery then clears the entry's
  in-memory pending state.
- `verification/local-image-upgrade.live.ts` requires explicit recovery cases
  and `serverOrigin`; absent provider data is a hard error. There is no memory
  store fallback. The eventual provider must implement separately guarded,
  path-scoped control/vault ports for fresh controller-owned mappings and expose
  no secret.

## TDD evidence

### Wrapper RED/GREEN

Command:

`npx vitest run tests/integration/local-image-upgrade-recovery-verifier.test.ts`

Initial RED: the schema-valid create 201 promise resolved instead of throwing the
expected `U7_CREATE_SUCCESS_RESPONSE_LOST`. GREEN: 1/1 passed after adding the
post-response wrapper.

The wrapper now also proves that a 503 is returned unchanged and that a malformed
2xx fails schema validation before it is recorded or dropped.

### Actual Entry recovery RED/GREEN

The two initial table cases failed with
`U7_RECOVERY_VERIFIER_NOT_IMPLEMENTED`. After the actual production assembly was
implemented they exercised create-response and finalize-response loss.

Three intermediate failures were local fixture/verifier assembly errors, not
product RED evidence: the synthetic session status omitted `protocolVersion`,
the batch receipt omitted `receivedBatchCount`, and the verifier initially
treated the intentionally retained terminal `complete` journal as unfinished.
Those fixture expectations were corrected; no product source was changed.

A final strict evidence RED failed because `terminalPhase`,
`verifiedPublicationRevision` and `baselineRevision` were absent. GREEN added
those returned assertions. Latest focused command:

`npx vitest run tests/integration/local-image-upgrade-recovery-verifier.test.ts tests/integration/local-image-upgrade-entry.test.ts tests/integration/local-image-upgrade-push.test.ts`

Result after the two negative wrapper cases: 3 files / 71 tests passed.

## Complete local gates

- `npm run check` — exit 0; formatting and typecheck passed; 60 test files / 869
  tests passed; build and bundle safety passed; release metadata 0.4.0 passed.
- Bundle: 1,596,072 bytes; `main.js` SHA-256
  `9dcd4c40ca1d7419b52f213511324ca4877a1da4f0b5ab70cafbeb46041692aa`;
  `manifest.json` SHA-256
  `7b001849eafc37311a720c56d62f37704b1697ea75a4a5b801423d4be443daee`.
- `env -u npm_config_allow_scripts npm audit --json` — exit 0; 450 dependency
  records; 0 vulnerabilities at every severity.
- `env -u AGENTWIKI_UPGRADE_LIVE_CONTEXT_MODULE npx vitest run --config vitest.live.config.ts`
  — exit 1, 1 failed suite / no tests, exact error
  `AGENTWIKI_UPGRADE_LIVE_CONTEXT_MODULE is required; live verification never skips`.
  This is correct `NOT_RUN` evidence and made no live request.
- `git diff --check` — exit 0.

ESLint reported 0 errors / 17 warnings. Exact inventory is recorded in
`docs/verification/local-first-image-upgrade.md`; no lint rule was disabled and
none of the new U7 files is warned.

## Ownership and gaps

The tracked adjacent Task14 report was introduced by original Task14 commit
`a5670ca` after `c5f5fc9`; it is preserved and not treated as U7 scratch. No
scratch, fixture or unreferenced image was deleted.

Controller-owned gates still required: fresh scoped public provider and two new
legacy fixtures, public create/finalize response-loss run, authorized isolated
desktop Vault installation/flow, unlocked Android flow, independent final-range
and whole-branch review, channel refresh and release decision.
