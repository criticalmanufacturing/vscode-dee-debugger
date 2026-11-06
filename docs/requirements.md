# Requirements — DEE Debugger for VS Code

Derived from the old VS add-in feature set, the documented developer workflow, and the
host-side constraints of DEE compilation and debugging. "MUST" = parity with the old tool or a stated goal
of this project; "SHOULD" = high-value improvement; "COULD" = later.

## Personas & environments

- MES customization developer working in a devcontainer or on a workstation, with a local MES
  stack (`cmf dev local stack up`, host container `custom_host`) **or** a remote dev/test container.
- Developer has a local Actions csproj (cmf-cli `Cmf.Custom.Data/DEEs` layout) holding copies of
  the database DEEs for IntelliSense, diffing, and source control.
- Never used against production (debug mode + remote attach are privileged; surface warnings).

## F1 — Connection & authentication

- F1.1 MUST: configure MES host base address (e.g. `http://localhost`, `http://localhost:8084`,
  `https://mes.dev.example`). All calls: `POST {base}/api/DynamicExecutionEngine/{Method}` with
  `cmf_currentculture`, `cmf_returnfaultexceptions: false`.
- F1.2 MUST: authenticate with Access Token (Bearer) or Personal Access Token
  (`Basic base64(PAT + ":" + PAT)` — the Traefik forward-auth takes the token from the right of
  the colon, 11.0 → 12.0; verified live 2026-10-18). Tokens stored in VS Code SecretStorage;
  commands to set/clear.
  The credential method is always the user's choice (a chooser), never assumed.
- F1.3 SHOULD: friendly connectivity diagnostics (unreachable host, 401 expired token — with the
  documented steps to obtain a new one), non-blocking async everywhere.
- F1.4 SHOULD: multiple named environments (profiles); active one shown in the status bar.
  Switching/connecting to an environment with no stored credentials prompts for them.
- F1.5 COULD (deferred): obtain the token via a Security Portal **browser sign-in** flow instead
  of manual paste. A working implementation was built and removed (2026-08-15) because it cannot
  complete against current MES stacks — see ADR 0007 and `docs/upstream/workitem-3-*`; revisit
  once a public OIDC loopback client is registered upstream.

## F2 — DEE Explorer (tree view)

- F2.1 MUST: activity-bar view showing Action Groups as a dot-delimited hierarchy with Actions
  under each group (an action in N groups appears N times); ungrouped actions under the root.
  Data: `GetAllActionGroups` + `GetAllActions`, resolving `$id`/`$ref`.
