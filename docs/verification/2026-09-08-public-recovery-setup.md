# Public recovery acceptance setup — 2026-09-08

Status: **Original public six-case verifier: 6 PASS / 0 FAIL on the final candidate.** Run at 21:42:19 China time, after the authorized live-13 migration and replacement of the unreliable CLI-per-request test transport. Temporary credential revoked; helper, bridge and private socket closed. Earlier failures are retained below. Native-device/release gates are separate.

Sections are chronological evidence, including then-current failure and credential states. For the latest outcome and cleanup, use the final continuation section; historical “active”, “3 of 6” and “unresolved” statements are not current status.

The user approved four new synthetic-only Spaces and an independent acceptance session limited to those Spaces, preserving existing plugin credentials and mappings.

Created through the authenticated Admin web UI:

| Case                   | Space name                   | Space ID                  |
| ---------------------- | ---------------------------- | ------------------------- |
| Populated              | U7 Public populated 0908     | cmtsk7vaj00ld13688rlzt7zs |
| Empty                  | U7 Public empty 0908         | cmtsk8evb00lg1368xdb2hx9l |
| Create response loss   | U7 Public create-loss 0908   | cmtsk8sma00lj1368dd6jx287 |
| Finalize response loss | U7 Public finalize-loss 0908 | cmtsk958h00lm1368he6yin1p |

Only Space names and synthetic-test descriptions were submitted. No Pages, folders, images, plugin connection codes, device credentials, or new Vaults were created during setup. Existing Spaces, credentials, mappings, and real documents were not modified. Preserve these four Spaces for continuation; do not create replacements blindly.

## Authorization boundary discovered

The live `/guide/obsidian` screen offers `生成连接码`, with no Space selector. Local server contract inspection agrees: `CreateObsidianInstallationRequest` has only plugin/protocol fields; `ObsidianIntegrationService.createInstallation` binds the installation to `userId`; credential exchange binds user/device/Vault, without Space scope. `HumanDeviceGuard` derives the account principal, including its platform role. Thus a new Admin device credential cannot honestly be described as server-enforced four-Space-only authorization.

Stopped before generating a connection code. A four-Space allowlist in a test transport would constrain the test runner, not the underlying credential. Explicit approval of that distinction or a dedicated least-privilege test identity is required before proceeding. No auth implementation changes are implied.

After resolving auth, preserve the existing real six-case verifier contract, prepare real controlled Vault/control ports, present the synthetic upload preview for confirmation, and run the real public tests. Setup alone proves neither recovery nor release readiness.

## Subsequent authorization and live checks

The user subsequently explicitly allowed a temporary account-level device credential, with the test transport constrained to the four fixture Spaces and revocation after acceptance. This resolves the authorization distinction above; it does not authorize unrelated Space content reads or mutations.

- Created `AgentWiki-Public-Recovery-20260908` through the native Obsidian Vault manager at `/Users/neomei/Obsidian/AgentWiki-Public-Recovery-20260908`.
- Installed only the reviewed plugin assets: version 0.4.0; main.js SHA256 `277116a922367f65c34ec4bc235308876c8003e1d4da5918250c890b410b3c27`. No credentials/settings copied from another Vault. New Vault has zero mappings.
- Generated a one-time code via the logged-in Admin web UI, copied it through the UI directly into the new Vault connection form, and connected successfully. No code or token was printed or written into acceptance scripts. Reloaded the web page to remove the spent-code display.
- Web device list confirms `AgentWiki-Public-Recovery-20260908 active`, Vault prefix `7ca43db0`. Existing devices were not revoked. The temporary credential remains active pending acceptance or explicit termination; revocation remains required afterward.
- Native plugin UI reports connected, but Space-list loading fails. Actual installed client requests reproduce: v3 capabilities HTTP 200; v3 Space list HTTP 500 `INTERNAL_ERROR`; v2 Space list HTTP 409 `SYNC_PROTOCOL_UPGRADE_REQUIRED`.
- Individual v2 head requests for all four allowed Spaces return HTTP 200 with revision `0`, sequence `0`, zero folders/Pages/body/manifest bytes. Individual v3 heads return HTTP 410 `REVISION_GONE` (no v3 publication yet).
- Read-only production API logs corroborate repeated `/api/sync/v3/spaces` HTTP 500 at 19:08–19:09, reporting only the safely redacted error. API remains active; no server code/config/DB/deployment writes occurred.
- Source inspection shows listSpaces builds the entire account-visible list and inspects legacy candidates before returning. Which candidate or validation triggers this 500 is NOT yet proven. Do not fabricate a filtered list or change the real six-case verifier to bypass it.
- Credential-free, read-only diagnostic scripts retained at `/tmp/agentwiki-public-recovery.pgeSQl/`. The temporary native negotiation hook was restored in `finally`; a diagnostic closure only permits GET protocol capabilities/Space-list paths and only emits the four allowed Space entries.

