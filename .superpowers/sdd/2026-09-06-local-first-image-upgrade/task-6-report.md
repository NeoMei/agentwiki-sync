# Task 6 implementer report

## Status

Implementation is complete and frozen for independent review. The approved
route, extracted plugin harness, strict fresh protocol reads, confirmed-preview
repository, pure initial Page/Folder binding helper, application entry draft
lifecycle, actual plugin factory routing, upgrade preview modal, restart
recovery, one-confirmation image upgrade, and the separately confirmed
all-images-cancelled v2 text Pull then existing v2 Push are present.

Frozen implementation commit:
`b9d7b85d121007efd192289a3a1378791c3ab40c`.

## TDD evidence

### Behavioral RED: plugin discovery discarded public Space mode

Command:

`npx vitest run tests/integration/local-image-upgrade-entry.test.ts -t "preserves strict v3 Space mode"`

Observed failure: the real `plugin.onload()` / `requestUrlState` discovery path
returned the Space without the expected `syncMode: "legacy_v2"` field. This was
the intended failure because main projected a strict v3 Space into the legacy
summary and discarded its mode. After preserving `syncMode`, this test passed.

### Interface RED: fresh v2 capabilities

Command:

`npx vitest run tests/unit/protocol-negotiator.test.ts -t "reads strict v2 capabilities independently"`

Observed failure: `subject.selectV2Fresh is not a function`. This is recorded as
an interface/scaffolding RED rather than behavioral evidence. The resulting test
does exercise the behavior that a strict fresh v2 read leaves the cached v3
selection unchanged.

### Behavioral RED: persisted merge materialization was not authenticated

Command:

`npx vitest run tests/integration/local-image-upgrade-entry.test.ts -t "stored merge materialization"`

Observed failure: `promise resolved ... instead of rejecting` after the stored
merge's resolved Page body/hash was changed while the independently hashed
candidate, authorization, and local-plan fields were left intact. The expected
failure showed that self-consistent top-level hashes alone did not bind the
calculation resolutions to materialization. The storage repository now rebuilds
the calculation preview and compares resolved materialization, local actions,
expected path states, and the local plan before accepting a load.

GREEN command:

`npx vitest run tests/integration/local-image-upgrade-entry.test.ts -t "stored merge materialization"`

Result: 1 passed, 12 skipped.

Regression command:

`npx vitest run tests/integration/local-image-upgrade-push.test.ts tests/integration/local-image-upgrade-local.test.ts`

Result: 2 files passed, 42 tests passed.

### Interface RED: no-baseline explicit Page/Folder identity alignment

Command:

`npx vitest run tests/integration/local-image-upgrade-plan.test.ts -t "aligns explicit initial"`

Observed failure: `resolveExplicitInitialTreeBindings is not a function`. This is
also interface/scaffolding RED, not final behavioral entry evidence. The GREEN
test proves that only explicitly paired local Page/Folder identities are changed,
parent and child references remain consistent, remote-only objects are not copied
into L, local content remains local for the normal merge resolver, and original
`rawPathStates` remain unchanged.

GREEN result: 1 passed, 8 skipped.

### Current application-entry scaffold RED

Command:

`npx vitest run tests/integration/local-image-upgrade-entry.test.ts -t "no-baseline local-image draft"`

Observed failure: module `src/application/local-image-upgrade-entry.ts` does not
yet exist. This is explicitly a scaffold/import RED and is not claimed as
behavioral evidence. The next implementation step is the approved narrow entry.

GREEN command:

`npx vitest run tests/integration/local-image-upgrade-entry.test.ts -t "no-baseline local-image draft"`

Result: 1 passed, 13 skipped. The real entry reads strict v3 and v2 public
state, computes an empty non-persisted B when the baseline is genuinely absent,
scans the Vault for L, preserves remote-only Pages outside L, and returns the
typed initial-binding draft without writing the Vault or starting a v3 upload.

### Interface/scaffold RED: all images cancelled text-preview preparation

Command:

`npx vitest run tests/integration/local-image-upgrade-entry.test.ts -t "all-images-cancelled"`

