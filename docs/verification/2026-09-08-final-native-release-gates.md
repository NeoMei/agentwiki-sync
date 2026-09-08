# Final native release gates — 0.4.0

2026-09-08, 22:04–22:29 Asia/Shanghai. Result: the remaining native acceptance gates PASS. Publication and official GitHub asset installation remain separate release-stage gates at the time of this report.

## Frozen candidate and scope

Product commit `15ad6e2dbb9c21cc34a1f85ad2d3796e2fbcba8e`; documentation HEAD before this record `a5a5f4b4237c91352d550444fb1f5feb6a9fa9fc`. No product changes during these tests. Installed desktop and Android assets match the same 0.4.0 candidate:

- main.js: 1713839 B, SHA256 `277116a922367f65c34ec4bc235308876c8003e1d4da5918250c890b410b3c27`.
- manifest.json: `7b001849eafc37311a720c56d62f37704b1697ea75a4a5b801423d4be443daee`.
- styles.css: `5dfe15839220724a57a64ad7ab136761ba2ffaaff3c0235faac1cf1238e762b8`.

User authorized all bounded synthetic acceptance tests and app restarts. New synthetic Spaces were granted to the original respective device test identities; no device authentication was replaced. Desktop Vault `AgentWiki-Sync-V3-Acceptance-20260905`: new mapping `U7DesktopFinal277`, Space `cmtsqgn5801qc1368308qri6t`; four original mappings preserved. Android Vault `NeoMei-Docs`, device `da9b6817`: new mapping `U7AndroidFinal277`, Space `cmtsqgnlg01qf13688ya8k7h6`; two original mappings preserved. Only the new fixtures were edited.

Each Space started as legacy_v2, sequence 2, one plaintext Page, no attachment. Actual native initial Pull was confirmed before introducing a referenced synthetic PNG and an identical unreferenced PNG. Desktop image 16429 B / SHA256 `9ae7a9de2d0b6797843d236dfafea8c6f0dbfc408dcd34e1e16bc8a96a016b71`; Android 12997 B / `73ec9c4efc4245505911494867b3f59a6ace2995f25866440a8198383b5a9bc4`. Both 480×270.

## Native first-image v2 → v3 upgrade: PASS on both clients

Actual installed plugin `runSyncStrategy(local)` opened the real upgrade preview. Before confirmation there was no write request or unreferenced-image read. Confirmed the exact one-image/one-Page scope on desktop and 360 CSS-pixel Android UI.

- Desktop: sequence 2→3 once, revision `cmtsqqb5f01tu1368m0671dby`, session `ed5aded6-cced-481e-bf27-a0caaa99d6c3`, attachment `bf7e0f6e-383e-4f03-8bd1-4a8ede1ccb20`.
- Android: sequence 2→3 once, revision `cmtsqqd3901ub13687hvkhe94`, session `5b1abdf7-43c3-4c21-8eff-b968a09b010d`, attachment `150bc06e-c31f-4354-8df1-33b73162dc00`.

Both create201/batch200/finalize200; actual fixed-revision image downloads matched bytes and hashes. Existing server blobs were reused (zero binary upload), not a new-byte upload case. Baselines match heads; upgrade journals phase=complete with matching verified publication. Terminal journal evidence is in `desktop-repeat.json` and `android-repeat.json` (not the normalized-push `parent:null` field in first-image outputs). A second actual local sync performed only two GET head requests, no modal or writes. Both native reading views and public web Pages loaded the 480×270 images. Unreferenced files were not read and original mappings were unchanged.

## Real offline full-process restart: PASS on both clients

Desktop: disabled the actual en0 Wi-Fi after confirming no alternate active default route. An independent 45-second watchdog guaranteed restoration. Gracefully quit Obsidian PID11025, launched fresh PID41469 with the exact acceptance Vault. Public curl failed DNS while offline; actual plugin server-preference sync failed `net::ERR_INTERNET_DISCONNECTED` without a write preview. Local image rendered 480×270; note, image and mappings hashes unchanged. Finally restored Wi-Fi, terminated watchdog after restoration; real public head stayed sequence3, native local sync was GET-only no-op.

