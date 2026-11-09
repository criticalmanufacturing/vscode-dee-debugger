# Roadmap

Status 2026-08-14: M0–M4 done and verified against a live MES 11.2.5 (see docs/smoke-test.md).
M4 verification: scan/plan/upload/compile-error/409-conflict paths exercised live via scripted
core runs; compare + diff UI confirmed interactively in VS Code.

## M0 — Project foundation ✅
Repo, docs (requirements/architecture/ADRs), AGENTS.md, toolchain (TS + esbuild +
vitest + eslint), CI, extension skeleton that activates.

## M1 — Read path (browse & open) ✅
Settings + SecretStorage token commands; `mesClient` (GetAllActionGroups/GetAllActions/
GetActionById/GetActionFullCode) with $ref resolution; DEE Explorer tree (hierarchy, filters,
refresh, status icons); open action → local file. Unit tests: jsonRefs, treeModel, deeFile.

## M2 — Write path (edit & upload) ✅
Marker codec validation; upload command (`CompileAndSave`); server compile-error → diagnostics
mapping; reload with confirmation; dirty tracking. Save-as-new-version (SHOULD).

## M3 — Debug ✅
Host-kind abstraction (`process`/`docker`/`kubernetes`); fileBridge (push/pull — first via
`docker cp`, replaced by exec stdin/stdout streaming per ADR 0005; remote-rewrite detection); ActivateDebugMode/DeactivateDebugMode; attach command with generated
coreclr configs; vsdbg install helper; debug-semantics UX (warnings, status badges, cleanup on
deactivate).

## M4 — Sync with local Actions project ✅
Bulk download into `Cmf.Custom.Data/DEEs` layout; diff report + diff editors; batch upload with
per-file results; both marker dialects; `DeeDevBase.cs` handling.

## M5 — Polish & release ✅ (2026-08-14)
Environment profiles (per-profile credentials; add wizard, auto-discovery, connect,
manage/rename/remove with credential hygiene), search/filter, version history, execute
scratchpad, host-rewrite watcher (F3.5), debug-mode cleanup on window close (F4.5), icon,
LICENSE (then a placeholder; `LICENSE.md` is now BSD-3-Clause), CHANGELOG, no-telemetry policy, headless
VS Code e2e suite in CI, tag-triggered release pipeline (GitHub Release + opt-in
marketplace publish via Trusted Publishing, GitHub OIDC).
Repository home: GitHub, `criticalmanufacturing/vscode-dee-debugger`. Marketplace: 0.3.0
published 2026-11-09 as a pre-release under the `CriticalManufacturing` publisher (first
version uploaded manually; later versions publish from CI).
Open decisions (non-engineering): legal review of LICENSE.

## M6 — Browser sign-in (auth UX) — deferred
Browser-based OIDC sign-in (auth-code + PKCE loopback, tenant-scoped discovery, refresh-token
renewal) per ADR 0007. **Prototyped and removed** (2026-08-15): it cannot complete against
current MES stacks — the Security Portal has no public loopback client and its forward-auth
loops the loopback redirect to HTTP 431. Blocked on **upstream work item 3** (a public OIDC
client with loopback redirects); revisit when that lands. Design + evidence retained in
`docs/adr/0007-browser-oidc-login.md` and `docs/upstream/workitem-3-securityportal-public-client.md`.
The feature commit cited for the removed code (`77e4c04`) is not in this repository's history,
which starts at the v0.1.0 import (`013fa87`). Meanwhile PAT and browser-copied access token
(via the *Set Credentials* chooser) remain the shipped methods.

## M7 — Debug custom business DLLs via a unified Attach — accepted & integrated
**Accepted (ADR 0008) and unified (ADR 0009).** One command — **Attach Debugger to MES Host**
(`deeDebugger.attach`) — debugs **both** DEE Actions and compiled `Cmf.Custom.<tenant>.*` DLLs in
a single coreclr attach with a **merged `sourceFileMap`** (DEE temp folder + the business `/src`
root via `deeDebugger.hostSourceMap`, default `{ "/src": "${workspaceFolder}" }`). Both attaches
were always the same operation — same debugger, same host process, differing only in source-map
entries — so they were collapsed into one (the separate `deeDebugger.attachToHost` was removed).
*Toggle DEE Debug Mode* stays separate (registration + hot-reload); business breakpoints bind
against the deployed binary with **no hot-reload**.

