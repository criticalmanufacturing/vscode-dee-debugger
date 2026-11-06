# Smoke test against a live MES host

This is the developer's end-to-end check of the extension against a real MES host. The client
contract (endpoint shapes, error text, `$ref` metadata) was derived from the MES host's behavior;
this run confirms it and captures a fixture for anything that differs. Work through the phases
in order; each has an explicit expected result. **Use a scratch DEE action, never a real
business rule** — Phase 4 uploads code and Phase 5 registers debug mode.

## Status

| Date | Stack | Result |
|---|---|---|
| 2026-08-14 | MES 11.2.5, cmf-cli stack in a docker-in-docker devcontainer | **Passed** end to end: connect with a PAT, browse 72 actions / 132 groups, open, edit, save, debug mode, nested attach, breakpoint hit, hot reload. Fixes that came out of it: string entity ids, engine-command nesting, streaming files over exec, local vsdbg download, privileged attach pipe, host PID auto-detection, and the Linux debug-symbols product bug (worked around with the host patch). |
| 2026-08-15 | same | Save-as-new-version verified (staged v4 left the effective version untouched). A rejected PAT behind the forward-auth returns the login page with HTTP 200; the client now reports that as a rejected token. |
| 2026-10-18 | MES 12.0.0-beta.2, docker-in-docker devcontainer | Lifecycle calls verified with the core client in a scripted run: create action (draft v1), make version effective, create via sync upload, invalid-name fault. Found and fixed: the PAT must be on the **right** of the colon in the Basic header. The VS Code UI parts of that release still need the manual pass in `docs/qa/test-plan.md`. |

## Phase 0 — Prerequisites

