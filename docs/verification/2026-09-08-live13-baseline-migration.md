# Live-13 baseline migration attempt — 2026-09-08

Status: **Native-v3 live-13 baseline committed; historical/live payload preservation verified.** Earlier v2 attempt and rollback retained below.

The user approved using the current 13 live Pages in 我的知识库 (`cmsx1v26g01kc3gmnw9ozat8a`) as the new sync baseline, retaining immutable historical snapshots without restoring old Page contents. This authorizes the bounded baseline migration, not restoring archived attachments or changing Page bodies.

## Preparation and attempted apply

- Existing migration implementation was inspected, and local/production script SHA256 matched: `fa7fad938b14cb8c3871130bd077177a49677be34a29090836f1b5624b167b67`.
- Fresh `node --test scripts/space-folder-migration.test.mjs`: **21 PASS, 0 FAIL, 0 skipped**.
- Exact-Space dry-run returned ready; input hash `61722bc486d02f2f8fe5b6ba83c93e1a0098dbe7a89350325daa62e9def44f51`. Counts: 13 active Pages, 75 already-deleted Pages skipped; 0 folder creations, Page moves, alias changes/pruning, or PageVersion backfills. All 13 current paths remain unchanged.
- Verified actual production database identity and made a private server-side PostgreSQL custom-format backup before apply. Size 7,157,226 bytes, SHA256 `3d78d47061dde7aa3756d3f5a51e4718685f9e77c49a67c53e4f08c67c6a44b5`; catalog inspection and complete payload decoding passed. This is not a restore drill. Backup location/credentials/business bodies are not copied into this repository.
- The existing migration was invoked with the exact reviewed input hash. It rejected with `MIGRATION_EXECUTION_FAILED`, whose cause was `ATTACHMENT_MISSING` from `SyncV3RevisionWriterService.advanceCurrentIfRequiredLocked`. A second, explicitly rollback-only probe recovered this nested error without committing changes.

## Root cause and boundary

Current Page `cmsy0opqr02vz3gmn6qhpztf3` (`pages/总结总结的总结.md`) contains four managed references to `assets/unnamed.png`. Matching attachment `cmtgtfiu303fd13nddq7mvlil` is **archived**, timestamp `2026-08-31T06:00:15.828Z`, so the active attachment resolver rejects it.

Its existing stored image is recoverable at the byte level: 114,018 bytes, 1403×1166, SHA256 `2ee61dd95b19f77dd081d0753b8b68a272dc88d215b16795f532f5679636a1b4`; server-local existence, size and hash checks all passed. No image bytes or Page bodies were output/downloaded by the diagnostic. No archived status was changed.

The first-v2 migration also explicitly rejects native-v3 bootstrap, as covered by its existing writer test. Restoring the attachment alone is therefore **not** proof that the current migration path will succeed: the image-aware migration route still needs validation. Do not bypass v3 checks, substitute a legacy-only runtime, silently remove image references, or mark acceptance complete.

## Rollback evidence

Independent read-only comparison after both failed attempts verified:

- Head remains `cmth1ae1x04vr13ndnzm3yq06`, sequence 66; content tree revision remains 26.
- 13 active and 75 deleted Page records, with complete Page-record hash unchanged: `a705899bb1638d303d2e136cd5aea66b4e81e33043b6e1e917808f9c3b838314`.
- All PageVersion records unchanged.
- All 66 historical revision records unchanged; all 4,280 historical Page snapshot rows unchanged.
- Historical sidecars, folders and path aliases unchanged.

No new baseline, production deployment, release, credential issuance, or recovery test success occurred in this attempt. Next user choice is narrowly whether to restore this exact archived image; the already approved 13-Page baseline choice does not need to be repeated.

## Authorized image restore and successful native-v3 cutover

The user subsequently explicitly allowed restoring `unnamed.png`. Used the authenticated web editor's 图片附件 → 已归档 → 恢复 unnamed.png control, without editing/saving Page text. The restored attachment is active. The rendered article now displays all four occurrences at natural dimensions 1403×1166.

Read-only reinspection found no unresolved references. The 13 current Pages reference **two** existing attachments: restored `unnamed.png` (114,018 bytes) and already-active `image.png` (`cmtgtyfqs03mh13ndizx15zg0`, 142,431 bytes, SHA256 `2f8f4945a840c748875ef2d05c168c699756720b0af47d95214dfc16be1bcb84`). `image (2).png` remains outside the new sync manifest because no current Markdown references it. No additional attachment was uploaded or restored.

Instead of bypassing the first-v2 migration's native-v3 guard, used an isolated operator script invoking the **existing** `SyncV3RevisionWriterService.inspectCandidate` / `advanceV3Locked` and content-tree revision CAS. No product code, protocol, or deployment was changed. The script fixes the exact Space/head/tree, matches all current Page and historical payload hashes, requires exactly 13 Pages and the two exact attachment IDs/hashes/sizes, reads both stored streams to verify actual bytes, uses a Serializable transaction and the normal Space lock, and refuses application unless the reviewed preview hash matches.

- Independent script review: Critical 0, Important 0, Minor 2; approved subject to successful rollback-only trial and exact hash. Historical associated-content hashes were supplemented before/after; ambiguous post-commit receipt failure is handled by read-only inspection rather than retrying blindly.
- Reviewed script SHA256 `d1c4adbcc0efb9c1c2cca02137941bf44accaec212ee42619dd310cfff6fbacf`; syntax check passed.
- First two dry probes failed closed before writing because the initial expectation of one image was incorrect; retained their empty report reservations. Corrected to the proven two-image allowlist.
- Complete transactional dry-run passed all preservation assertions and rolled back; independent head read remained sequence 66.
- Fixed input hash: `c79f60848770fdc686b3fad7151d79a6664c7baf2bb8457ad824515cb72f7628`.
- Apply committed at `2026-09-08T13:06:04.130Z` (21:06:04 China time): revision **`cmtsonmqq00031es0rmgjuz6k`**, sequence **67**, tree revision **27**, schema `content-tree@3`, recipe `referenced-images-v1`, migration batch `live13-referenced-image-cutover-20260908`.
- New manifest: 13 Pages, 0 folders, 2 images, 256,449 image bytes, 16,808 body bytes, 21,725 manifest bytes; revision content hash `923ae424e37fa1021acdbd029265a38f34a7daeaf2632a544415d548f41c74f9`.
- Old head retains its original payload and is the new revision's parent; only its `supersededAt` changes to mark replacement.

Independent post-commit hashing verified unchanged: all 88 live/deleted Page records (13 active/75 already deleted), 42 PageVersions, 66 historical revision payloads, 4,280 old Page snapshot rows, 4,280 legacy Page extras, both sets of 91 historical content/body records, 63 sidecars, folders and two path aliases. No old Page was restored or deleted.

The real installed Admin device client now successfully lists **108** Spaces, including 我的知识库 as `native_v3`, current revision `cmtsonmqq00031es0rmgjuz6k`, pageCount 13. This resolves the previously reproduced account-wide Space-list 500. A new temporary credential was issued for the same isolated recovery Vault solely to resume the two existing synthetic recovery cases; it must be revoked after the run. Recovery/release results are tracked separately and are not implied by migration success.
