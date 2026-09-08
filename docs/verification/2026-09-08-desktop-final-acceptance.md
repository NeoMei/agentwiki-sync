# Desktop final-candidate continuation

2026-09-08. User explicitly authorized desktop Obsidian restart and continuation; later confirmed the exact Chinese-space-path test upload preview.

## Candidate and isolation

- Product commit `15ad6e2dbb9c21cc34a1f85ad2d3796e2fbcba8e`; documentation HEAD before this turn `26e9613`.
- Only acceptance Vault `/Users/neomei/Obsidian/AgentWiki-Sync-V3-Acceptance-20260905` plugin assets updated; old three assets backed up in `/tmp/agentwiki-desktop-final-Fl7yhl/`. No data.json or credential copied.
- main.js 1713839 B / SHA256 `277116a922367f65c34ec4bc235308876c8003e1d4da5918250c890b410b3c27`; manifest `7b001849eafc37311a720c56d62f37704b1697ea75a4a5b801423d4be443daee`; styles `5dfe15839220724a57a64ad7ab136761ba2ffaaff3c0235faac1cf1238e762b8`. All installed hashes match Android-reviewed candidate.
- Graceful quit succeeded; original PID 20110 exited. CLI socket returned after restart. Real CLI/renderer confirms exact acceptance Vault, enabled plugin 0.4.0, protocol 3, four original mappings, no modal. Restored tooling alone is not sync proof.
- Target is only `U7Desktop70bf4ae`, Space `cmtpqlvr600mvkdokt7eldkcg`; other three mappings preserved.

## Real missing-image Pull: PASS

Original image `assets/first-local.png`: 16429 B, hash `9ae7a9de2d0b6797843d236dfafea8c6f0dbfc408dcd34e1e16bc8a96a016b71`. Independent backup retained. Used actual Obsidian trash and actual plugin `runSyncStrategy(server)`; missing file produced only one-image restore preview, fixed revision download 200/16429 B, no business file before confirmation.

After exact preview confirmation, plugin restored exact bytes; note and other mappings unchanged. Remote remained `cmtprcxok00ozkdok6s6du7qp`, sequence 3, attachment `98ddf24d-3d6b-4d03-b824-7a34b0889789`. All requests GET. Repeated Pull no modal/no content download and notice “服务器没有新的变更可应用。” Actual reading view image 480×270.

`assert-pull.mjs` passed all byte/revision/request/installed-bundle assertions. Evidence in backup directory: `preflight.json`, `pull-preview.json/png`, `pull-result.json`, `noop.json`, `pull-render.png`. No manual image restoration used to produce PASS; recoverable trash and backup retained.

## Native rename + Chinese/space/subdirectory Push: PASS

Used actual Obsidian fileManager rename, not a manual Markdown replacement:

- `assets/first-local.png` → `assets/桌面 图片 0908.png`.
- Page moved under newly created `pages/子目录 验收/First Image Baseline.md`.
- Native Obsidian showed “更新链接” affecting 1 file/1 link; selected “仅此一次”, not global setting change. Native result used short `桌面%20图片%200908.png` link.
- Actual plugin Push preview identified 1 local link normalization, 1 folder, 1 image update, 1 Page. Unreferenced `unreferenced.webp` not read, other mappings unchanged, preview HTTP all GET.
- User explicitly confirmed that exact preview. Click at `2026-09-08T10:48:52.092Z`.
- Session `a616e00a-999c-460f-917f-f1850ad50e1b`: create201, batch200, finalize200. Sequence3→4 exactly once, revision `cmtsjr85a00eq1368b4zhxl3f`.
- All binaryBytes=0, no Blob upload requests; unchanged bytes preserve attachment ID `98ddf24d-3d6b-4d03-b824-7a34b0889789`.
- Actual local and fixed remote Page body now references `../../assets/%E6%A1%8C%E9%9D%A2%20%E5%9B%BE%E7%89%87%200908.png`; parent journal complete/verifiedTarget matches published revision.
- Second full local-preference sync: no-op, only GET, notice “本地没有待推送的变更。”
- Actual desktop reading view and public web page `/pages/5cd9bf78-5ad2-41fa-a941-9e260b330b31` both load 480×270 image. Browser navigation visibly showed Chinese subdirectory; public change time 2026/9/8 18:48:53 matches publication.

`assert-rename.mjs` PASS: native rename, special paths, zero Blob upload, identity preservation, repeat. Evidence: `rename-preview.json/png`, `rename-result.json`, `rename-noop.json`, `rename-render.png`.

## Reload and complete process restart: PASS

Plugin reload succeeded, actual reloaded runtime full local sync no-op, exact image hash unchanged, four mappings retained, 480×270 rendered. Then full desktop app restart; final PID11025, socket working, installed hashes unchanged, actual local sync still no-op/onlyGET, remote sequence4, image unchanged/rendered. Evidence `plugin-reloaded.json` and `app-restarted.json`. This round did not claim an offline test.

## Public recovery readiness and remaining boundaries

Actual v3 list reports all ten existing owner synthetic Spaces as native_v3; cannot reuse them as legacy fixtures. Old provider `/tmp/agentwiki-local-upgrade-live.9mr3ZL/provider.mjs` lacks required recoveryCases and serverOrigin; original `__agentwikiImageQA.req` human-authenticated closure is absent after restart. Plugin's legitimate device-authenticated GET `/api/spaces` returns401 while public sync endpoints work. No credential read or workaround attempted.

Current browser is logged in as Admin; target membership shows distinct Synthetic desktop image acceptance account. Do not silently replace plugin authentication or use the Admin account to falsify original-owner fixture evidence. Need separately scoped fixture/auth preparation for four fresh legacy Spaces and six public tests. No four fixtures created or public six-case run this turn; NOT_RUN, not a product sync failure.

Remaining Task7 includes public six-case response-loss gate, broader conflict/offline/fresh-first-image matrix, then GitHub0.4.0 release and actual release asset checks. No source fix, server redeploy, npm publish, tag or Release in this turn. Existing release workflow/CHANGELOG and user untracked evidence preserved.
