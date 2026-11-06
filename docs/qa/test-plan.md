# DEE Debugger — Manual Test Plan (live MES)

For a human tester with a **disposable** live MES
stack (reference: 11.2.5/12.0 cmf-cli local stack, docker or docker-in-docker). Never run this
plan against a shared or production MES: it uploads code, executes actions, registers debug
mode, and restarts containers.

## Conventions & global preconditions

- **Environment**: VS Code ≥ 1.90 with the built `.vsix` (or F5 dev host); `ms-dotnettools.csharp`
  installed; `docker` CLI working in the same shell VS Code runs in; a scratch MES stack the
  tester may break (`cmf dev local stack up`), host container `custom_host` (or `host`).
- **Scratch data** (create in MES UI → Administration → DEE Actions before starting):
  - `QA_Scratch_A` — no group; action code `Input["a"]=1;`, test condition `return true;`.
  - `QA_Scratch_B` — member of group `QA.Group.One`.
  - `QA_Scratch_Multi` — member of **both** `QA.Group.One` and `QA.Group.Two` (regression M4).
  - `QA_Scratch_Utf8` — action code containing a comment with accents: `// ação até já €`.
  - A **disabled** action `QA_Scratch_Off` and (if the UI allows) a non-effective version.
- **Tokens**: one PAT and one Access Token for the same user; on Security-Portal stacks note
  the 1 h access-token expiry — TC-G2 needs an expired one (capture one early, use it late).
- Keep the **DEE Debugger output channel** and the **Problems** panel visible throughout; any
  raw payload that deviates from expectations should be copied into `test/fixtures/` (this run
  doubles as the R4 fixture-capture campaign — capture at the points marked **[FIXTURE]**).
- Each case lists **Pre** (preconditions beyond the globals), **Steps**, **Expected**.
  Some cases carry short finding IDs (C1/C2, M1–M8, R-numbers) that regression-test earlier
  engineering/architecture review findings.

---

## A. Connection & environments

### TC-A1 — Discover environments (happy path)
- Pre: fresh profile (no `deeDebugger.*` settings, no stored secrets); stack running.
- Steps: open a folder → activity bar → DEE Debugger → welcome view → **Discover Environments**.
  Select the discovered entry (should be pre-checked with `$(pass-filled)`) → **Connect** →
  choose **Set Personal Access Token…** → paste PAT.
- Expected: environment added to settings (inspect Settings JSON), `activeEnvironment` set,
  tree loads actions, status bar shows `MES: <name>`. Output channel shows `[discover]` probes
  and `[api] POST …` lines **without any token content**.

### TC-A2 — Add environment manually, all variants
- Steps: run **Add Environment…** once per variant: plain docker, docker-in-docker, remote
  docker (`ssh://…` and a context name), WSL, kubectl, OpenShift, local process, custom engine.
  Cancel some at each wizard stage too.
- Expected: each produces the documented `engineCommand` shape in settings
  (`["docker","exec","-i",<dc>,"docker"]`, `["docker","-H",…]` / `["docker","--context",…]`,
  `["wsl","-d",…]`, `["oc"]`, …); cancelling at any stage leaves settings untouched; duplicate
  names rejected inline by the wizard.

### TC-A3 — Switch environment; per-environment credentials
- Pre: two environments A and B; token stored for A only.
- Steps: switch A→B via the status-bar item.
- Expected: switcher shows `$(key) token set` for A, `$(warning) no token` for B; on switching
  to B the **Set Credentials** chooser opens automatically (Output: `[env] 'B' has no stored
  token — asking for credentials.`); tree empties/reloads for B, **not** A's data.
  **Watch for (M3 regression)**: a "Failed to load DEE actions: No credentials configured"
  error toast behind the token dialog — the activation handler now skips the refresh in this
  state (`extension.ts`), so record it as a regression if seen.

### TC-A4 — Manage environments: edit, rename, remove
- Steps: **Manage Environments…** → rename A (keep it active) → verify tree still loads
  (credentials must follow the rename). Then remove the active environment.
- Expected: rename keeps token (no re-prompt); remove deletes the profile, wipes its secrets,
  falls over to the next environment (message names it) or shows the welcome view when none left.

### TC-A5 — Regression M8: Global vs Workspace settings fork
- Pre: no folder open (empty window).
- Steps: create environment `globalEnv` with no folder open (lands in **user** settings — verify).
  Open a folder. Run Manage Environments → edit `globalEnv` (change host address). Inspect
  **both** user and workspace `settings.json`. Then close the folder, reopen an empty window,
  open the switcher.