No folder, Page, image, Push session, upgrade, mapping, or business-content upload was created in this continuation. Full recovery and release readiness remain unproven. Further investigation of pre-existing Spaces needs a scope decision: read-only sync metadata without Page bodies, or a separately authorized isolated test identity.

## Continuous acceptance continuation

The user subsequently authorized read-only legacy sync metadata inspection and continuous execution of all previously scoped synthetic tests. No production Page bodies were read for the diagnosis, and no production code, configuration, or existing business data was changed.

- Populated fixture seeded through the web with two synthetic plaintext Pages (`f2768d13-3423-4aa6-9d43-22e98c466174`, `337c9510-1c39-4321-80a8-5eee299a1788`) and one empty folder `保留目录 A`. Fresh v2 head: revision `cmtsl4y7t00r31368a5y28kb4`, sequence 5, 1 folder, 2 Pages, 152 body bytes, 929 manifest bytes.
- The empty/create-loss/finalize-loss fixtures still have exact v2 revision `0`, sequence 0, and all four size/count fields zero. These individual endpoints remain healthy despite account-wide list HTTP 500.
- Read-only metadata reproduction identified legacy Space `cmsx1v26g01kc3gmnw9ozat8a`, immutable head `cmth1ae1x04vr13ndnzm3yq06`: 75 Page rows and no folders; multiple nested paths have no parent Folder identity. Aggregate v3 validation rejects these with `Root Page path must be directly under pages/`. Current live metadata has 13 Pages, so selecting a new baseline is a data-authority decision, not a safe silent cleanup. Old immutable revisions remain untouched.
- Fresh full plugin check on documentation HEAD `c69d5c2` / product `15ad6e2`: 66 files, 1,313 tests PASS; format/type/build/bundle/release metadata PASS, 17 pre-existing lint warnings and no errors. Audit: 0 vulnerabilities. Main bundle remains SHA256 `277116a922367f65c34ec4bc235308876c8003e1d4da5918250c890b410b3c27`.
- Full-check log: `/tmp/agentwiki-public-recovery.pgeSQl/final-plugin-check.log`, SHA256 `570b5989f0d60ee9f68d99b60ccdbb4d6b92bf3dbe92ef1bcb6b626f65332a87`.
- Fresh GitHub latest Release remains `0.3.0`; public Local Sync npm latest is `0.9.1`. Neither is evidence that plugin 0.4.0 has been released.

The original six-case verifier remains unchanged. The failing list assertion must remain a failure; independent fixture tests may continue without treating that as a whole-suite PASS.

### Native provider readiness

Prepared a bounded helper plugin only in the new acceptance Vault. It is loaded through Obsidian's real plugin loader, uses production RequestUrlHttp/Vault/control adapters, and keeps full connection-envelope validation. Direct inline-CDP module loading failed because its CommonJS resolver cannot import `obsidian`; this was a test-loader issue, not a product sync failure. Guard/wire tests: 8/8 PASS. The normal `agentwiki-sync/main.js` remains exactly SHA256 `277116a9…` in both desktop test Vaults.