After correcting the synthetic snapshot's byte metadata, the RED was
`entry.prepareTextSyncPreview is not a function`. This is explicitly an
interface/scaffolding RED, not behavioral evidence. GREEN with the same command:
1 passed, 31 skipped. The entry now re-reads strict public v2/v3 authority,
replays explicit initial binding and all Page/Folder decisions, rebuilds the v2
tree through `buildTreePullPreview`, and accepts it only when the resolved text
candidate exactly equals the no-attachment v3 calculation. Preview preparation
performed GET requests only, with zero Vault operation-log entries and zero
control-store files. The first failed run (`快照字节数不匹配`) was a fixture
metadata gap and is not product RED evidence.

## Latest passing checkpoints

- Scanner RED: before `maxTotalBodyBytes` existed, two 3-byte Pages under a
  4-byte per-Page cap and 100-byte total cap failed with `PAGE_TOO_LARGE` because
  aggregate bytes were compared to the per-Page cap. GREEN:
  `npx vitest run tests/unit/tree-scan.test.ts -t "per-page and total"` — 1 passed.
- Actual factory RED: `runSyncStrategy` for a public `legacy_v2` Space with a
  real local Markdown image attempted `/api/sync/v3/spaces/space-1/head` through
  the old runtime path instead of opening the upgrade preview. GREEN: 1 passed;
  the rendered modal has the exact action `确认升级并同步`, and before click every
  request is GET and Vault business writes are zero.
- Actual sync-center RED: `collectSyncDiff` returned ordinary `Sync v2` status
  and bypassed the image-upgrade route. GREEN: 1 passed with
  `Sync v2 → Sync v3`, image detail, GET-only traffic, and zero Vault writes.
- Actual bootstrap RED: `collectSyncDiff` called a strict v3 head before the
  bootstrap confirmation path. GREEN: 1 passed with no head, delta, or v2
  request.
- Upgrade modal RED: the real modal exposed only the historical confirmation
  label and no read-only disable reason. GREEN: 1 passed with the exact upgrade
  label and viewer disable reason.
- Current combined checkpoint:
  `npx vitest run tests/integration/plugin-settings-lifecycle.test.ts tests/integration/preview-modal-interactions.test.ts tests/integration/local-image-upgrade-entry.test.ts tests/integration/local-image-upgrade-plan.test.ts tests/unit/protocol-negotiator.test.ts tests/unit/tree-scan.test.ts && npm run typecheck`
  — 6 files, 126 tests passed; typecheck exited 0.
- Pending recovery behavioral RED: after a confirmed preview/journal was
  persisted through the real Vault adapter and the plugin was restarted,
  `collectSyncDiff` attempted `POST /api/sync/v3/spaces/space-1/push-sessions`.
  GREEN: diff loading is read-only, returns `recoveryPending`, and only
  `runSyncStrategy` can resume the already-authorized operation.
- One-confirm actual entry GREEN: the real rendered button drove strict
  session/capability/Space/v2 snapshot reads, one v3 push session, image chunk,
  completion, batch, finalize, authoritative snapshot/blob download, local
  transaction, identity and v3 baseline commit. The button called Entry.confirm
  exactly once. A new plugin instance then cleaned terminal payload evidence and
  continued the same factory call as native v3 without v2/head/delta recursion.
  The earlier missing binary download responder was a synthetic fixture gap,
  not a product RED.
- Actual fail-closed GREEN: strict v3 Space responses 401/403/409/429/500 and an
  unknown public mode all reject without any v2 fallback request.
- Preview invalidation behavioral RED: a real Vault `modify` event left the
  upgrade confirmation enabled. GREEN: factory invalidates the attached Entry,
  the modal immediately disables the current button with `预览已失效`, and
  finalize rejects stale epochs before/after recomputation.
- Async pagination behavioral RED: after an async Page decision started, moving
  the line pager recreated the action button; the Promise settled but refreshed
  only the old button closure, leaving the visible button disabled. GREEN:
  PreviewModal refreshes the current render's action state. All 9 rendered modal
  interaction tests and typecheck pass.
- The temporary main cast from an upgrade calculation tree to a published
  `PullPreviewV3` was removed. PreviewModal/preview-logic now consume the exact
  `TreePullPreviewV3<TreeContentV3>` calculation boundary, which remains
  structurally compatible with ordinary v3 Pull previews and uses the generic
  existing resolvers.