- Expected (desired): the edit lands where the value lives; one source of truth; no duplicate.
  **Known-bad before the M8 fix** (`updateSettingInOwningScope`, migration writes to Global):
  edit writes the whole array to Workspace; user scope keeps the old copy; the old profile
  resurrects in the empty window. Record actual behavior; also check whether startup migration
  created `.vscode/settings.json` uninvited.

### TC-A6 — Test Connection: success and failures (negative)
- Steps: (a) run **Test Connection** with the stack up; (b) stop Traefik/host (`docker stop`),
  run again; (c) set an environment host address to a wrong port, run again; (d) point it at a
  non-MES web server (e.g. `python3 -m http.server`), run again.
- Expected: (a) "Connected to … successfully". (b/c) "Could not reach …" error with the URL,
  no hang > ~60 s, extension stays responsive. (d) a clean "unparseable JSON"/HTTP error — not
  a crash. Output channel logs each failure. **[FIXTURE]** capture a raw error body.

### TC-A7 — Expired / invalid token (negative)
- Pre: an expired access token (Security-Portal, > 1 h old) or a truncated one.
- Steps: set it via **Set Access Token…** → Refresh.
- Expected: error mentions 401/auth and the hint "The token may be expired — run 'DEE
  Debugger: Set Credentials…' to set a new one." Setting a valid PAT afterwards **must**
  recover: **Set Personal Access Token…** clears the stale access token automatically, so the
  PAT takes effect on the next refresh (regression eng. minor 9: a stale access token must not
  silently shadow the new PAT — record which token the next call used).

### TC-A8 — PAT pasted into the Access-Token prompt
- Steps: run **Set Access Token…** but paste a PAT (a JWT with `"type":"PAT"`).
- Expected: extension re-routes it (message mentions PAT), calls go out as `Basic` auth and work.

### TC-A10 — Set Credentials chooser (no assumed method)
- Steps: run **Set Credentials…** (palette) or the **Set Credentials** welcome-view button on an
  active environment.
- Expected: a quick-pick offers **Set Personal Access Token… / Set Access Token…** — no method is
  pre-applied. Each entry sets exactly the chosen credential kind. With no active environment, it
  says to select one first. (Browser sign-in is a deferred method — ADR 0007 — not offered.)

### TC-A13 — Auto-prompt on activation without credentials
- Steps: for each path — switch (picker/status bar), discover→Connect, **Add Environment**,
  **Remove** the active environment (fall over to the next), and a direct `activeEnvironment` edit
  in settings — activate an environment that has **no** stored credentials.
- Expected: the **Set Credentials** chooser appears automatically in every case, exactly once
  (no double-prompt). Dismissing it leaves the welcome view; the tree loads after credentials are set.

### TC-A9 — Workspace-planted environment (security, R1)
- Pre: a test repo whose `.vscode/settings.json` ships `deeDebugger.environments` with an
  `engineCommand` of `["sh","-c","touch /tmp/pwned #"]`-style prefix, and `activeEnvironment`.
- Steps: open the repo (trust it when prompted), then trigger **Toggle DEE Debug Mode** on any
  action.
- Expected (desired): consent prompt showing the argv before anything executes, or the setting
  ignored at workspace scope. **Known-bad current behavior (R1)**: the argv executes with no
  prompt — verify (check for the touched file) and record. Do this on a throwaway machine/VM.

## B. Browse & filter

### TC-B1 — Tree hierarchy and counts
- Steps: Refresh; expand the tree; compare against MES UI Administration → DEE Actions.
- Expected: dot-delimited groups nest (`QA › Group › One`); `QA_Scratch_A` (ungrouped) under
  the root; disabled actions hidden by default with a *"N disabled actions hidden — click to
  show"* row; non-effective (draft) actions **visible** with a `not effective (Active)` badge;
  counts match the UI once the hidden-disabled row is accounted for. **[FIXTURE]** capture
  `GetAllActions` + `GetAllActionGroups` raw responses.

### TC-B2 — Regression M4: action in multiple groups
- Steps: expand `QA.Group.One` **and** `QA.Group.Two`; collapse/expand each several times;
  click the `QA_Scratch_Multi` item under each parent; then Refresh and repeat.