Fresh native bridge preflight (mutation gate disabled) verifies all four v2 heads and populated snapshot return 200; actual global v3 list still returns 500 `INTERNAL_ERROR`. Both local recovery roots were absent. Snapshot's stable sync Page IDs are `a01f1270-d67c-4bcd-973d-4c8fd31dd454` and `fd872a4c-a189-4e22-8f38-adc055564e47`, distinct from web database Page IDs above. The unchanged verifier preserves sorted first Page (`U7 image target`) and updates sorted second Page (`U7 unchanged baseline`); names are synthetic labels, not authority selectors.

Seeded only `U7-Public-Recovery/Create` and `U7-Public-Recovery/Finalize` via native Vault API after absence checks: each has one Markdown (69/75 bytes) referencing one 70-byte synthetic 1×1 PNG. This local preparation does not publish a remote revision. Evidence: `/tmp/agentwiki-public-recovery.pgeSQl/public-native-preflight.json`; helper sources/report under `provider-prep/` in the same directory. No unrelated Space or original mapping was altered.

### First actual six-case run — 3 PASS / 3 FAIL

After independent bounded harness review (spec compliant, quality Approved, no Critical/Important finding), ran the original verifier unchanged at 20:03:17 local time. `AGENTWIKI_UPGRADE_LIVE_CONTEXT_MODULE` pointed to the reviewed `provider-prep/live-provider.mjs`; Vitest exited 1 after all six cases, with no skips. Log `/tmp/agentwiki-public-recovery.pgeSQl/public-six-cases.log`, SHA256 `bca900d7f8e1f71d713dfe68bf5439eb4683637c4447cadf6a2a48d6751d2956`.

| Case                                       | Result                | Authority                                                                                                                                                                                                                |
| ------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Public legacy Space mode list              | FAIL                  | Real HTTP 500, expected 200                                                                                                                                                                                              |
| Strictly empty legacy metadata/snapshot    | PASS                  | Literal revision 0, all counts/bytes zero                                                                                                                                                                                |
| Populated cross-protocol image publication | PASS                  | sequence 5→6 exactly once; revision `cmtsmf0lb00ye1368ymnnp881`; fixed manifest/content hash `9f64be41ca1f3eba33683203c26555092e9aea8809bfbcbd9377d12845ae28fc`; unchanged Page/folder preserved; exact image downloaded |
| Empty first Page + image publication       | PASS                  | sequence 0→1; revision `cmtsmf1uf00yr1368x9hocrw3`; fixed hash `a5f96c1198cfd6baf6a8cf9ece6ad9ed234457aeb84eb20cd6950a45f8c55c90`; exact image downloaded                                                                |
| Create-success response loss               | FAIL before injection | `控制存储已损坏` during initial entry creation; no successful response was dropped                                                                                                                                       |
| Finalize-success response loss             | FAIL before injection | Same initial control-store error; no successful response was dropped                                                                                                                                                     |

Independent postflight confirms the first two Spaces are now native v3 (1 image each, 70 bytes), while both recovery Spaces remain literal v2 revision 0. Do not rerun the full suite against these two already-upgraded fixtures and call them legacy. Follow-up uses targeted unchanged recovery cases until the original failure is resolved; full repeat requires newly authorized legacy fixtures.

The initial control-store failure is under investigation as a provider CDP null-value decoding issue; it is not yet established as a plugin defect. Production code/bundle remains unchanged. The public list defect is independently proven and is not hidden by this tooling error.

### Targeted recovery rerun and final cleanup

The provider null-value decoding defect was confirmed and corrected without changing the product or original verifier. A subsequent missing Node `window` timer environment was supplied with real Node setTimeout/clearTimeout, not no-op timers. Ten bounded guard/null/timer tests PASS; independent runtime-fix review reports no Critical, Important, or Minor finding (`provider-prep/SDD/runtime-fix-review.md`).