- Pending lifecycle behavioral RED: real restart then remove/disconnect fell
  into the carrier's v1 head instead of protecting the operation. GREEN: both
  gates detect the routed unfinished upgrade first and preserve mapping and
  connection state.
- Late local-apply GREEN: a synthetic edit injected only after authoritative
  finalize is preserved; the first real PreviewModal and restarted SyncCenter
  both show the actionable `恢复已确认升级` message, and retry never calls finalize
  a second time.
- Restart/confirm focused checkpoint:
  `npx vitest run tests/integration/local-image-upgrade-entry.test.ts -t "one confirmation|pending upgrade"`
  — 2 tests passed. The tests drive the real plugin factory, rendered modal,
  Obsidian Vault adapter, strict synthetic HTTP protocol, persisted intent, and
  restart path. The binary responder initially omitted an attachment download;
  that failure was a synthetic fixture gap and is not recorded as a product RED.
- Strict late-local focused checkpoint:
  `npx vitest run tests/integration/local-image-upgrade-entry.test.ts -t "surfaces late local"`
  — 1 test passed, 29 skipped.
- Pending removal/disconnect focused checkpoint:
  `npx vitest run tests/integration/local-image-upgrade-entry.test.ts -t "preserves an unfinished upgrade"`
  — 1 test passed, 30 skipped. Its RED attempted an unexpected legacy v1 head;
  GREEN routes the unfinished intent before the carrier runtime.
- Strict status focused checkpoint:
  `npx vitest run tests/integration/local-image-upgrade-entry.test.ts -t "does not fall back"`
  — the 401/403/409/429/500 matrix passed without v2 fallback (429/500 include
  the production retry delay).
- Preview interaction checkpoint:
  `npx vitest run tests/integration/preview-modal-interactions.test.ts`
  — 9 tests passed after the paginated async-confirm RED; the immediately
  following `npm run typecheck` exited 0 after making the calculation-tree type
  explicit as `TreePullPreviewV3<TreeContentV3>`.
- User-visible pending error checkpoint:
  `npx vitest run tests/unit/user-errors.test.ts -t "remote-published local-pending"`
  — 1 test passed after the RED returned the internal code verbatim.
- Guarded v2 Pull behavioral RED: a Vault edit injected from the Pull progress
  yield was eventually rejected by `TreeTransaction`, but only after the v2
  baseline journal, generation, and preview body sidecar had been written
  (control store grew from 9 to 12 entries). The guarded path now checks the
  frozen expected path states after progress and again after any async conflict
  resolution, immediately before `baseline.prepare`; the same expected states
  still reach `TreeTransaction.prepare` for the later race boundary. Command:
  `npx vitest run tests/integration/sync-runtime.test.ts -t "guarded text Pull"`
  — 2 passed, 78 skipped.
- Actual all-images-cancelled behavioral RED: after the rendered upgrade
  conflict was changed to a text-only result and the enabled
  `确认升级并同步` button was clicked, the old entry left the user in the same
  Modal (`expected 3` open instances, received `2`) because main called
  `finalizePreview` directly and surfaced the text-required condition as an
  error. GREEN: main now presents `Sync v2 文字合并`, performs no write or
  non-GET request before its separate `确认文字合并`, applies a cloned (mutable)
  Pull candidate under strict Entry revalidation and frozen pre-state evidence,
  then opens the existing `Sync v2 推送预览`. The existing Push confirmation
  publishes the exact chosen text through one v2 finalize and leaves the
  unreferenced image bytes in the Vault. Command:
  `npx vitest run tests/integration/local-image-upgrade-entry.test.ts -t "all-images-cancelled upgrade"`
  — 1 passed, 32 skipped. The intermediate assertion that expected Obsidian's
  binary write adapter to retain Markdown in the test harness's text-only Map
  was a fixture-observation gap, not a product RED; the final assertion reads
  bytes through the adapter boundary.
- Latest focused checkpoint: `npm run typecheck` exited 0, followed by the two
  guarded Pull tests and the actual all-images-cancelled plugin test above, all
  green.
- Actual compatibility matrix: factory construction with a local managed image
  rejects both old v1 and old v2 before head/snapshot/delta; an old v2 remote
  Markdown managed-image candidate is rejected by the real factory Runtime with
  GET-only traffic and zero Vault business writes; a public `legacy_v2` Space
  without local images constructs the strict v2 adapter; a `native_v3` Space
  with zero attachments constructs the strict v3 adapter without a v2/head/delta
  request; after the confirmed upgrade commits a v3 baseline, a still-legacy
  public mode rejects with `SPACE_PROTOCOL_INCONSISTENT` before head/delta.