- Expected (requirement F2.1): the action appears under **both** groups, both expandable, no
  errors. **Known-bad (M4)**: second group fails to expand and/or extension-host log shows
  `TreeError … already registered`. Check Help → Toggle Developer Tools console. Record.

### TC-B3 — Show disabled actions toggle
- Steps: click the *"N disabled actions hidden"* row; then run **Toggle Show Disabled
  Actions**; then flip `deeDebugger.showDisabledActions` in settings; watch the tree.
- Expected: `QA_Scratch_Off` appears (visually distinguished) / disappears; the hidden row
  disappears when nothing is hidden. The toggle rebuilds locally (no server round-trip).

### TC-B7 — Draft (non-effective) versions visible + Make Version Effective (GitHub #7)
- Pre: in the MES UI create `QA_Scratch_Draft` with the wizard and do NOT make it effective.
- Steps: Refresh. Observe the row. Right-click → **Make Version Effective** (or the inline ✓).
  Repeat on an already-effective action. Open **Show Version History…** on an action with a
  staged Active version and pick that version.
- Expected: the draft is listed with `v1 · not effective (Active)` and a warning-coloured icon;
  tooltip explains the state. Promotion succeeds, the badge disappears, the MES UI shows v1
  effective. On an effective action the command reports "already effective" (no call). From
  version history a *Make vN Effective* button is offered for Active versions only.
  **[FIXTURE]** capture `MakeActionVersionEffective` request + response.

### TC-B8 — New DEE Action… (GitHub #8)
- Steps: click `+` in the explorer title. Name `QA_Scratch_New` (also try `1bad`, `Has Space`,
  and an existing name), description, classification (existing / Other…), then **Create and
  make effective**. Repeat with **Create as draft**.
- Expected: invalid/duplicate names are blocked inline; the action appears in the tree (badge
  only for the draft variant), `<Name>.cs` opens with the wizard's starter template inside
  the markers, MES UI shows the action enabled with the chosen effectiveness. **[FIXTURE]**
  capture `CreateAction` request + response.

### TC-B4 — Text filter, incl. collapsed-group regression (eng. minor 1)
- Steps: collapse `QA.Group.One` manually. Run **Filter Actions…** with a substring matching
  only `QA_Scratch_B`. Then clear the filter (empty string).
- Expected: only matching actions/groups remain and matches are **visible** (the previously
  collapsed group must expand — known-bad: it stays collapsed, hiding the match; record).
  Clearing restores the full tree; filter icon toggles between states.

### TC-B5 — Per-action state details (F2.3)
- Steps: hover an action; open one, edit without uploading; toggle debug on another.
- Expected: tooltip/description shows name, description, version, modified by/on; pending
  local change and DEBUG states visibly distinct; states survive a Refresh.

### TC-B6 — Scale note (5000-action environments)
- Pre: only if a large seeded environment is available (some customer DBs hold thousands of
  actions; optionally seed by script).
- Steps: Refresh; expand-all; filter; open an action.
- Expected: refresh completes without blocking the UI thread (spinner, editor stays usable);
  expand-all completes (eng. minor 2 warns the 1.5 s window may truncate deep trees — record);
  filter latency acceptable (< ~1 s). Record timings in the run notes.

## C. Edit & upload (single action)

### TC-C1 — Open, edit, Compile & Save (happy path)
- Steps: open `QA_Scratch_A` from the tree → file appears in DEEs folder with 4 markers →
  add `Input["qa"]=2;` inside the action markers → save → right-click → **Save Action to MES**.
- Expected: "saved successfully", pending-change badge clears, change visible in MES UI.
  **[FIXTURE]** capture `GetActionFullCode` and `CompileAndSave` request/response.

### TC-C2 — Compile error mapped to the right line/region (F3.2)
- Steps: add `var oops = ;` in the **action** body (line N of the body), upload. Then move the
  error into the **validation** body, upload again. Then fix and upload clean.
- Expected: error notification + Problems entries pointing at (or within a line of) the broken
  line, in the correct marker region both times; diagnostics clear on the clean save.
  **[FIXTURE]** capture the compile-error payload (highest-risk contract per smoke-test.md).

### TC-C3 — Regression M5: expired token during upload
- Pre: token expired mid-session (wait out the 1 h, or revoke the PAT server-side).
- Steps: edit `QA_Scratch_A`, upload.
- Expected (desired): auth error with the set-token hint. **Known-bad (M5)**: "Compilation of
  'QA_Scratch_A' failed — 1 problem(s)" with a bogus diagnostic at line 0/1. Record which you
  get; this is the top supportability repro.