At 20:09:57, the original two recovery cases were rerun with `-t 'recovers a genuinely'`: **2 FAIL, 4 not selected**. Both now stop on genuine HTTP 500 from `V3TreeRemote.spaces` → `LocalImageUpgradeEntry.freshInputs`, before any create/finalize response loss is injected. This is not recovery success. Final log `/tmp/agentwiki-public-recovery.pgeSQl/public-recovery-final.log`, SHA256 `1fdf27cde4dcdc156ecb40d73faa53ec2de88a287389ccc05c64549972129618`.

Read-only postflight verifies both recovery Spaces still have v2 revision 0 and all counts/bytes zero; the two published fixtures retain their recorded v3 revisions. The actual published Page `f2768d13-3423-4aa6-9d43-22e98c466174` was opened through the web UI: its synthetic PNG is complete and decodes to naturalWidth/naturalHeight 1×1.

The offending legacy Space is **我的知识库**. Selecting its 13 current live Pages versus its 75 historical-head Pages as a new baseline remains an explicit user data-authority decision. No Page bodies were read for that diagnosis, no migration ran, and all old history remains intact. The user was asked to choose the new baseline; generic testing authorization is not a choice between these divergent datasets.

Cleanup verified at approximately 20:16 local time:

- Closed the bridge mutation gate before cleanup. Browser confirmation handling did not reliably complete, so the native client used the documented current-credential revocation endpoint, guarded by exact credential ID `20f55b9d-c53d-42f2-98ac-da30851cf2a8`. The first cleanup script raised an exception after the revoke request, so its return value is not used as success evidence. An independent native retry received HTTP 401; a fresh web reload shows **AgentWiki-Public-Recovery-20260908 revoked**, with its revoke button disabled. The other four visible devices remain active.
- Ran the real plugin's local disconnect in the dedicated zero-mapping Vault. Independent cleanup output: server identity cleared, mappingCount 0, helperLoaded false, helperEnabled false, bridgePresent false, diagnosticClosurePresent false. This removes the temporary local connection secret through the production disconnect implementation.
- Preserved synthetic fixture Spaces, local test files, helper files (inert), and evidence for reproducibility. No real note, original mapping, or historical revision was deleted. No release/tag/push or production deployment was performed in this continuation.

Overall result remains **3 of 6 public cases passed**; the Space-list defect and both not-yet-exercised recovery scenarios remain unresolved. Together with the separately recorded native acceptance gaps, this prevents a claim that all tests, final acceptance, or plugin 0.4.0 release are complete.

## Final continuation: migration, preserved failures, and six-case PASS

The user approved the current 13 live Pages as the new baseline and subsequently approved restoration of the exact archived `unnamed.png`. The bounded migration, backup, rollback trial, historical-payload hashes and successful public-list recovery are recorded in [live-13 migration](2026-09-08-live13-baseline-migration.md). No Page body was edited and no historical snapshot was deleted. A new temporary credential for the same isolated zero-mapping Vault was issued through the native connection flow; no code/token was printed or embedded in provider files.

### Failed CLI attempts and real continuation, not retroactive PASS

- At 21:09:51, the original two recovery cases reached actual publication but failed during native CLI control-file reads (50-second timeout). The helper process ignored SIGTERM; only the exact read-only CLI child processes were terminated. Obsidian itself was not killed. Both old fixture heads were independently verified at sequence 1, with local baseline completion and no second publication. A separate continuation check passed at 21:18:28; this is not a replacement for the original fault-injection cases.
- A fresh four-Space `U7 Clean ... 0908` set was created through the web UI. Exact IDs: populated `cmtsp5h64018o1368rbu714ae`, empty `cmtsp5z3c018r13683g891gxz`, create `cmtsp6ag3018u1368bzu8jb20`, finalize `cmtsp6k1x018x136837gb0kvm`. The populated source had two synthetic Pages and one empty folder; other three started at literal v2 revision 0. Recovery roots were absent before native seeding.
- Original full verifier at 21:28:21: **4 PASS / 2 FAIL**, exit 1. Space-list, strict-empty and both publications passed; create/finalize recovery failed on real CLI timeouts. Log `public-six-clean-20260908.log`, SHA256 `a59e4efa9df9e35bf4617a835dd70cfd32d87ea085ca83fab996361d4789d793`.
- The clean create case stopped at `remote_pending` before a remote revision; native recovery later published revision `cmtspoi0o01dx1368u60k31gt`, sequence 1. Clean finalize had already published `cmtsphpww01cy1368e1nl21ed`, sequence 1; native recovery completed its `local_pending` baseline with no remote mutation. Both subsequent terminal/baseline checks passed; log `public-recovery-clean-resume.log`, SHA256 `7ed2c27e69cac890875b5da384c39a1b5e50cc293243eb8b1f08f1157b0d3a90`. Neither interrupted fixture was reused as a fresh legacy source.

