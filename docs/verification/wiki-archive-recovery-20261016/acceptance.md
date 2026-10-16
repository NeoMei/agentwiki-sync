# Wiki archive and recovery acceptance

## Confirmed original issue

Original native Vault: NeoMei-Docs, Wiki mapping, Sync v2. Before repair, the mapped local directory contained no files. The durable push held one archive_folder and ten archive_page operations; eight page operations were descendants of the archived folder. Server recursively owns the descendants and rejects duplicate archives. The recovery screen hid persisted operations behind an empty local-diff placeholder and repeatedly resumed the same confirmation.

Root live readback before repair (2026-10-16 11:41 Asia/Shanghai): server snapshot remains one folder, ten pages, sequence 10; old session expired with no published result. No finalize was invoked during diagnosis. Original plugin/state/Wiki backup and a hash inventory for the other mapping were captured outside the repository.

## Checks

- Baseline: 70 files / 1441 tests passed before implementation.
- Final candidate: `398ad89279abf921f089ff37fa3c8c6031fbeb6a`; production changes end at `258af10e14f59e4397b2b75069e63bb8894d159f`.
- Root `npm run check`: exit 0, 71 test files / 1469 tests passed. Format, typecheck, build, bundle safety and release metadata checks passed. Lint: 0 errors / 19 existing warnings.
- Independent task re-review and whole-branch review approved; no blocking findings. Review covered the server's abort/finalize row-lock fence, credential ambiguity, journal durability, recursive archive semantics and UI integration.
- Native Obsidian loaded the candidate bundle: 1,763,964 bytes, SHA-256 `fc3bf654521727688c9b86b1defdd0fe258dc1755ba5cd30768136caaa85252d`. The existing plugin version remains 0.5.9; this is an unreleased local repair build, not a new public release.

## Original-environment recovery

Root performed the following in the original NeoMei-Docs Vault after backups and review:

1. The new recovery screen displayed the actual persisted 11 operations: archive one folder and ten pages, with the recursive-directory warning.
2. Used **取消此任务并重新预览**. The plugin verified terminal remote status through its cancellation fence and retired the old task. No manual journal editing or changed-confirmation submission was used.
3. Selected **使用服务器内容**. Inspected the preview containing one folder and ten page creations, then confirmed local restoration.
4. Reopened the sync modal: **本地与服务器已同步，无需操作。** Local and server sections both showed no changes; the recovery button was gone.
5. Read the live server head and old session again. `hasUnfinishedPush()` was false. The old remote session remained expired with no published result.

At 2026-10-16 12:11 Asia/Shanghai, the independent filesystem/control-envelope verification passed every assertion:

- Wiki mapping is active; restored baseline contains one logical folder and ten pages, and every local page hash matches the server-derived manifest.
- Original push journal is terminal `superseded`; its session ID, confirmation hash, idempotency key and changes remain identical to the backed-up task.
- Pull and baseline journals are committed, and the baseline revision matches the live server head.
- Server revision, sequence 10, content hash, folder/page counts and body byte count are unchanged from before recovery.
- All 94 pre-existing files in the Project Management mapping have unchanged hashes.

Private backups, before/after readbacks, verification script, JSON receipt, build receipt and engineering review/check logs are retained under `~/.codex/repair-backups/wiki-archive-recovery-20261016/`. Native AX readback and screenshot are also recorded in the originating repair conversation. Private Vault contents and control journals are not committed here.

## Accepted limitation

The planner rejects a candidate combining a folder archive with new or unproven page/folder identities. An offline move can look like deletion plus unrelated creation; accepting it could lose the original identity and history. Consequently, even legitimate independent additions and directory archives require separate sync previews. This repair does not implement general directory identity tracking.

## Boundaries

No server source, deployment, authorization, or credential changes. No public plugin release is included in this repair. Private original Vault contents and control files remain outside this repository.
