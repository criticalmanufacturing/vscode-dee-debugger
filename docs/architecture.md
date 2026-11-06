# Architecture — DEE Debugger for VS Code

## Layering

```
┌────────────────────────────────────────────────────────────┐
│ src/vscode  (VS Code adapter; tested via stub + headless e2e)
│  extension.ts        activation, wiring, migration, statusbar
│  explorer.ts         TreeDataProvider (info rows, filter)
│  commands.ts         command handlers (open/save/debug/sync/env)
│  settings.ts         env-resolved config + per-env secrets
│  session.ts          per-action working state (SessionStore)
│  debugAttach.ts      attach orchestration, vsdbg install
│  fileBridge.ts       runCli + exec-stream file transport
│  debugFileWatcher.ts host-rewrite detection while debugging
│  discovery.ts        environment probing (docker/dind/process)
│  sync.ts             compare/upload/download flows + diff docs
│  localDees.ts        recursive DEE-file index, .dee-debug working-copy folder (ADR 0012)
│  diagnostics.ts      compile-error → DiagnosticCollection
│  hostPatch.ts        #158143 patcher stream/run, probe, restore, restart
│  logging.ts          SupportLogger: timestamps, redaction, ring buffer
├────────────────────────────────────────────────────────────┤
│ src/core  (platform-agnostic, fully unit-tested, no 'vscode')
│  mesClient.ts        typed REST client for the DEE endpoints
│  jsonRefs.ts         Json.NET $id/$ref/$values resolution
│  deeFile.ts          marker codec: extract/validate/replace
│  treeModel.ts        dot-hierarchy builder + filtering
│  actionVersions.ts   representative-version rule, draft/effective, create-action rules (ADR 0011)
│  errorMap.ts         host compile-error → file line mapping
│  syncPlan.ts         local-folder vs server diff/plan
│  localDees.ts        which local file an action uses, working-copy and host paths (ADR 0012)
│  hostExec.ts         all container-exec argv builders + attach
│  env.ts              environment profiles + built-in defaults
│  discovery.ts        docker-ps parsing / candidate assembly
│  cmfData.ts          CMFMap wire-value decoding
│  jwt.ts              token classification (PAT vs Bearer)
│  businessAttach.ts   business source-map resolution, unbound-bp heuristics (ADR 0008/0009)
│  hostPatch.ts        #158143 patch planning, probe/output interpretation (ADR 0010)
│  dotnetRuntime.ts    host vs local .NET major detection + mismatch text
│  redact.ts           secret scrubbing for logs, errors, support bundle
│  types.ts            Action, ActionGroup, DTOs, HostTarget
└────────────────────────────────────────────────────────────┘
```
Contract fixtures: test/fixtures/*.json — real MES 11.2.5 and 12.0.0-beta.2 payloads asserted
by test/contracts.test.ts (the cross-IDE source of truth per ADR 0003).

Rules: `src/core` imports no `vscode` API (lint-enforced) and performs no process/file I/O —
it exposes pure argv/payload builders and codecs; the vscode layer owns all I/O (`runCli`,
`fs`). See ADR 0003 + its 2026-08-15 amendment. `src/vscode` contains no business logic
beyond UI concerns.

## Key flows

### Open action
`explorer click/command` → `mesClient.getActionFullCode(action)` → write
`<workFolder>/<ActionName>.cs` → open editor → register path→action mapping (exact path match).

### Save/upload
command (editor context or explorer) → `deeFile.extractBodies(text)` (validates markers; empty
bodies OK) → `mesClient.compileAndSave(action)` → on failure `errorMap.parseHostErrors` +
`mapErrorsToFile` →
diagnostics inside the marker regions.

### Debug mode (the interesting one)
```
toggleDebug(action)
 ├─ ensure local file exists (open flow)
 ├─ hostPath = fileBridge.publish(localPath)      # identity for 'process' kind;
 │            exec-stream (stdin cat) → <sourcePathInHost>/<Action>.cs for containers (ADR 0005)
 ├─ mesClient.activateDebugMode(action, hostPath)
 ├─ while debug ON: onDidSaveTextDocument(localPath) → fileBridge.publish (re-push)
 │                  DebugFileWatcher polls host md5 → pull back if host rewrites the file
 └─ deactivate → mesClient.deactivateDebugMode + stop watching
    (window close → deactivate() best-effort DeactivateDebugMode for leftover sessions)
```
Host mechanics (see research): with debug ON the host recompiles from `hostPath` on every
execution of that action for the calling user, emitting a PDB whose document path = `hostPath`
with embedded source. Therefore the attach configuration (built in `core/hostExec.ts`, host
PID auto-resolved) maps `hostPath` dir → local dir; the exec is `--privileged -u 0` unless the
container already grants CAP_SYS_PTRACE — cmf-dev's MES 12 stack template grants no `CAP_SYS_PTRACE` to `host` (its 10.x–11.x templates add `SYS_PTRACE`, older generated 11.x stacks may not) (see the security note below):

```jsonc
{ "type": "coreclr", "request": "attach", "processId": <resolved host PID>,
  "pipeTransport": { "pipeProgram": "docker",
                     "pipeArgs": ["exec","--privileged","-u","0","-i","custom_host"],
                     "debuggerPath": "/vsdbg/vsdbg", "pipeCwd": "${workspaceFolder}",
                     "quoteArgs": false },
  "justMyCode": false,
  "sourceFileMap": { "<sourcePathInHost>": "<workspace folder>",   // ADR 0012: relative paths mirrored
                     "/src": "${workspaceFolder}" } }   // business map (ADR 0009, deeDebugger.hostSourceMap)
```
With a nested `engineCommand` (docker-in-docker etc.) the pipeArgs are prefixed accordingly;
only the innermost exec is privileged. Because the PDB embeds the source, breakpoints can
also bind via embedded source; the `sourceFileMap` keeps the experience on the user's
editable file.

Security note: `--privileged -u 0` grants the vsdbg process full capabilities *inside the
target container only*; it is required for ptrace under Yama on stacks without `SYS_PTRACE`
(all MES 12 stacks from the cmf-dev template) and is
acceptable because debug/attach are restricted to dev/test environments by policy. The `-u 0`
is not optional: the product host image runs as uid 1001 and a non-root `docker exec
--privileged` has an empty effective capability set (verified on Docker 28.5), so without it
vsdbg is refused by Yama on every stack that does not override `user: root`. A one-exec
preflight (`ptraceProbeArgs` → `decideAttachPrivilege`) downgrades to an unprivileged exec
when the exec user already holds CAP_SYS_PTRACE, turns a missing capability on Kubernetes into
the exact pod-spec fix (no exec-level escalation exists there), and refuses to attach when
`kernel.yama.ptrace_scope` is 3. The
`engineCommand` mechanism executes a user-configured argv locally — environments are
therefore *executable configuration* and must be treated with tasks.json-level trust
(see the supportability/trust hardening in reviews 01/02).

Default `sourcePathInHost` for containers: `/tmp/CriticalManufacturing/dee-debug` (host user is
root in local-stack debug overrides; the exact temp path the host itself uses is
process-randomized, so we always *send* our own path and never guess the host's).

### Sync
`syncPlan.buildSyncPlan(localFiles, serverDees)` compares marker bodies (both dialects readable) →
entries with status `unchanged | modified | localOnly | serverOnly` (no server-side conflict
detection; a stale concurrency token surfaces as a 409 at upload) → UI applies with per-item
results.

## Error handling & UX conventions

- Every server call goes through one wrapper (`MesClient.invoke`: 60 s timeout, one
  status/duration log line); `showError` adds hints — 401/403 → "token expired" guidance,
  network failure while a debug session is active → "host paused by the debugger", timeout →
  "leftover debugger may have the host suspended"; a 200 HTML body → "login page" (token
  rejected). Details go to the Output channel ("DEE Debugger"), never a modal per item in
  batch operations.
- Long operations use `withProgress`; all I/O async.
- Marker validation before any upload; refuse with a precise message rather than uploading
  truncated code (the old tool silently truncated on marker damage).

## Security

- Tokens in `SecretStorage`; never written to settings/logs. PAT sent only as Basic auth header.
  Two credential kinds share the per-environment secret scope: an access token (Bearer) and a
  PAT (Basic); the user picks which via the *Set Credentials* chooser. (A browser OIDC sign-in
  tier is designed but deferred — see ADR 0007.)
- *Attach*, *Patch Host* and *Restore Host DLL* ask for modal confirmation when the host
  address is not local (localhost, `::1`, 127.x, the 172.16–31.x docker bridge range, or
  `*.local`) — privileged operations, dev/test only per product docs. Enabling debug mode does
  not show this warning.

## Testing strategy

- vitest unit tests for everything in `src/core` (codec round-trips incl. empty bodies and both
  marker dialects, $ref resolution, tree building incl. multi-group membership, error mapping
  offsets, sync planning).
- VS Code layer: vitest tests against a `vscode` stub (`test/mocks/vscode.ts`, aliased in
  `vitest.config.ts`) for command/explorer/attach flows, plus a headless `@vscode/test-cli`
  e2e suite (`test-e2e/`, `npm run test:e2e`: activation, command and view registration,
  environment switching) run in CI; manual F5 for the remaining interaction flows.
- Contract fixtures: JSON payloads captured from real MES 11.2.5 and 12.0.0-beta.2 hosts live
  in `test/fixtures` (add as they're captured; keep them anonymized).

## Future Visual Studio port

Kept feasible by: (a) all protocol/file-format/flow knowledge lives in docs + `src/core` with no
editor coupling; (b) VS 2022 side would be a VisualStudio.Extensibility tool window + the same
REST contract; the debug story there is plain "Attach to Process/Docker" which VS already has.
No shared runtime code is planned (C# vs TS) — shared *spec* is the deliverable.
