# Desktop final-candidate continuation

Latest status: public six-case gate PASS 6/6; fresh final-bundle native first-image, whole-machine offline restart and detach/re-reference gates also PASS; see [final native gates](2026-09-08-final-native-release-gates.md). Earlier NOT_RUN statements are historical. GitHub publication and official asset verification are separate release-stage gates.

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

## Additional final-bundle UI and transport checks

Mounted the installed production `PreviewModal` through `openPreparedV3Pull` with 101 explicitly synthetic Page-conflict records and a non-writing runtime. Desktop (1136 CSS pixels) and Android (360 CSS pixels) both show 100 conflicts on page 1, the final conflict on page 2, and return to page 1 correctly. Confirmation stays disabled with unresolved conflicts; no horizontal content overflow. Cancel releases the flow, performs no apply, and preserves all mappings. This is real mounted UI component acceptance, not a real remote conflict/merge transaction.

Evidence: `/tmp/agentwiki-public-recovery.pgeSQl/desktop-pagination-ui.json`, `android-pagination-ui.json`, `pagination-ui.js`. Initial helper attempts failed because the synthetic preview omitted `local.normalizations`, then because close-animation completion was checked too early. The owned modal was closed and helper corrected; no product code or data changed. Successful final assertions include the completed cancel/release state.

Desktop controlled transport outage also passed: the actual installed plugin `runSyncStrategy(..., 'server')` encountered a deliberately failing HttpPort, propagated the error, issued only three GET head attempts and never created a preview. Restored the exact transport/runtime hooks in `finally`; real public head then succeeded with sequence 4 / revision `cmtsjr85a00eq1368b4zhxl3f`. Note, image bytes and four mappings were unchanged. Evidence: `desktop-offline.js/json` in the same directory. This proves plugin entry behavior under a transport outage; it is not a whole-machine network disconnect or offline desktop process restart.

## Public gate closure at 21:44

The original public six-case verifier now passed **6/6** against four fresh synthetic legacy Spaces, with actual native Vault/control adapters and public device-authenticated requests. Both successful-response-loss cases retained one operation/session, advanced sequence only once and completed the local baseline. See [public recovery evidence](2026-09-08-public-recovery-setup.md) for exact candidate/log hashes, prior failed attempts, final revisions and credential cleanup. This supersedes the public NOT_RUN/FAIL status above, not the distinct native matrix.

Native desktop read-only recheck still reports the authorized acceptance Vault, plugin 0.4.0 and four mappings. No authentication or mappings were replaced to bypass the original-owner boundary. Fresh final-bundle native first-image acceptance and whole-machine offline restart remain separate gaps; existing controlled-transport and restart evidence must not be relabeled as those cases.