### TC-C4 — Concurrency conflict (409) on single save
- Steps: open `QA_Scratch_A` in VS Code; edit **and save the same action in the MES UI** (bump
  its code); then upload from VS Code.
- Expected: modal "'…' was changed on the MES since it was loaded … Overwrite?"; **Overwrite**
  refetches and saves your bodies (verify in MES UI); cancel leaves the server version intact.
  Repeat twice in a row — the second save must not 409 against our own previous save.

### TC-C5 — Marker validation guards (F3.5)
- Steps: delete the `END OF USER-DEFINED CODE` marker line → upload. Restore. Duplicate a
  marker line → upload. Append text after a marker on the same line → upload.
- Expected: each blocked client-side with a specific message (missing/duplicated/not
  whole-line); nothing sent to the server (no `[api] POST` in output).

### TC-C6 — Reload from MES (F3.3 — no prior verification exists)
- Steps: edit `QA_Scratch_A` locally (leave unsaved AND try again with saved-but-not-uploaded
  changes); right-click → **Reload Action from MES**; test both Cancel and Reload.
- Expected: modal warns about losing pending changes; Cancel changes nothing; Reload rewrites
  the file with server content, clears diagnostics, reopens the editor. Note whether an
  open-dirty editor conflicts with the on-disk rewrite (C2-adjacent — record behavior).

### TC-C7 — Save as new version (F3.6 — no prior verification exists)
- Steps: edit `QA_Scratch_A` → **Save Action to MES as New Version…** → first "keep current
  effective", then repeat with "make it effective".
- Expected: MES UI shows a new version each time; effectiveness matches the choice; success
  message shows the new version number; tree updates. **[FIXTURE]** capture
  `CompileAndSaveWithNewVersion` request/response (the `IsNewVersion`/
  `IsToMakeNewVersionEffective` flags are untested anywhere else).

### TC-C8 — CRLF file survives round-trips (eng. minor 6)
- Pre: convert `QA_Scratch_A.cs` to CRLF (VS Code status bar), commit/stash a git baseline.
- Steps: upload; then modify the action in MES UI and run a sync download of that file (§E).
- Expected (desired): only body lines change in `git diff`. **Known-bad**: whole-file EOL
  rewrite to LF. Record.

### TC-C9 — Action names needing sanitization
- Pre: create action `QA/Weird: Name` (slash/colon/space) in MES UI, if the UI allows.
- Steps: open it, edit, upload, toggle debug on/off.
- Expected: file `QA_Weird_ Name.cs` (sanitized) created; upload and debug-push work (quoting
  is unit-tested; this verifies it live). Also create `QA_Weird_ Name` (already-sanitized
  collision, eng. minor 7) and run a sync compare — record which action the file is attributed
  to; desired: a collision warning.

## D. Debug mode & attach

### TC-D1 — Toggle debug on: push + registration
- Steps: toggle debug on `QA_Scratch_A`; then
  `docker exec <host> ls -l /tmp/CriticalManufacturing/dee-debug/`.
- Expected: with `deeDebugger.attachAfterEnablingDebug = ask` (default) a modal "Debug mode
  enabled … Attach the debugger now?" explains per-user/in-memory semantics with **Attach
  Debugger** / **Not Now**; DEBUG badge appears; the `.cs` file is in the container; output logs the host path
  and bridge description. **[FIXTURE]** capture `ActivateDebugMode` request/response.

### TC-D2 — Attach, breakpoint, inspect (F4.2/F4.3)
- Steps: from TC-D1's modal choose **Attach Debugger**. First run on a fresh container:
  accept the vsdbg install offer. Set a breakpoint in the action body; execute the action (curl
  `ExecuteAction` as the same user, or via TC-F2).
- Expected: vsdbg installs (watch output; on a curl-less host image the local-download/tar
  fallback runs); PID auto-resolved or picker shows the `dotnet …HostService.dll` process;
  breakpoint binds on first execution and hits; `Input` inspectable; F5 continues.

### TC-D3 — Hot reload on save (the core loop)
- Steps: with debug on and debugger attached, change the body (`Input["qa"]=3;`), save, wait
  for the "DEE: pushed …" status-bar flash, re-execute.
- Expected: new behavior executes **without** Compile & Save; breakpoint still binds; DB
  version (MES UI) unchanged.