- F2.2 MUST: show every action name the host reports, represented by the host's own rule
  (`GetAllActions` already returns at most one row per name — `GetAllActionsByFilterQuery`
  keeps the row with the highest `UniversalState`, then the highest `Version`; in practice the
  Effective version, else the highest Active one). Draft (non-effective) versions are **visible with a badge**, never
  filtered (ADR 0011; GitHub #7 — a freshly created DEE is `Active` v1 until promoted).
  Disabled actions are hidden by default behind a visible "N hidden" row + toggle; refresh
  command.
- F2.3 MUST: per-action state visible: debug mode (badge/color), pending local changes,
  enabled/disabled; details on selection (tooltip or details view): name, description,
  classification, version, modified by/on.
- F2.4 SHOULD: text filter/search (server has `SearchActionsAsDataSet`; client-side filter is fine
  first); show disabled actions toggle.
- F2.5 COULD: version history submenu (`GetActionVersionsAsDataSet`), enable/disable action,
  action-group parameter info (`GetActionGroupParameterInfo`) shown for groups.

## F3 — Download / edit / upload (single action)

- F3.1 MUST: open an action → `GetActionFullCode` → write `<ActionName>.cs` (server-generated
  wrapper with the four markers) into the configured working folder → open editor.
- F3.2 MUST: on save/upload command → extract the two marker bodies (empty bodies allowed) →
  `CompileAndSave`. Success feedback; compile errors mapped to VS Code diagnostics at the correct
  lines inside the marker regions (host errors are method-relative: "Action Code" scope → offset
  from action start marker, "Test Condition" → validation start marker).
- F3.3 MUST: reload action from server with lost-changes confirmation.
- F3.4 MUST: dirty tracking via `onDidSaveTextDocument`/`onDidChangeTextDocument` matched by
  exact file path (never suffix matching).
- F3.5 SHOULD: warn when markers are missing/duplicated before upload (client-side validation);
  detect the host rewriting the file (external change) and notify.
- F3.6 SHOULD: save-as-new-version option (`CompileAndSaveWithNewVersion` +
  `MakeActionVersionEffective`) — closes a real gap in the old tool.
- F3.7 COULD: execute/validate an action ad hoc with a JSON input dictionary
  (`ExecuteAction` / `ExecuteReadOnlyAction` / `ValidateAction`).
- F3.8 MUST (GitHub #8): **create a new action** from VS Code — `CreateAction` with the MES UI
  wizard's defaults (enabled, starter template, `return true;` validation), name validated as
  the host does (`^[a-zA-Z][a-zA-Z0-9_]*$`, ≤ 100 chars, unique), classification picker — and
  open it locally. The user chooses whether v1 is made effective immediately.
- F3.9 MUST (GitHub #7): **make a version effective** (`MakeActionVersionEffective`) from the
  tree, from version history, and as the follow-up offered after saving into a draft version.
  Only `Active` versions are promotable (host rule) — say so instead of failing.

## F4 — Debug mode & attach

- F4.1 MUST: toggle debug mode per action: `ActivateDebugMode { Action, SourceFilePath }` /
  `DeactivateDebugMode`. The `SourceFilePath` sent is a path **the host process can read**:
  - host kind `process` (host on this machine): the local file path;
  - host kind `docker`: stream the file into the container over exec stdin (never `docker cp`
    — ADR 0005) or use a configured bind mount, and send the container path; re-push on every
    local save while debug is on; pull back if the host rewrites it;
  - host kind `kubernetes`: same over `kubectl`/`oc exec` stdin.
- F4.2 MUST: attach command generating/starting a stock `coreclr` attach session:
  - `process`: process picker (`${command:pickProcess}`) for `Cmf.Foundation.Services.HostService`;
  - `docker`: `pipeTransport` over `docker exec -i <container>` (`--privileged -u 0` unless the
    exec user already holds CAP_SYS_PTRACE), host PID auto-resolved, `debuggerPath: /vsdbg/vsdbg`,
    `sourceFileMap: { <containerDeeDir>: <localDeeDir> }` merged with the business map
    (ADR 0009), `justMyCode: false`;
  - `kubernetes`: same over `kubectl exec` (no exec-level escalation; missing SYS_PTRACE is
    reported with the pod-spec fix).
- F4.3 MUST: ensure `vsdbg` exists in the container; offer one-click install (in-container
  `curl -sSL https://aka.ms/getvsdbgsh | bash /dev/stdin -v latest -l /vsdbg` — or `wget` — when
  the image has a downloader, otherwise local download streamed in over exec stdin; ADR 0005).
- F4.4 SHOULD: clear UX around the semantics: per-user, in-memory (lost on host restart), edits
  hot-reload on next execution without saving, Save persists for everyone; warn about load
  balancing (point at one instance).
- F4.5 SHOULD: on window close/deactivate, offer to deactivate any debug-mode actions left on
  (implemented without a prompt: `deactivate()` detaches our debug sessions and best-effort
  deactivates every registration against its own environment).
- F4.6 COULD: detect host restart (registration lost) and offer to re-activate debug mode.
- F4.7 MUST (test-user report 2026-10-18): before enabling debug mode on, or attaching to, a
  containerized host, **probe whether the host is patched for #158143** and prompt to patch when
  it is not — the compile failure otherwise happens inside the host, invisible to the extension,
  and the user only sees breakpoints that never bind. Blocking prompt for debug mode (with
  *Continue Anyway*), non-blocking for attach; cached per environment; opt-out setting.

## F5 — Sync with the local Actions project

- F5.1 MUST: bulk **download** into the configured local DEE folder — covered by the sync
  download flow (initial bootstrap: everything is MES-only → full generated wrappers, one
  `<ActionName>.cs` each; thereafter only changed bodies are written).
- F5.2 MUST: **diff**: compare local files vs server (marker bodies, whitespace-insensitive
  option), present a changed/added/removed report; open per-file diff editors.
- F5.3 MUST: **upload**: push selected/changed local files to the server via `CompileAndSave`,
  with a per-file result report (compile errors don't abort the batch). Local-only files
  CREATE actions: the payload must set `IsEnabled: true` explicitly (a missing flag is `false`
  on the host) and the user is offered to make the created v1 effective (GitHub #8).
- F5.4 SHOULD: respect/emit the cmf-cli conventions (skip `DeeDevBase.cs`, tolerate both marker
  dialects on read, configurable subfolder e.g. `ProcessRules/<version>/`). Amended by ADR 0012:
  scan subfolders and every DEEs folder (several Data packages); never rewrite or debug a
  `DeeDevBase`-format file directly (use a generated working copy with write-back); never
  overwrite a local file that has no valid markers.
- F5.5 COULD: conflict safety — detect server-side modifications since last download
  (`ModifiedOn`) before upload.

## F6 — Editor assistance (later)

- F6.1 COULD: completion/diagnostics backed by `GetAutoCompleteForAction` / `GetCodeCheckForAction`.
- F6.2 COULD: snippets for `UseReference`, ServiceProvider access, common DEE idioms.
- F6.3 SHOULD (cheap): the csproj + `DeeDevBase.cs` in the workspace already give C# IntelliSense
  via the C# extension; document this instead of building it.

## Non-functional

- N1: all network/file I/O async; never block the extension host; progress UI for long ops.
- N2: secrets only in SecretStorage; redact tokens from logs; output channel for diagnostics.
- N3: `src/core` is platform-agnostic (no `vscode` import) and unit-tested; VS Code layer thin.
  Target: potential future Visual Studio (VisualStudio.Extensibility) port reuses the spec/design.
- N4: works on Linux/WSL/macOS/Windows dev machines; container ops shell out to `docker`/`kubectl`.
- N5: minimum VS Code ^1.145; debugging requires the Microsoft C# extension (`ms-dotnettools.csharp`).
- N6: CI: lint + typecheck + unit tests + package `.vsix` on every push.

## Explicit non-goals (v1)

- No custom Debug Adapter Protocol implementation (stock coreclr attach does the job).
- No editing of action-group membership/ordering (use the MES UI).
- No production-environment safeguards beyond warnings.
- No Visual Studio port yet (tracked as a stretch goal; design keeps it possible).
