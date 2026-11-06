# Changelog

## 0.3.0 — 2026-11-06

DEE files in subfolders, in several Data packages, and in the cmf-cli `DeeDevBase` format
([ADR 0012](docs/adr/0012-dee-files-in-subfolders.md)).

### Fixed
- **Opening an action could overwrite your local file.** Open always wrote the MES version to
  `<DEEs folder>/<ActionName>.cs`. A `DeeDevBase`-format file of that name was replaced by the
  MES format, and saved local edits not yet on the MES were lost. Open now uses the existing
  file and never replaces it on its own.
- **Files in subfolders got a second copy at the DEEs root,** which `cmf build` would package.
  Open and debug now use the file where it is.
- **A file with damaged markers is never overwritten,** neither by open nor by
  **Sync: Download**. Both stop and say which file is in the way.

### Changed
- **Clicking an action opens your existing local file,** not the MES version. When the two
  differ, a notice offers **Compare** and **Reload from MES**. **Reload** is the way to take the
  MES version.
- **All DEEs folders are used, subfolders included.** Auto-detection finds one folder per Data
  package; `deeDebugger.deesFolder` accepts a list. New actions are downloaded into the first
  folder. If two packages hold the same action, open lists both files instead of guessing.
- **`DeeDevBase`-format files get a working copy.** The host can only debug the MES format, so
  a working copy opens under `.dee-debug/` (self-ignored by git, never packaged). After a
  successful save to the MES, **Write Back** copies the code into your file and keeps its layout
  and line endings. Saving your `DeeDevBase` file refreshes the working copy.
- **Debug paths mirror your workspace.** A DEE file is placed in the host under its
  workspace-relative path, and attach maps `sourcePathInHost` to the workspace folder. If debug
  mode was enabled by 0.2.0, toggle it off and on once, then re-attach.
- **Requires VS Code 1.145 or later** (was 1.90). Update VS Code before installing this version.

### Added
- **Write Code Back to Source File** command (editor title on working copies, and the action's
  right-click menu).

## 0.2.0 — 2026-10-19