### TC-D4 — Regression C1: save-push vs watcher poll race
- Pre: debug mode on for `QA_Scratch_A`; slow push path preferred (dind or remote engine).
  The watcher polls every 15 s, so races are probabilistic — iterate.
- Steps: edit + save repeatedly at ~10–20 s intervals for 5 minutes (a keystroke-save loop or
  a scripted `code --wait`-less editor loop is fine). After each save, wait 20 s and diff the
  file on disk against what you saved.
- Expected (desired): the file on disk always holds your last save; no "MES host rewrote your
  file" notification unless the host truly regenerated it. **Known-bad (C1)**: occasionally the
  just-saved file reverts to the pre-save content with a "host rewrote" notification — the next
  execution then compiles the old code. Any single revert is a Gate-1 failure; record output-
  channel `[watch]` lines and timings.

### TC-D5 — Host rewrite pull-back (F3.5 legitimate case)
- Steps: with debug on, hand-edit a `using` directive **outside** the markers, save (host
  regenerates its wrapper on next execution), execute the action, wait ≤ 15 s.
- Expected: "The MES host rewrote '…'" notification, local file updated to the host version.
  Then repeat with **unsaved** local edits present: warning instead, file untouched.

### TC-D6 — Host restart while debugging (negative; arch. §3.2 / F4.6)
- Steps: with debug on and badge lit, `docker restart <host>` (or full stack recreate:
  `cmf dev local stack down && up` — also re-run TC-D1 afterwards for the recreate case).
  Execute the action; watch the tree, the watcher, and the save hook.
- Expected: on the next tree refresh the extension sees `IsInDebugMode === false` for the
  action and shows "Debug mode for '…' was lost (the MES host restarted). Re-enable?" with
  **Re-enable Debug Mode** (Output: `[debug] host no longer holds the debug registration …`).
  **Known-bad before that check**: badge stays DEBUG, saves keep "pushing", host executes the
  **DB (release)** version — verify which code actually ran; `[watch]` probes may log errors for
  the missing container file. Record everything; this is the Q8 risk.

### TC-D7 — Regression M1/M6: engine failure paths (negative)
- Steps: (a) set the environment's `containerName` to `nonexistent`, toggle debug on;
  (b) restore, then set `engineCommand` to `["sh","-c","sleep 600 #"]` and toggle debug on;
  (c) while (b) hangs, try to use the tree and other commands.
- Expected (desired): (a) fast, clean error naming the container; **no** uncaught-exception
  entry in Help → Toggle Developer Tools console (known-bad M1: EPIPE `error` event). (b) the
  operation times out around 30 s with a clear message (known-bad M6: hangs forever, no
  cancel — record how you had to recover). (c) the rest of the extension stays responsive (N1).

### TC-D8 — Regression M7: orphaned vsdbg processes
- Steps: start an attach and pick a **wrong** PID (or cancel at the picker) three times; then
  `docker exec <host> ps aux | grep vsdbg`.
- Expected (desired): no leftover `vsdbg --interpreter=vscode` processes after failed attaches.
  **Known-bad (M7)**: one orphan per failure, running as root. Count and record; verify a
  successful attach still works with orphans present.

### TC-D9 — Deactivate-on-close (F4.5) and cross-environment cleanup (R2)
- Steps: (a) toggle debug on, close the VS Code window, reopen; check
  `IsInDebugMode` for the action (MES UI or `GetActionByName` curl) — desired: deactivated.
  (b) **Cross-env repro**: toggle debug on in env A, switch to env B, close the window; check
  A's host — known-bad before the R2 fix: A's registration leaks and B may receive a spurious
  deactivate. Sessions now carry their `envName`: switching away deactivates A's registrations
  against A (Output `[env] deactivated n/n debug registration(s) on 'A'`), and `deactivate()`
  targets each session's own environment.
- Expected: record actual behavior for both; (b) is a Gate-2 item — a leak on A or a spurious
  deactivate against B for a same-named action would be regressions.

### TC-D12 — Ptrace preflight: non-root host user, granted cap, Kubernetes
- Pre: (a) a docker stack whose host container runs as the image default user (remove the
  `user: root` override, or `docker exec -u 1001` to simulate); (b) a stack with `cap_add:
  [SYS_PTRACE]`; (c) a k8s host pod without `SYS_PTRACE`.