Android: actual Wi-Fi and mobile data both disabled (0); force-stop/relaunch PID20989→20821. Fresh WebView rendered the local image 480×270. Actual plugin sync failed `UnknownHostException` for agentwiki.quukk.com without a write preview. Note, image and mappings hashes unchanged. Finally both networks restored (1); actual head stayed sequence3 and local sync was GET-only no-op. Installed candidate hash rechecked after restart.

## Android native rename, Chinese/space/subdirectory: PASS

Used actual Obsidian `fileManager.renameFile`: image to `assets/安卓 图片 277.png`, Page under `pages/中文 子目录/`. Native link-update modal reported one file/one link; chose “仅此一次”, without changing the global preference. Obsidian produced short `安卓%20图片%20277.png`; the actual plugin preview identified one local normalization, one folder, one image and one Page. After confirmation, the body referenced `../../assets/%E5%AE%89%E5%8D%93%20%E5%9B%BE%E7%89%87%20277.png`.

Sequence3→4 once, revision `cmtsrj7mo01w71368hhhnohbd`; attachment ID and image hash unchanged. No Blob requests/binary upload; unreferenced image not read. Parent journal complete with verifiedTarget matching head; repeat sync two GETs/no writes. Other mappings unchanged.

## Desktop detach and re-reference: PASS

Removed only the synthetic Page image reference through Vault.modify. Actual preview explicitly said “取消引用（两端文件保留）”; zero PNG reads and 0 B upload. Confirmed: sequence3→4, revision `cmtsrjzui01wv1368c2446qtq`, attachmentCount0, original local image retained.

Restored the exact synthetic Page body and confirmed the actual one-image preview: sequence4→5, revision `cmtsrm7xt01xi1368glcazhlw`, original attachment ID `bf7e0f6e-383e-4f03-8bd1-4a8ede1ccb20` and hash retained. Zero Blob uploads; no unreferenced reads. Baseline matches head; repeat sync two GETs/no writes; other mappings unchanged.

## Evidence and cleanup

Credential-free evidence directory `/tmp/agentwiki-native-final-277.7NXHQ5/`. Selected SHA256:

| Evidence | SHA256 |
| --- | --- |
| desktop-first-image.json | `2a7bb33f29ad6b02c516e2a47b37ae3b88abdd95b3d6ee795c25ff3b13049ded` |
| android-first-image.json | `6175b89d51c0ff38c59bc5b311d0410201f19823a4c9f986c6e7523ffaade10e` |
| desktop-repeat.json | `2a56281c55dde68eecc1e7ddeb2cb81b5def01ccde11fe31a51d557be9550ec8` |
| android-repeat.json | `764a02446a34fe2473df1238ecac34dbb446510b9d1e76330a0b03d5961443fc` |
| desktop-offline.jsonl | `b64aa75eddfae2f150757bdbd708232861cd9601f6b24af908c69283dc679d83` |
| android-offline.jsonl | `c12469a50cdd2e4e82ad1d4c2ea4b7d5d0b98c3d5b7ca5e6010128fea43658f9` |
| android-rename.json | `4ef2bd5a7997ab3b56ede27d35e4f5715e994a48ecb7d6c5e8deae1642b53fed` |
| desktop-detach-rereference.json | `3b8b3ac993d4469a6fab69d8c75eb66033c503a89e5d934f58bec299806e2268` |

All temporary runtime/transport hooks restored and globals removed; networks restored. Synthetic fixtures and rollback evidence retained. No business mappings, credentials, server source or deployment changed in this round.

Failed operator attempts retained: missing new mapping root was resolved by creating only that empty fixture root; an initial helper failed to invoke the returned modal transition and produced no synchronization, then was corrected after restoring hooks/reloading the plugin. A lost Android WebSocket forward was rediscovered without treating it as a product failure. None of these attempts count as PASS; the final native outputs above do.

## Related gates

- [Final desktop acceptance](2026-09-08-desktop-final-acceptance.md): same-revision missing-image Pull, desktop special paths, reload and public closure.
- [Final device chronology](2026-09-08-final-device-preflight.md): Android missing-image defect, code fix, independent re-review, final-candidate real Pull.
- [Public recovery](2026-09-08-public-recovery-setup.md): original public six-case verifier 6/6 PASS, including response-loss recovery, and credential cleanup.
- Independent final release audit found no outstanding product C/I/M findings; the two native coverage gaps identified there are closed by Android rename and desktop detach/re-reference above. Release wording/tracking checks are performed separately before tagging.