All logs mentioned in this continuation are under `/tmp/agentwiki-public-recovery.pgeSQl/`; failed attempts remain available.

### Test transport diagnosis and bounded replacement

Read-only repeated calls reproduced an intermittent CLI failure on the same null-valued control read: CDP 999/1000 passed, one timed out; an initial native `eval` 1000/1000 passed with the same value hash, but a later eval batch also timed out. Therefore eval was **not** accepted as a stable fix. No product defect or payload-size cause was inferred from this evidence.

Only the isolated helper's controller transport changed to a Unix-domain socket. Parent directory has mode 0700 and current-user ownership, socket 0600, no TCP listener or arbitrary-eval endpoint. It invokes the same native production adapters through the existing four-Space/two-root guarded dispatch; 8 MiB frames and 50-second deadlines, one request per connection, no automatic retry, no synthesized HTTP success. Errors and in-flight ambiguity remain failures requiring independent reads. The regular product bundle is unchanged.

The IPC characterization test was first observed failing against the unimplemented helper, then passed. Independent review: C0/I0/M0; local tests 11/11, plus 1000 null round trips, binary/Unicode framing, limit/error rejection and socket cleanup. Actual installed helper: 1000 native control reads passed, exact 69-byte Markdown and full 70-byte PNG comparison passed, unauthorized Space and disabled mutation gate rejected. This is a temporary acceptance helper, not a production plugin dependency or shipped asset.

### Fresh final run — original 6/6, no skips

The final four synthetic Spaces were created through the authenticated web UI; transport allowlist, runtime metadata and local roots were retargeted together. Before seeding/writes, the populated Space was legacy sequence 5 with one empty folder `保留目录 C` and two synthetic plaintext Pages; other three were strict revision 0. Unrelated mappings remained untouched. Only one referenced 70-byte PNG and one Markdown per recovery root were seeded.

| Case                           | Space                       | Result / published revision                                    |
| ------------------------------ | --------------------------- | -------------------------------------------------------------- |
| Legacy mode list               | selected populated + empty  | PASS; genuine HTTP 200 and exact legacy bindings before writes |
| Strict empty evidence          | `cmtspp0wn01e81368muitht64` | PASS; literal revision 0, all count/byte fields zero           |
| Populated atomic upgrade       | `cmtspp0gc01e51368s7gp5ma4` | PASS; sequence 5→6; `cmtspydcb01gm1368gt4hzn2n`                |
| Empty first Page + image       | `cmtspp0wn01e81368muitht64` | PASS; sequence 0→1; `cmtspyen801gz13687rn87hwv`                |
| Create-success response loss   | `cmtsppc0601eh1368nc7cw7iu` | PASS; sequence 0→1; `cmtspyxoa01i11368oi0246lj`                |
| Finalize-success response loss | `cmtsppcgb01ek1368htnzl32y` | PASS; sequence 0→1; `cmtspzqug01jd1368rkx028om`                |

Exact invocation from frozen worktree HEAD `c69d5c2843b647b16485e85762237fe01407244c` (product `15ad6e2`):