- Steps: **Attach Debugger to MES Host** in each; read the `[attach] ptrace probe:` and
  `[attach] pid=… config=` lines in the Output channel; set a breakpoint and trigger the action.
- Expected: (a) `CAP_SYS_PTRACE=false uid=1001` and pipeArgs `exec --privileged -u 0 -i …`;
  the breakpoint hits. (b) `CAP_SYS_PTRACE=true` and pipeArgs `exec -i …` (no escalation);
  hits. (c) a modal naming the missing capability with the pod-spec fix (and `runAsUser: 0` for a
  non-root container); **Attach Anyway** proceeds, dismissing cancels. Optional: on a node with
  `kernel.yama.ptrace_scope=3` the attach is refused with that reason.

### TC-D11 — Unpatched host is detected and prompted (F4.7, #158143)
- Pre: a freshly (re)created Linux stack (host DLL unpatched); an action open locally.
- Steps: **Toggle DEE Debug Mode** → observe the prompt → choose **Continue Anyway**; trigger the
  action from the MES UI; **Attach Debugger to MES Host** with a breakpoint set; wait ~10 s.
  Then disable debug mode, enable it again and choose **Patch Host for Debugging**: the
  extension patches, restarts the host, waits for its API ("Waiting for the MES host to come
  back up…") and then registers debug mode by itself. Attach and trigger the action.
- Expected: a modal "not patched for DEE debugging (#158143)" prompt before registration (Output
  shows `host PDB format check: unpatched`); on attach a non-blocking warning with a **Patch Host
  for Debugging** button; the unbound-breakpoint notice names the unpatched host and carries the
  same button. Choosing the patch runs it with **no second consent dialog**, restarts the host,
  and after re-enabling debug mode the breakpoint binds. A second toggle within 10 minutes does
  not probe again (Output has one check line); `deeDebugger.hostPatchCheck = off` suppresses
  the probe; a `process`-kind environment is never probed.

### TC-D10 — Non-local attach warning (F4.4 / arch. §4.2)
- Steps: attach against an environment whose host address is non-local (anything other than
  localhost, `::1`, 127.x, 172.16–31.x or `*.local` — a devcontainer's 172.x bridge IP counts as
  local and gets no modal); then against `http://localhost`.
- Expected: non-local address → modal "never do this on a production environment" with
  Continue/cancel honored; localhost → no modal. Note (arch.): a remote docker daemon behind a
  localhost API gets **no** warning — record if your setup can demonstrate it.

## E. Sync with the local Actions project — NO prior verified run; entire section is Gate-1

### TC-E1 — Initial bulk download (F5.1)
- Pre: empty DEEs folder; ≥ 5 server actions incl. the scratch set.
- Steps: **Sync: Download Changes from MES** → all entries pre-checked → confirm.
- Expected: one `<Name>.cs` per action the MES lists (drafts and disabled included — they are
  labelled in the pick list), full generated wrapper, all parse (reopen a few); summary
  counts match.

### TC-E1b — Upload a new local DEE creates it enabled + offers promotion (GitHub #8)
- Pre: a new file `QA_Scratch_Local.cs` in the DEEs folder (copy a downloaded one, change the
  body), not on the MES.
- Steps: **Sync: Upload Local Changes to MES** → tick the local-only entry → confirm → at the
  end choose **Make Effective**. Repeat with another file choosing **Keep as Drafts**.
- Expected: MES UI shows the action **enabled**; first run: effective v1; second run: v1 Active
  with the `not effective` badge in the tree. A following **Sync: Compare** reports both as
  *in sync* (no longer local-only).

### TC-E2 — Compare + diff (F5.2)
- Steps: edit two local files (one in action body, one only whitespace/EOL); modify a third
  action in the MES UI; delete a fourth local file; add a fifth local-only `.cs` with valid
  markers (both generated and legacy cmf-cli dialects); add a `DeeDevBase.cs`; run
  **Sync: Compare Local DEEs with MES**.
- Expected: summary `N in sync, N differ, N local-only, N MES-only`; whitespace-only edit
  counts as in-sync; `DeeDevBase.cs` ignored; legacy-dialect file recognized; picking a
  modified entry opens a diff whose left side renders server bodies **inside the local
  wrapper** (only real code differences highlighted); MES-only entries open read-only.

### TC-E3 — Batch upload with a failure mid-batch (F5.3)
- Steps: make three local files differ; break one (`var oops=;`); run **Sync: Upload** with all
  three selected.
- Expected: two upload, the broken one fails **without aborting the batch**; warning summary
  names the failure; Problems/Output show the compile error against the right file; MES UI
  confirms the two good uploads. Cancel mid-batch also tested (progress is cancellable).

### TC-E4 — Regression C2: download over an open dirty editor
- Steps: open `QA_Scratch_A.cs`, type an edit, do **not** save; modify the same action in the
  MES UI; run **Sync: Download** selecting that entry; then try to save the editor.
- Expected (desired): entry skipped with a per-file warning counted as a failure, or applied
  through the editor buffer. **Known-bad (C2)**: disk file overwritten under the dirty editor;
  summary says "Downloaded"; the next editor save raises VS Code's file-conflict flow (or
  silently overwrites the download, depending on `files.saveConflictResolution`). Record which
  version survives — this is a Gate-1 data-loss repro.