- Final focused regression command:
  `npx vitest run tests/integration/local-image-upgrade-entry.test.ts tests/integration/plugin-settings-lifecycle.test.ts tests/integration/preview-modal-interactions.test.ts tests/integration/sync-runtime.test.ts tests/integration/local-image-upgrade-plan.test.ts tests/integration/local-image-upgrade-push.test.ts tests/integration/local-image-upgrade-local.test.ts tests/unit/protocol-negotiator.test.ts tests/unit/tree-scan.test.ts tests/unit/user-errors.test.ts`
  — 10 files passed, 284 tests passed.
- Final static checks: `npm run check:format && npm run lint && npm run typecheck && git diff --check`
  exited 0. Prettier matched all files, ESLint reported 0 errors and 17 existing
  warnings, TypeScript exited 0, and the diff check was clean.

## Files currently changed

- `src/application/local-image-upgrade.ts`
- `src/application/local-image-upgrade-plan.ts`
- `src/application/protocol-negotiator.ts`
- `src/application/space-sync-route.ts`
- `src/application/sync-runtime.ts`
- `src/core/initial-binding.ts`
- `src/core/tree-scan.ts`
- `src/core/user-errors.ts`
- `src/main.ts`
- `src/obsidian/preview-logic.ts`
- `src/obsidian/preview-modal.ts`
- `src/obsidian/sync-center-modal.ts`
- `src/ports/tree-remote.ts`
- `src/storage/local-image-upgrade-confirmation.ts`
- `tests/fakes/obsidian-mock.ts`
- `tests/fakes/plugin-harness.ts`
- `tests/integration/local-image-upgrade-entry.test.ts`
- `tests/integration/local-image-upgrade-plan.test.ts`
- `tests/integration/plugin-settings-lifecycle.test.ts`
- `tests/integration/preview-modal-interactions.test.ts`
- `tests/integration/sync-runtime.test.ts`
- `tests/unit/protocol-negotiator.test.ts`
- `tests/unit/tree-scan.test.ts`
- `tests/unit/user-errors.test.ts`

## Current self-review / concerns

- The new materialization guard is deliberately storage-scoped; placing it in
  the U4 coordinator's generic evidence helper broke older deliberately minimal
  coordinator fixtures and would couple U4's hash-only contract to persisted
  calculation shape. Storage calls both shared hash validation and the new narrow
  materialization validation.
- The no-B helper does not use R as B and does not add remote-only objects to L.
  It changes only explicitly selected identities; body choice remains in existing
  merge resolution maps, while original L is retained as evidence.
- The factory now distinguishes native/bootstrap/legacy/upgrade/recovery before
  any status/head read. It preserves fresh public mode and permission, binds the
  runtime cache to route, mapping identity, v2 and v3 capability hashes, and
  does not use test callbacks as a production state owner.
- Full image publication/application, late local-pending error text, restart
  recovery, and the all-images-cancelled v2 Pull→Push fallback now have actual
  entry/UI evidence. The text branch preserves the deeply frozen authorization
  preview and passes a structured clone into the legacy Runtime; the guard
  freezes its own expected-state copy across async revalidation, rechecks before
  baseline preparation, and passes those same states to `TreeTransaction`.
- No production server, external Vault, or device was written. Android/real
  Obsidian acceptance remains a separate U7 gate; this U6 report proves only the
  controlled synthetic HTTP/Vault assembly plus focused source verification.
- ESLint's 17 warnings are existing repository-level warnings (settings API,
  sentence case, test-only Node imports, deprecated conformance helper, and test
  globals); this task leaves lint at zero errors and does not expand into those
  unrelated owners.
- The application entry currently has three orchestration responsibilities:
  authoritative fresh reads and typed draft lifecycle; delegation to the
  existing U3 merge/recompute/finalize implementation; and construction of the
  existing U4 coordinator, U5 local apply, and strict storage ports. It does not
  copy U3 merge computation, the U4 transaction state machine, or JSON schema
  validation. At this checkpoint there is no coherent narrow shared helper to
  extract merely to reduce its line count; path-key normalization, Vault root
  validation, scan-limit selection, viewer preview, and v2-capability evidence
  still need to be tightened before main/modal wiring.