```text
AGENTWIKI_UPGRADE_LIVE_CONTEXT_MODULE=/tmp/agentwiki-public-recovery.pgeSQl/provider-eval/live-provider.mjs npx vitest run --config vitest.live.config.ts
```

Started 21:42:19, duration 92.27 seconds, exit 0, **6 passed / 0 failed / 0 skipped**. Log `public-six-ipc-20260908.log`, SHA256 `7ac47bf6ae92fa53caff57ca53954e2fa40c84efad3a30864ea336ab8460114f`. The historical directory name `provider-eval` is retained, but this final run uses the reviewed private IPC transport, not per-request CLI eval.

The verifier files have no Git diff: `local-image-upgrade.live.ts` SHA256 `7b61de6b028561158305ea88c8f671f2fbb5977e30953b025b839aacec9ee3f4`; recovery verifier SHA256 `55fad7540c9779eb6e51822567f74985fe34a6856da2d90c6de457cc92d85bd0`. Installed normal plugin `main.js` remains `277116a922367f65c34ec4bc235308876c8003e1d4da5918250c890b410b3c27`.

- Populated candidate/fixed hash `098213afd6c00f183db74a8bca9b12008ebb28d234d3de66037baec716e057d5`; empty hash `e381049d9448f6e936ffd8885df19d1433ae17bd2e13e88e1574c34dd63a32a3`. Exact full tree, unchanged Page/folder, image metadata and downloaded bytes passed unchanged assertions.
- Create: operation/idempotency key `3403e42e-399b-4469-8b8a-6cfa3c735e52`; two successful create calls return the same session `19aec7b6-e1e4-4363-9084-545d1e42b8ca`, one finalize, only one published revision. Terminal `complete`, verified publication and baseline all agree.
- Finalize: operation `c0c1ff46-3ac3-40f9-a6da-28abf5df5345`, session `7102122d-bb2a-47f5-bb4e-c7537ea20921`; one create and one finalize, same terminal/baseline agreement and sequence +1. Both restart checks use the production entry over the actual native Vault/control ports.
- Independent public postflight: all four v3 heads HTTP 200 with the same revisions/sequences and exactly one 70-byte attachment each. Browser Page `e45ac8d8-4084-4c39-992b-dd96ae5342f0` displays the published synthetic image, complete with natural size 1×1.

### Final cleanup

Closed the mutation gate, then revoked only temporary credential `a1416684-598d-413f-8ae8-29452020c93a` through the native client's current-credential endpoint. The revoke response triggered an empty-JSON parse error in the diagnostic wrapper; it is not treated as success evidence. Independent reads of all four heads returned HTTP 401 `DEVICE_CREDENTIAL_REVOKED`, and fresh web device rows show both this and the earlier temporary connection **revoked**.

Ran the real plugin disconnect and unloaded the helper. Independently observed: mappingCount 0, server identity cleared, helperEnabled/helperLoaded false, bridge/diagnostic closure absent, Unix socket file absent. Preserved synthetic fixtures, journals, prior failed logs and backups; no unrelated credential, mapping or document was removed. No product code, release/tag/push, or server deployment occurred in this continuation.

This closes the **public six-case gate**, not all Task7 native-device or release gates. The final-bundle fresh desktop/Android first-image and remaining native matrix must be recorded separately before plugin 0.4.0 release.

Final quality recheck after the public run (21:49:20): `npm run check` exit 0, 66 files / 1,313 tests PASS, format/type/build/bundle/release metadata PASS; lint 0 errors and the same 17 baseline warnings. Separate `env -u npm_config_allow_scripts npm audit --json` exit 0, 0 vulnerabilities. Log `final-plugin-check-after-public.log`, SHA256 `2916a183511e8fcd3bc3c39189694ab9d1cc2d67d19c33a7e9a360ecd5a455e4`. Rebuilt main/manifest/styles hashes remain `277116a9…` / `7b001849…` / `5dfe1583…`, identical to the installed reviewed candidate. This adds no product or release change.
