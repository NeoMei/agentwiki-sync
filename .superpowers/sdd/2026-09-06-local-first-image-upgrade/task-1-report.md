# Task 1 report — U1 fixed reader and public cross-protocol gate

## Verdict

`BLOCKED`: bounded U1 implementation and actual fixed-R → public v3 Push evidence are complete, but U1 is not DONE. The mandatory public Space-mode list gate remains failed with a reproducible server HTTP 500, so U2+ must remain paused pending controller adjudication and a separately authorized server task.

## Files

- Created `src/application/tree-snapshot-reader.ts`: shared validated fixed v1/v2 and v3 readers.
- Created `src/application/local-image-upgrade-plan.ts`: explicit v2 integrity validation and revision-less v3 projection.
- Created `tests/fakes/local-image-upgrade-fixture.ts`: exact required stable source fixture.
- Created `tests/integration/local-image-upgrade-contract.test.ts`: reader/projection regression contract.
- Created `verification/local-image-upgrade.live.ts` and `vitest.live.config.ts`: opt-in credential-free live public-contract runner.
- Created `docs/verification/local-first-image-upgrade.md`: redacted evidence and blocker boundary.
- Modified `src/application/sync-runtime.ts`: ordinary v2/v3 paths delegate to shared readers.
- Modified `tests/fakes/fake-tree-remote.ts`: derive canonical public v1/v2 manifest metadata instead of the old placeholder byte count, including the strict empty-genesis convention.
- Modified `tsconfig.json`: typecheck the live runner/config.

## TDD evidence

RED command:

```text
npx vitest run tests/integration/local-image-upgrade-contract.test.ts
```

Observed: 1/1 failed because the old Runtime accepted a fully self-consistent snapshot for a different Space. After correcting the fixture's foreign-Space hash, the promise resolved instead of rejecting. This was the intended missing behavior, not an import or fixture error.

GREEN command:

```text
npx vitest run tests/integration/local-image-upgrade-contract.test.ts
```

Observed: 7/7 passed, covering fixed R pagination, cross-Space/mixed page rejection, missing/duplicate identities and parents, body/manifest/revision hashes, declared and cumulative byte limits, strict revision-0 evidence, 404 preservation, projection fidelity, invalid/managed legacy image rejection, and real v3 adapter fixed-read verification.

## Actual public evidence

Transport used the controller-provided transient module `/tmp/agentwiki-local-upgrade-live.9mr3ZL/provider.mjs`; the committed code stores only the module environment-variable contract, no path, URL, credential, header, or secret. Controller evidence is in `controller-public-evidence.md`.

- Server label: `agentwiki-public-production-isolated-synthetic`.
- Populated case: `cmtp4mmy301v22jx0sauqvein` sequence 4 → `cmtp4okbu01vn2jx07cmd7rod` sequence 5; candidate and fixed published SHA `ca94452b03419f3d554738a00806dcfe4704003a73f5a22dc9fd596a2fc09f08`.
- Empty case: revision `0` sequence 0 → `cmtp4ole301w02jx0xp67gggg` sequence 1; candidate and fixed published SHA `1d4016d8d9e7909ee1d92a84abc954308670a6aaa7dee7d2f88ab9e38ab8acc3`.
- Both cases used public session, chunk/complete (or public dedup if not missing), batch, Finalize, head, fixed snapshot, and attachment download. Assertions proved sequence +1, Finalize/head revision equality, untouched Page preservation, folder metadata/order, exact revision hash, exact attachment ID and bytes.
- Cleanup owner: `controller-owned-U1-synthetic-spaces`.

Live command:

```text
AGENTWIKI_UPGRADE_LIVE_CONTEXT_MODULE=/tmp/agentwiki-local-upgrade-live.9mr3ZL/provider.mjs npx vitest run --config vitest.live.config.ts
```

Observed: 3 passed, 1 failed, exit 1. The actual empty read and both atomic upgrade cases passed. Independent `GET /api/sync/v3/spaces` expected 200 but received 500. Post-upgrade read-only probe returned 200 after the owned legacy-folder fixtures became native.

## Verification and concerns

- Focused 7/7: passed.
- TypeScript: passed.
- Scoped ESLint/format/diff check: passed before final gate.
- Full suite first exposed 36 legacy fixture failures because `FakeTreeRemote` still emitted placeholder manifest byte metadata. The fake was corrected to derive public canonical v1/v2 metadata (including the literal empty-genesis convention); the affected 131/131 tests passed, followed by the final full suite at 53 files / 712 tests, all passed.
- No main-server source/config/DB/deploy, primary Vault, publish, push, or U2+ change.

Concern: public Space-mode discovery cannot currently represent legacy folder Spaces and fails the U1 route gate. Read-only source/schema comparison suggests root parent null and Date serialization are lost in the legacy list projection. This is source-supported diagnosis, not a production stack trace. It requires a separate server fix and release gate; the plugin must not work around it by error-based downgrade.