### TC-E5 — Regression eng. minor 4: batch sync vs open session / debug mode
- Steps: (a) open `QA_Scratch_A` (session exists), sync-**upload** it via the batch, then edit
  and single-save-to-MES again. (b) With debug mode ON for `QA_Scratch_A`, sync-**download** a
  server-side change to it, then execute the action **without** touching the editor.
- Expected: (a) desired no 409; known-bad: guaranteed 409 modal (stale concurrency token kept
  by the session). (b) desired the downloaded code executes; known-bad: host keeps compiling
  the **old** file (download bypassed the save-push hook) — verify which code runs.

### TC-E7 — DEE files in subfolders, several packages, DeeDevBase files (ADR 0012)
- Steps: (a) move a generated-format `QA_Scratch_A.cs` into `DEEs/Sub/`; open the action, set a
  breakpoint, enable debug mode, attach, trigger. (b) Put a `DeeDevBase`-format `QA_Scratch_B.cs`
  in `DEEs/Other/`; open the action, edit the working copy, **Save Action to MES**, accept
  **Write Back**. (c) Copy `QA_Scratch_A.cs` into a second Data package's `DEEs/`; open it.
  (d) Replace a root `QA_Scratch_C.cs` with text without markers; open the action and run
  **Sync: Download** on it.
- Expected: (a) the subfolder file opens in place, no copy appears at the DEEs root, and the
  breakpoint binds in that file. (b) the source stays untouched until Write Back, then keeps
  its `DeeDevBase` layout and line endings; the working copy is under
  `.dee-debug/<same relative path>` and `git status` doesn't show it. (c) open refuses and
  lists both files. (d) open and download both refuse; the file is unchanged.

### TC-E6 — Sync with server-side 409 (F5.5 mitigation)
- Steps: run Compare; before uploading, bump the same action in the MES UI; upload.
- Expected: that entry fails with the output-channel note "changed on the MES since the
  comparison — run 'Sync: Compare' again and retry"; batch continues.

## F. Versions & execute — NO prior verified run of the UI flows

### TC-F1 — Version history (F2.5)
- Pre: `QA_Scratch_A` with ≥ 3 versions (use TC-C7).
- Steps: right-click → **Show Version History…**; pick an old version.
- Expected: versions listed newest-first, effective one marked, modified-by/on shown; picking
  opens a diff old-version ↔ local file (or read-only view when never opened locally).
  **[FIXTURE]** capture `GetActionVersionsAsDataSet` (DataSet/Table1 shape).

### TC-F2 — Execute read-only vs full (F3.7)
- Steps: **Execute Action…** on `QA_Scratch_A` → read-only with input `{"x":1}`; then full
  execute (confirm the modal); then full execute but **cancel** the modal; then invalid JSON
  input.
- Expected: read-only requires no confirmation, report opens as untitled JSON with
  input/output/duration and CMFMap decoded to a plain object; full execute persists side
  effects only after explicit confirm; cancel sends nothing; invalid JSON blocked inline.
  **[FIXTURE]** capture `ExecuteAction`/`ExecuteReadOnlyAction` bodies (CMFMap `Output`).

### TC-F3 — Execute failure surface
- Steps: execute an action whose code throws (`throw new Exception("qa-boom");`).
- Expected: error notification carries the server's message (`qa-boom` visible, not a JSON
  envelope dump); output channel has the full payload.

## G. Supportability of errors (input to review phase 4)

### TC-G1 — Output channel hygiene / token redaction (N2, arch. D7)
- Steps: after a full session (connect, browse, upload, debug, an auth failure), select the
  entire DEE Debugger output channel and search for: the token value (first 12 chars),
  `Bearer `, `Basic `, `Authorization`.