Test-user feedback release (GitHub #7, #8). Verified live on a MES **12.0.0-beta.2** local
stack (2026-10-18) with the extension's own client; the new calls are locked in as contract
fixtures (`test/fixtures/CreateAction.json`, `MakeActionVersionEffective.json`, …).

### Fixed (business-DLL source mapping)
- **The `/src` source map was described as required for cmf-cli builds — it isn't.** cmf-cli sets
  no `PathMap`; `cmf build` PDBs record your repo's absolute paths, so business breakpoints bind
  with no map when you build and debug at the same path (verified on a real 11.3.5 build). Docs,
  the `deeDebugger.hostSourceMap` description, the attach primer and the unbound-breakpoint hint
  now say when a map is actually needed (DLL built in another folder/container or on CI). The
  `/src` default is kept for container builds.
- **Removed the "no `Cmf.Custom.*` folder at the root" warning before attach.** It assumed the
  `/src` map was load-bearing and told users to remap a sub-folder, which has no effect on
  absolute PDB paths; it also interrupted DEE-only workspaces.

### Fixed (which DEE version runs)
- **Drafts were described as "not executed".** The host runs the effective version or, when
  none is effective, the **highest** version (`P_ActionLoadExecutableActions`; verified live on
  MES 12.0.0-beta.2). A newly created action (v1, Active) therefore runs already; a draft is
  skipped only while another version is effective. The tree tooltip, the draft-save message,
  New DEE Action… and the sync-upload prompt now say which case applies, and why making a
  version effective still matters: until one is, a version staged later takes over.

### Fixed (business-DLL deploy loop)
- **"Rebuild + `cmf dev local stack up`" was ambiguous and partly wrong.** `stack up` compiles
  nothing: it rebuilds the host image as the base MES image plus a copy of
  `LocalEnvironment/BusinessTier` (the business templates' **Debug** output) and recreates the
  container. A plain `cmf build` builds **Release** into `Cmf.Custom.Business/Release/`, so the
  host keeps the old DLL. Docs and the unbound-breakpoint hint now say: build with
  `cmf build --test` or `dotnet build`, then `stack up`, then re-attach (verified against the
  cmf-dev plugin and cmf-cli sources).

### Fixed (attach / ptrace)
- **Attach could not ptrace the host on any stack running the image's default user.** The
  product host image runs as uid 1001, and `docker exec --privileged` as a non-root user yields
  an empty effective capability set (verified: `CapEff: 0000000000000000`), so vsdbg was refused
  by Yama unless the stack overrode `user: root`. The privileged exec is now `--privileged -u 0`.
- **Ptrace preflight for every containerized host**: one exec reads the exec user's
  capabilities, uid and `kernel.yama.ptrace_scope`; Docker escalates only when needed,
  Kubernetes (no exec-level escalation) gets the exact pod-spec fix *before* vsdbg fails
  (`securityContext.capabilities.add: ["SYS_PTRACE"]`, plus `runAsUser: 0` or node
  `ptrace_scope=0` for non-root containers), and `ptrace_scope=3` is reported as blocking.

### Fixed (authentication)
- **Personal Access Tokens were sent in a layout the MES forward-auth cannot read.** The old
  VS add-in's `Basic base64(PAT + ":")` puts the token *before* the colon, but
  `cmf.auth.service` exchanges the part *after* it (every release from 11.0 to 12.0) — so a PAT
  produced a login-page redirect ("token rejected"). The client now sends the token in both
  fields (`PAT:PAT`). Verified live: `PAT:` → 302, new layout → 200.

### Added
- **New DEE Action…** (`+` in the DEE Explorer title, or the Command Palette) creates an action
  from VS Code — name (validated the way the host validates it), description, classification
  (pick an existing one or type a new one) — using the same `CreateAction` call as the MES UI
  wizard, with the same starter template. You choose up front whether version 1 is made
  **effective** or kept as a draft; the file is then opened locally. (GitHub #8)
- **Make Version Effective** (inline ✓ and context menu on draft rows; also offered from
  **Show Version History…** for a staged Active version) promotes a version with
  `MakeActionVersionEffective`. After **Save Action to MES** into a draft version, the message
  says whether the MES runs it and offers the same action. (GitHub #7)
- The DEE Explorer shows a **"N disabled actions hidden — click to show"** row instead of
  hiding them silently, and a **Toggle Show Disabled Actions** command.
- **Proactive host-patch check** (test-user report: "attaching sometimes fails and the system
  needs to be patched, but nothing is prompted"). The #158143 prompt used to appear only when
  a compile error reached the extension; when the action is triggered from the MES UI the host
  fails out of sight and breakpoints just never bind. The extension now probes the host (a
  read-only run of the bundled patcher) before enabling DEE Debug Mode and before attaching,
  and prompts **Patch Host for Debugging / Continue Anyway** when the host still emits
  Windows-only PDBs; the "breakpoints have not bound" notice carries the same button. New
  setting `deeDebugger.hostPatchCheck` (`prompt` | `off`); results are cached per environment
  for 10 minutes and reset by patch/restore.

### Added (onboarding)
- **Getting Started walkthrough** (Help → Welcome → *Debug MES DEE actions from VS Code*, or
  **DEE Debugger: Open Getting Started**): connect → authenticate → open → debug → sync →
  where to look, each step with a button for the matching command and automatic completion.
- **Attach right after enabling debug mode**: enabling now ends with one question — *Attach the
  debugger now?* — carrying the debug-mode semantics as detail text, instead of a follow-up
  toast. `deeDebugger.attachAfterEnablingDebug` = `ask` (default) | `always` | `never`; nothing
  is asked when the debugger is already attached.

### Changed (usability pass)
- **Title bar decluttered**: four icons remain (Refresh, New DEE Action, Filter, Attach); Switch
  Environment, Sync, Expand All, Show Disabled, Show Output Log and Collect Support Bundle moved
  to the view's `…` menu. The environment is still one click away via the *Connected ·* row and
  the status bar.
- **Enable / Disable DEE Debug Mode** replace the ambiguous *Toggle* in the tree (inline icon
  and context menu change with the row's state; the palette keeps *Toggle DEE Debug Mode*).
- **Group rows show their action count** (recursive) so large trees can be scanned without
  expanding; the tooltip spells it out.
- **Badge order** on action rows now follows urgency: `DEBUG · pending upload · not effective ·
  disabled · vN`.
- **Status bar shows the live debug-mode count** (`MES: local · 🐞 2`) with the action names in
  the tooltip — a forgotten registration keeps the host compiling from your file.
- **Open in MES UI** (context menu) deep-links to the action's page (`/Entity/Action/<Id>`).
- **Welcome view per state**: not connected (discover / add), environment without credentials
  (set credentials), and connected-but-empty (refresh / show log / fix token).
- Routine confirmations (**saved to MES**, **debug mode disabled**) moved from toasts to the
  status bar; decisions and failures still use notifications.
- **Draft (not-yet-effective) versions are now visible** in the DEE Explorer and in Sync
  (ADR 0011). An action whose only version is `Active` — which is what the MES UI wizard,
  `CreateAction`, and a first `CompileAndSave` all produce — used to be invisible until someone
  made it effective in the MES UI, so test users concluded the extension "cannot see all DEEs".
  Such rows carry a `not effective (Active)` badge and a warning-coloured icon; the tooltip
  explains that saving edits the draft. `deeDebugger.showDisabledActions` now governs
  **disabled** actions only. (GitHub #7)
- The tree and Sync represent each action by the **host's own rule** (effective version, else
  the highest live version) instead of "first row wins".

### Fixed
- **Sync: Upload of a new local DEE created an action that was disabled and not effective**,
  so it never appeared in the tree and the next compare still listed it as local-only
  ("cannot sync it to MES", GitHub #8). The payload now sends `IsEnabled: true` explicitly (the
  host reads a missing flag as `false`), and after the batch the extension offers to make the
  newly created version 1 effective.
- **Detach the debugger on shutdown.** The extension now tracks the coreclr attach sessions it
  starts and detaches them when it deactivates, so an abrupt window/WSL close can no longer leave
  `vsdbg` attached to the MES host with its request threads suspended (which made every `/api`
  call hang while the host still answered `/`). The request-timeout error now also hints that a
  leftover debugger may have the host suspended and to restart the host container. See roadmap M8.

## 0.1.0 — 2026-08-15

Initial release. A VS Code extension to browse, edit, sync, and debug Critical Manufacturing
MES customization C# — DEE Actions and custom business code — against a running MES host.

### Browse & edit
- **DEE Explorer** tree of Action Groups (dot-delimited hierarchy) and Actions from a live MES;
  open any action as a `.cs` file with full C# IntelliSense.
- **Edit & upload** action code back to the MES (`CompileAndSave`) with compile errors shown
  inline; save-as-new-version and version history.
- **Execute** actions ad hoc (read-only or full) and inspect decoded output.

### Debug
- **Live DEE debugging** — per-user Debug Mode compiles the action from your local file with
  debug symbols and hot-reloads on save.
- **Unified Attach to MES Host** — one command attaches the stock coreclr debugger and debugs
  **both** DEE Actions and compiled `Cmf.Custom.<tenant>.*` DLLs in a single session (merged
  source map: DEE temp folder + business `/src` root via `deeDebugger.hostSourceMap`).
- Works across every host topology: Docker, docker-in-docker devcontainers, remote Docker, WSL,
  Kubernetes, OpenShift, and local process. Offers to install `vsdbg` into the host when it is
  missing.
- **Patch Host for DEE Debugging (dev/test)** — applies the #158143 PortablePdb workaround so DEE
  debug mode works on Linux hosts; detects the host's .NET runtime major and adapts accordingly
  (MES 10 → .NET 6, MES 11 → .NET 8, MES 12 → .NET 10), with backup/restore.
- **Runtime-mismatch warning** on attach when the host .NET major differs from the local project's
  target framework.

### Connect & configure
- **Environments** — named connection profiles, each with its own securely-stored credentials
  (OS keychain via SecretStorage); auto-discovery, status-bar switching, and an auto-prompt for
  credentials on first activation.
- **Set Credentials** chooser — Personal Access Token or browser-copied access token (the method
  is always the user's choice).
- **Sync** DEEs in bulk (compare / download / upload) against the `Cmf.Custom.Data/DEEs` layout.

### Quality & safety
- No telemetry; secrets are never logged and are redacted from the output channel and the
  **Collect Support Bundle** diagnostic.
- Host-agnostic core with a thin VS Code adapter; decisions recorded as ADRs.