## Fix round 1/5 — review I1–I4

Base: `b9d7b85d121007efd192289a3a1378791c3ab40c`.

### Behavioral RED / GREEN

- I1 fail-closed disconnect RED:
  `npm test -- --run tests/integration/local-image-upgrade-entry.test.ts -t "fails disconnect closed"`
  exited 1 with 3/3 cases failing because `disconnect()` resolved for malformed,
  newer-envelope, and ownership-inconsistent upgrade journals. GREEN:
  `npm test -- --run tests/integration/local-image-upgrade-entry.test.ts -t "fails disconnect closed|blocks mapping removal"`
  passed 4/4. Disconnect now strictly inspects both connection-state and local
  device-state owned roots before entering the deliberately broad offline runtime
  catch. The malformed case also makes those device IDs disagree. Each negative
  verifies credential, mapping, server binding, journal bytes, and local control
  state are preserved.
- I3 cache-entry invalidation RED: after opening the actual upgrade Modal, a
  second factory `runtime()` cache hit followed by Vault `modify` left the current
  confirmation enabled (`expected true`, received `false`). GREEN: the cache hit
  retains its already-bound live `LocalImageUpgradeEntry`; the same actual-entry
  test passed 1/1 and observes the current button disabled plus `预览已失效`.
- I2 stale-summary behavioral RED: after actual conflict resolution, the rendered
  Folder summary did not contain the selected `pages/B/Child`, and the actual
  all-images-cancelled flow still rendered the pre-decision summary instead of
  the final zero-image/local-plan surface. An intermediate `items.slice is not a
  function` was only the new callback-interface adaptation RED, not behavioral
  evidence. GREEN: `PreviewModal` accepts a static list or a dynamic summary
  projection and refreshes only that paginated subtree after an async calculation
  result installs. Page, Folder, resolved attachment count/name/bytes and local
  action assertions passed immediately before confirmation; the actual text-only
  fallback shows zero images and no stale attachment name. The existing rapid
  async and pagination interactions remain stable.
- I4 replaced the obsolete exact-source predicate assertion with rendered tests:
  one pending binding shows `1 项待处理` and disables confirmation; a separate
  `canConfirm === false` case shows the invalidation reason and disables the same
  actual control. Production still requires both no pending decisions and current
  authority.
- During combined regression, the existing one-click completion assertion exposed
  that the button was re-enabled in the Modal `finally` after successful close.
  The Modal now refreshes action state after failure only; a successful completed
  transition remains disabled. Error/abort retry behavior is unchanged.

### Covering verification

- `npm test -- --run tests/integration/local-image-upgrade-entry.test.ts tests/integration/plugin-settings-lifecycle.test.ts tests/integration/preview-modal-interactions.test.ts tests/unit/preview-modal-layout.test.ts tests/unit/preview-logic.test.ts`
  exited 0: 5 files, 94 tests passed.
- `npm run check:format && npm run lint && npm run typecheck && git diff --check`
  exited 0 after formatting the touched files: Prettier clean, ESLint 0 errors
  and the same 17 repository warnings, TypeScript clean, diff clean. Before that,
  `npm run typecheck && npm run format:check && npm run lint` exited 1 only because
  this repository has no `format:check` script; the correct script is
  `check:format` and is green above.

### Fix files and self-review

- Production: `src/main.ts`, `src/obsidian/preview-modal.ts`.
- Tests/harness: `tests/fakes/plugin-harness.ts`,
  `tests/integration/local-image-upgrade-entry.test.ts`,
  `tests/integration/preview-modal-interactions.test.ts`,
  `tests/unit/preview-modal-layout.test.ts`.
- The disconnect preflight reuses the same extracted control-root calculation as
  the runtime factory and the existing strict storage inspector; it does not copy
  journal schema or hash validation. Cache reuse preserves a single live Entry
  instead of adding another state owner. Dynamic lines remain backwards compatible
  with every existing static PreviewModal caller and refresh only their summary
  subtree, preserving conflict controls and page state.
- Deferred M1 (the large application entry) was not refactored. No packages,
  server, device, external Vault, or AgentWiki main-project state were changed.