1. A MES local stack (11.x or 12.x) running:
   ```bash
   docker ps --format '{{.Names}}' | sort
   ```
   Expected: `custom_host` (or `host`, on stacks that use that name), `traefik`, `db`, … If not:
   `cmf dev local stack up` in your customization project (see the getting-started guide on the
   [Developer Portal](https://developer.criticalmanufacturing.com)).
2. API reachable through Traefik:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' http://localhost/api/ping
   ```
   Expected: `200` (a `401`/redirect here is fine too — it proves routing; auth comes next).
3. A token, one of:
   - **Access Token**: log in to the MES UI (`http://localhost`, e.g. admin/admin) → DevTools →
     Network tab → perform any data action (open a Material) → copy the `Authorization: Bearer …`
     value of a POST request (without the `Bearer ` prefix). Valid ~14 days (1 h with Security
     Portal).
   - **PAT**: generate in the Security Portal → your user page → Personal Access Tokens.
4. Token sanity check from the terminal (this is exactly what the extension will call):
   ```bash
   TOKEN='<paste>'
   # access token
   curl -s -X POST http://localhost/api/DynamicExecutionEngine/GetAllActionGroups \
     -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
     -H "cmf_returnfaultexceptions: false" -d '{}' | head -c 400; echo
   # PAT: Basic auth with the token as the PASSWORD (the forward-auth reads the right of the colon)
   curl -s -u ":$TOKEN" -X POST http://localhost/api/DynamicExecutionEngine/GetAllActionGroups \
     -H "Content-Type: application/json" -H "cmf_returnfaultexceptions: false" -d '{}' | head -c 400; echo
   ```
   Expected: JSON starting with `{"ActionGroups":[…`. If you get HTML or a 302, the address is
   wrong or the forward-auth is redirecting to login (for a PAT: check it is on the right of the
   colon); if `401`, the token is bad or expired.
5. A scratch action to play with: MES UI → **Administration → DEE Actions** → create
   `SmokeTestDeeDebugger` (any classification, no action group needed), action code e.g.
   `Input["touched"] = 1;`, test condition `return true;`.
6. VS Code side: the **C# extension** (`ms-dotnettools.csharp`, or C# Dev Kit which includes it)
   must be installed — it provides the `coreclr` debugger and is a declared dependency; without
   it our extension won't activate. `docker` CLI must work from the same environment VS Code
   runs in (WSL: check `docker ps` inside WSL).

## Phase 1 — Launch and connect

1. In this repo: `npm install && npm run build`, then `F5` ("Run Extension"). An Extension
   Development Host window opens.
2. In the dev host window **open a folder** (your customization project if you have one — the
   extension auto-detects `DeeDevBase.cs`/`DEEs/*.csproj` as the DEEs folder — otherwise any
   empty test folder; files then go to `.dees/`). A workspace folder is required.
3. In the DEE Explorer's welcome view choose **Discover Environments** and connect to the
   discovered stack (or **Add Environment Manually**: address `http://localhost`, kind Docker,
   container `custom_host`). Connection settings live only in environments.
4. When prompted, **Set Credentials…** → paste the token (PAT or access token; the chooser
   stores it in the right slot).
5. Command palette → **DEE Debugger: Test Connection**.
   - ✅ "Connected to http://localhost successfully."
   - ❌ Check the **DEE Debugger** Output channel; see Troubleshooting below.

## Phase 2 — Browse

1. Activity bar → DEE Debugger icon → **Refresh**.
2. Expected: hierarchical tree (e.g. `MaterialManagement › MaterialManagementOrchestration › …`)
   with actions as leaves; your `SmokeTestDeeDebugger` under the root (it has no group).
3. Verify against the MES UI: action names match Administration → DEE Actions. Drafts
   (not-yet-effective versions) are shown with a `not effective` badge; disabled actions are
   hidden behind a *"N disabled actions hidden"* row — click it to compare totals.
4. **Contract check**: if the tree is empty but Phase 0.4 returned data, the response envelope
   differs from expectations — copy the raw JSON from the Phase 0.4 curl into
   `test/fixtures/` and file the difference (likely `$values` wrapping or field casing).

## Phase 3 — Open (download path)

1. Click `SmokeTestDeeDebugger` in the tree.
2. Expected: a `SmokeTestDeeDebugger.cs` file opens from the DEEs folder containing usings, a
   `RuleEvaluator_…` class, and your code between the four
   `/** START/END OF USER-DEFINED [VALIDATION] CODE **/` markers.

## Phase 4 — Upload path (Compile & Save)

1. Inside the action-code markers, add a harmless line (`Input["smoke"] = 2;`), save the file.
   Tree shows *pending upload*.
2. Click the cloud-upload icon on the action's row (**Save Action to MES (Compile & Save)**;
   also in the Command Palette).
   Expected: a status-bar message *saved to MES* and the *pending upload* badge clears. Confirm
   the change in the MES UI DEE editor.
3. Now break it on purpose: add `var oops = ;` inside the markers, save, upload again.
   Expected: error notification + entries in the **Problems** panel pointing at (or very near)
   the broken line.
4. **Contract check — highest-risk area**: the host reports errors method-relative in the form
   `[Action Code][file] [Line N,C] Error: …` and we re-map them. If squiggles land on the wrong
   line or in the wrong region, copy the raw payload from the Output channel and paste it into a
   new case in `test/errorMap.test.ts` — fix the regex/offsets there, not by hand-tweaking in
   the debugger.
5. Remove the broken line, save, upload — clean again.

## Phase 5 — Debug mode + attach (the point of the whole thing)

1. Right-click `SmokeTestDeeDebugger` → **Enable DEE Debug Mode**.
   Expected: on an 11.x host a prompt to patch the host for DEE debugging appears first (accept
   it; the host restarts); then a **DEBUG** badge, a bug icon with `1` in the status bar, and
   the *Attach the debugger now?* dialog. Verify the push landed in the container:
   ```bash
   docker exec custom_host ls -lR /tmp/CriticalManufacturing/dee-debug/
   ```
   Expected: `SmokeTestDeeDebugger.cs`, under the same relative path it has in the workspace.
2. Choose **Attach Debugger** in the dialog (or run **DEE Debugger: Attach Debugger to MES
   Host** later). First run: the one-time prerequisites primer — choose **Attach**. Next it detects `vsdbg` is
   missing in the container and offers to install it. The Output channel then shows the ptrace
   preflight (`[attach] ptrace probe: …`);
   on a MES 12 stack the container has no `CAP_SYS_PTRACE`, so the pipe uses
   `docker exec --privileged -u 0`; on an 11.x stack generated by a current cmf-dev template
   `SYS_PTRACE` is granted and the pipe stays unprivileged (`docker exec -i`). The host PID is resolved automatically; if a picker still
   appears, pick the `dotnet` process running `Cmf.Foundation.Services.HostService.dll`.
3. Set a breakpoint on your line inside the action-code markers. It may show as hollow (unbound)
   — that's expected until the debug-compiled assembly loads on first execution.
4. Trigger the action **as the same user your token belongs to** (debug registration is
   per-user!). For a group-less scratch action, from the terminal:
   ```bash
   curl -s -X POST http://localhost/api/DynamicExecutionEngine/ExecuteAction \
     -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
     -H "cmf_returnfaultexceptions: false" \
     -d '{"Action":{"Name":"SmokeTestDeeDebugger"},"Input":{}}'
   ```
   (For a grouped action, perform the hooked operation in the MES UI, logged in as that user.)
5. Expected: **the breakpoint hits**, with locals (`Input`) inspectable and the editor showing
   your local file.
6. Hot-reload check: while debug mode is on, change the code inside the markers (e.g. set a
   different value), save — status bar flashes "DEE: pushed … to host" — re-run the curl.
   Expected: new behavior executes **without** Compile & Save, and the breakpoint still binds.
7. **Disable DEE Debug Mode**. Re-run the curl: the DB version (Phase 4 state) executes again.
8. Clean up: delete `SmokeTestDeeDebugger` in the MES UI if you're done with it.

## Devcontainer / docker-in-docker stacks (the common cmf-cli setup)

When the MES stack was started with `cmf dev local stack up` **inside a project devcontainer**,
the stack runs on a docker daemon *inside* that devcontainer. Symptoms from outside (e.g. a
WSL-hosted extension dev window): `docker ps` shows only the `vsc-…` devcontainer, and
`http://localhost/api/ping` refuses connections — nothing is wrong with the stack.

Settings that make it work from outside the devcontainer:

1. Find the devcontainer's name and IP (outer shell):
   ```bash
   docker ps --format '{{.Names}}\t{{.Image}}'          # e.g. romantic_curran  vsc-cmf-io-…
   docker inspect <name> --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
   ```
2. Verify the API through the devcontainer IP: `curl -s -o /dev/null -w '%{http_code}' http://<ip>/api/ping` → `200`.
3. Create the environment with **Add Environment Manually** → type **Docker-in-docker
   (devcontainer)**: address `http://<devcontainer-ip>`, devcontainer name `<devcontainer-name>`,
   container `custom_host` (cmf-cli stacks name it this, not `host`). The resulting profile
   carries `engineCommand: ["docker", "exec", "-i", "<devcontainer-name>", "docker"]`.

All container operations (debug-file push, vsdbg, attach pipe) then nest through the
devcontainer automatically. Caveats:
- The devcontainer *name* is random per rebuild and the *IP* can change on restart — re-check
  both after rebuilding, or pin a name via `devcontainer.json` → `runArgs: ["--name", "…"]`.
- The MES 11.x host image has no curl/wget; the vsdbg installer detects this and falls back to
  downloading locally and streaming the tarball in (needs local bash+tar — WSL/Linux/macOS).
  The 12.0 host image has curl, so there the download runs inside the container.
- Alternative: run this repo's extension dev host *inside* the devcontainer — then localhost,
  plain `docker`, and container name are all direct and `engineCommand` stays empty.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Extension doesn't activate in dev host | `ms-dotnettools.csharp` not installed (declared dependency). |
| Test Connection: "Could not reach" | Wrong `hostAddress`; stack down; from WSL, use the address that works for `curl` in the same shell. |
| HTTP 401/403 (`Www-Authenticate: Bearer error="invalid_token"`) | Token expired — **Security Portal stacks expire access tokens after 1 hour** (14 d only without it) — or truncated when copied from DevTools (use right-click → Copy value; JWTs are 1–2 KB). Prefer a PAT (Security Portal → user page → Personal Access Tokens). Setting a PAT clears the stored access token; but an access token set *after* a PAT takes precedence over it — run *Clear Credentials* in that case. Always prove a token with the Phase 0 curl before blaming the extension. |
| "returned a login page instead of data" | Response was HTML — the forward-auth rejected the token (or wrong port/path); verify Phase 0.4. |
| "returned unparseable JSON" | Response was neither JSON nor HTML — wrong address; verify Phase 0.4. |
| Tree empty, curl returns data | Envelope mismatch — capture JSON to `test/fixtures/`, fix `mesClient`/`jsonRefs`. |
| `spawn docker ENOENT` / `docker: not found` on toggle/attach | docker CLI not on PATH of the VS Code (dev host) environment. |
| Process picker empty / attach fails | vsdbg install failed (on 11.x hosts, which have no curl/wget, the local download runs: it needs internet plus bash + tar on your machine; on 12.0 hosts the container itself needs internet); or the environment points at the wrong container. On Kubernetes the pod spec must grant SYS_PTRACE — the preflight says so before attaching. |
| Attach: `Unknown Error: 0x80131c08` | Wrong process picked (PID 1 may be the native `CmfEntrypoint` wrapper — pick the `dotnet Cmf.Foundation.Services.HostService.dll` child). Ptrace rights are handled by the preflight: the pipe runs `docker exec --privileged -u 0` unless the exec user already has `CAP_SYS_PTRACE`; `kernel.yama.ptrace_scope=3` on the Docker host is reported as blocking. Read the `[attach] ptrace probe:` line in the Output channel. |
| Breakpoint never binds | Action not executed since activation; executed by a *different user* than the token; load balancer sent the call to another host instance — point `hostAddress` at one instance directly. |
| Executing a debug-mode action fails: "code is invalid … Unexpected error writing debug information -- 'Value cannot be null. (Parameter 'type')'" | **MES host bug (#158143), Linux hosts up to 11.x**: the host compiles debug-mode actions requesting a Windows-native PDB, which Roslyn can't emit on Linux. Run **Patch Host for DEE Debugging (dev/test)…** (the enable-debug prompt offers it when the probe finds the host unpatched); MES 12 images already contain the fix. |
| API timeouts right after attaching / while debugging | The debugger is stopped (breakpoint hit, pause, or exception) — a .NET stop suspends the **entire** host process, so the MES UI, curls, and tree refreshes all time out. This is expected; press Continue (F5) and retry. |
| Breakpoint binds but opens a read-only file | `sourceFileMap` mismatch — the local DEEs folder moved after activation; disable and re-enable debug mode to re-register, or check the environment's `sourcePathInHost`. |
| Local file suddenly changed on disk | The host rewrote it (its regenerated wrapper differed — e.g. hand-edited usings). Expected behavior; use `UseReference(...)` instead of `using`. |

## Exit criteria

All phases green, or: every deviation captured as a fixture/raw payload in the Output channel
and turned into a failing unit test in `test/` before fixing the code.