- Expected: zero hits of credential material anywhere — including inside logged error bodies
  and `[api]`/`[error]` lines. Any hit is a release blocker.

### TC-G2 — Auth-failure ticket quality
- Steps: with an expired token, exercise: Refresh, Test Connection, open action, upload
  (TC-C3), toggle debug, sync compare.
- Expected: every path yields the auth hint ("The token may be expired — run 'Set
  Credentials…' to set a new one"), never a compile-failure disguise (M5) or a raw stack; note for the support review which
  paths differ.

### TC-G3 — Debugger-paused host hint
- Steps: attach, hit a breakpoint, leave the process stopped; in another VS Code action run
  Refresh / Test Connection.
- Expected: after the timeout, the error includes the field-learned hint "host is probably
  paused by the attached debugger … continue (F5) and retry".

### TC-G4 — HTML/proxy response (wrong address class)
- Steps: point an environment at a URL that answers HTML (e.g. the MES UI root through
  Traefik without `/api`), Refresh.
- Expected: "returned unparseable JSON" class error naming the URL — enough for a support
  ticket without DevTools; raw body in the output channel.

### TC-G5 — Regression M2: non-ASCII content integrity
- Steps: with debug on for `QA_Scratch_Utf8` (accented comment ≥ a few KB — pad the comment
  block to > 64 KB to force chunking), trigger a host rewrite pull (TC-D5 method) or use any
  flow that pulls the container copy back.
- Expected (desired): pulled file byte-identical in its accented text. **Known-bad (M2)**:
  U+FFFD replacement characters at chunk boundaries; if seen, also verify whether the save
  hook then pushed the corrupted file back (compounding).

## H. Edge cases & platform

### TC-H1 — Multi-root workspace (documented limitation, arch. §3.3)
- Steps: workspace with two folders, DEE csproj in the **second**; open an action; check where
  the file lands; run sync.
- Expected: current behavior resolves the **first** folder only — verify the failure mode is
  comprehensible (file in wrong folder vs error) and record; README/limitations must state it
  before wider rollout.

### TC-H2 — No folder open
- Steps: empty window (no workspace) → try open action, sync, toggle debug.
- Expected: clear "workspace folder required"-class messaging, no crash; environment
  management still works (writes to user settings — cross-check TC-A5).

### TC-H3 — Windows / macOS smoke (only if in rollout audience — else record as untested)
- Steps: on Windows (incl. WSL-remoted) and macOS: TC-A1, TC-C1, TC-D1–D3, plus: open the
  same file via a different path casing and save (eng. minor 8 — save-push must still fire);
  vsdbg install fallback on a curl-less container (needs local bash+tar — expected to fail on
  plain Windows; verify the error is clear).
- Expected: record per-platform; any silent no-op (casing miss) is a blocker for that platform.

### TC-H4 — Stack recreate end-to-end (negative/recovery)
- Steps: full `cmf dev local stack down` + `up` (new container IDs, wiped writable layer, DB
  persists). Without reloading VS Code: Refresh, open, upload, toggle debug (needs re-push +
  vsdbg reinstall), attach.
- Expected: every flow either works or fails with an actionable message and succeeds on
  retry; no state requires deleting settings/secrets to recover. Record any step that needed a
  window reload.

### TC-H5 — Environment switch mid-operation (M3 repro)
- Steps: start a Refresh against a slow host (host paused at a breakpoint via TC-G3 makes it
  slow), immediately switch to the other environment.
- Expected (desired): the tree shows the **new** environment's data once loaded; the stale
  response is discarded (the explorer's refresh epoch guard, M3 fix). **Known-bad before that
  fix (M3)**: old environment's actions render under the new header — if seen, try opening one
  and record what happens (wrong-host entity, R2 compounding).

---

## Run reporting

For each TC record: pass / fail / known-bad-confirmed / blocked, environment (MES version,
host topology, OS), timings where asked, and output-channel excerpts for failures. File every
contract deviation as a fixture + failing unit test per the smoke-test exit criteria. Gate-1
release sign-off requires: all §C/§D/§E MUST-path cases pass, TC-D4/TC-E4 no longer reproduce
after the C1/C2 fixes, TC-B2 passes after M4, TC-C3/TC-G2 after M5, TC-D7 after M1/M6, and
TC-G1 clean.