Delivered via a full PO → UX → Architect → Developer → Support → Tech-writer → Trainer pass:
`core/businessAttach.ts` (source-map resolution + unbound-breakpoint heuristics, unit-tested),
UX hardening (C#-extension pre-check, Switch-Environment button, one-time prerequisites primer,
single progress notification, unbound-breakpoint watcher), and docs (user guide
`dee-vs-business-debugging.md` + debugging section, support playbook, training Module 8).
**Validated end-to-end (2026-08-15)** against the live 11.2.5 stack with a dummy portable-PDB
DLL built with `PathMap=/src` — breakpoint bound/paused/read locals, resolving only with the
`/src`→local `sourceFileMap` (ADR 0008 §Validation). Correction 2026-10-19: real `cmf build` PDBs
carry absolute local paths (no `PathMap`), so they bind without any map when built and debugged
at the same path; the `/src` default only serves container builds, and the workspace-shape
warning built on the opposite assumption was removed. Prerequisites: portable PDBs deployed with the DLLs, and DLLs deployed
via `cmf dev local stack up`. (#158143 / `host-pdb-patcher` concern the host's DEE debug
compile only; business-DLL PDBs come from the customization build — the attach command warns
about an unpatched host without blocking for this reason.) Positioning: kept the "DEE Debugger" identity (no rename).
Design: `docs/adr/0008-*.md` + `docs/adr/0009-unify-attach-dee-and-business.md`.

## M8 — Debugger-detach robustness — in progress
A debug session that ends uncleanly (window/WSL close, crash) can leave **vsdbg attached to the
MES host with its request threads suspended**: the host still answers `/` but every `/api` call
hangs until timeout, so the extension looks broken with only generic "could not reach host"
errors. Killing vsdbg does **not** resume the debuggee — only a host restart recovers. Observed
live 2026-08-16.

- **Done:** the extension now tracks the `coreclr` attach sessions it starts and **detaches them
  on deactivate** (`stopDebugging` → disconnect → resume), so a normal window close can't orphan
  a debugger; and the "request timed out" error now hints that a leftover debugger may have the
  host suspended (answers `/` but `/api` hangs) and to restart the host.
- **Next:** proactively **detect** the symptom (host root reachable but `/api` times out) and
  offer a one-click **Restart MES Host** action; sweep for a stray vsdbg on connect/attach and
  offer to clear it (+ restart) before stacking another debugger.

## M9 — Test-user feedback round 1 (GitHub #7, #8) — done 2026-10-18
Both reports traced to one host fact the extension ignored: a newly created action is
**version 1 in state `Active`, not `Effective`** (MES UI wizard, `CreateAction`, and a first
`CompileAndSave` alike), and the tree/sync filtered everything non-effective out.
- **#7 "Cannot see all DEEs":** draft versions are now shown with a `not effective` badge
  (ADR 0011); one shared representative-version rule (`core/actionVersions.ts`) for tree and
  sync; **Make Version Effective** from the tree, version history, and after a draft save;
  disabled actions hidden behind a visible "N hidden — click to show" row.
- **#8 "Cannot sync a new local DEE" + "button to create a DEE":** sync upload of a local-only
  file created the action **disabled** (missing `IsEnabled` → `false`) and non-effective; the
  payload is now explicit and the batch offers promotion. **New DEE Action…** (`+`) creates via
  `CreateAction` with the wizard's defaults, optional immediate promotion, and opens the file.
- **Live-verified 2026-10-18** on MES 12.0.0-beta.2 with the extension's own `MesClient`
  (scripted core run, scratch actions removed): CreateAction → v1 Active enabled; the draft is
  listed by GetAllActions; GetActionFullCode parses; MakeActionVersionEffective → Effective and a
  second promotion is refused ("is not Active"); CompileAndSave without Id + `IsEnabled: true` →
  enabled Active v1 (and **without** the flag → disabled, the 0.1.0 bug reproduced); invalid
  name → Val50018. Fixtures + contract tests added. Found and fixed on the way: the PAT Basic
  layout (`PAT:` is unreadable by the forward-auth; see CHANGELOG 0.2.0). Still manual: the VS
  Code UI pass of TC-B7/TC-B8/TC-E1b (tree badges, dialogs). Environment used:
  an MES **12.0.0-beta.2** local stack (docker-in-docker in that
  project's devcontainer; host container `custom_host`, tenant `mes120beta2`, API via Traefik on
  the devcontainer's port 80) is up, and `cmf new data --businessPackage Cmf.Custom.Business`
  scaffolded the missing `Cmf.Custom.Data/DEEs` project (`DeeDevBase.cs`, net10.0) so the
  extension's DEEs-folder auto-detection works there. The PAT for the live run was created
  by the user in that stack's Security Portal (the auto-mode sandbox does not allow scripted
  token acquisition).

## M10 — Proactive #158143 detection — done 2026-10-18
Test-user report: attach "sometimes fails" and the host needs patching, but nothing prompts.
Cause: the patch offer was wired only to compile errors returned to the extension; executions
triggered from the MES UI fail inside the host, unseen. Now (`core/hostPatch` +
`vscode/hostPatch.checkHostPatchState`): a read-only run of the bundled patcher reports the
host's PDB format; *Toggle DEE Debug Mode* asks **Patch Host for Debugging / Continue Anyway**
before registering,
*Attach* warns without blocking, and the unbound-breakpoint notice offers the patch. Requirement
F4.7, setting `deeDebugger.hostPatchCheck`, test plan TC-D11. ADR 0010 amended.

## Stretch
- Editor assistance from server services (GetCodeCheckForAction/GetAutoCompleteForAction).
- Visual Studio 2022 port (VisualStudio.Extensibility) reusing the spec.
- Upstream request: `debug` stage with vsdbg in the MES host image.
