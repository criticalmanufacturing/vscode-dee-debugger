# DEE Debugger for Critical Manufacturing MES

[![License: BSD-3-Clause](https://img.shields.io/badge/License-BSD--3--Clause-blue.svg)](LICENSE.md)
![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.90-007ACC.svg)
![Telemetry](https://img.shields.io/badge/telemetry-none-brightgreen.svg)

**Develop, edit, sync and *debug* Critical Manufacturing MES customization C# — DEE Actions
and custom business code — from VS Code, straight against a running MES host.** Set a
breakpoint, trigger the action, and step through the code the host is actually executing.

Successor to the "Critical Manufacturing DEE Explorer" Visual Studio add-in, rebuilt for VS
Code with first-class support for containerized hosts (local Docker, docker-in-docker
devcontainers, remote Docker, WSL, Kubernetes, OpenShift, or a local process).

<!-- TODO(release): replace with a short demo GIF — DEE Explorer → open action → breakpoint hits.
     A GIF must be captured from a live Extension Development Host (F5); it can't be generated. -->

```text
 DEE EXPLORER                          Tutorial_MyFirstDee.cs
 ───────────────────────────          ───────────────────────────────────────
  ● Connected · local                   /** START OF USER-DEFINED CODE … **/
  ▸ MaterialManagement         12     ● 12   Input["greeting"] = "hi";  ← breakpoint hit
  ▸ QA                          3            Input["touched"]  = 1;
    Tutorial_MyFirstDee  DEBUG · v1     /** END OF USER-DEFINED CODE … **/

 MES: local · 🐞 1                     Variables: Input = {…}
```

## Features

- **DEE Explorer** — browse Action Groups (dot-delimited hierarchy) and Actions from a live
  MES, and open any action as a normal `.cs` file with full C# IntelliSense.
- **Edit & upload** — save action code back to the MES (`CompileAndSave`), with compile errors
  shown inline in the editor and the Problems panel, on the right lines.
- **Create & publish** — **New DEE Action…** creates an action the way the MES UI wizard does and
  opens it; draft (not-yet-effective) versions are shown with a badge and can be promoted with
  **Make Version Effective** without leaving VS Code. **Open in MES UI** jumps to the action's
  page for group membership and the rest of the admin UI.
- **Live DEE debugging** — enable per-user Debug Mode and the host compiles the action **from
  your local file** with debug symbols; **hot-reload** on every save.
- **Debug custom business DLLs too** — one **Attach Debugger to MES Host** command debugs
  *both* DEE Actions and your compiled `Cmf.Custom.<tenant>.*` assemblies in the same session
  (it merges the source maps). If vsdbg is missing from the host, the extension offers to
  install it.
- **Works with any host topology** — Docker, docker-in-docker (devcontainers), remote Docker,
  WSL, Kubernetes (`kubectl`), OpenShift (`oc`), or a local process. Local Docker,
  docker-in-docker and local-process stacks are discovered automatically.
- **Sync with your Actions project** — bulk compare / download / upload DEEs against the
  cmf-cli `Cmf.Custom.Data/DEEs` layout, ready to commit to git.
- **Environments** — named connection profiles, each with its own securely-stored credentials,
  switchable from the status bar.
- **No telemetry** — talks only to the MES host you configure.

## Requirements

- **VS Code 1.90+**.
- The **Microsoft C# extension** (`ms-dotnettools.csharp`) — installed automatically as a
  dependency; it provides the .NET debugger.
- A **development / test** MES instance you're allowed to change (e.g. a local
  `cmf dev local stack up` stack), and — for containerized hosts — the `docker` CLI on the
  machine VS Code runs in.

> ⚠️ **Development and test environments only.** Debugging attaches to and can pause the whole
> MES host; never attach a debugger to, or enable DEE debug mode on, a production MES.

## Quick start

1. **Install** the extension (`code --install-extension dee-debugger-<version>.vsix`, or from a
   CI build) and open your customization project folder (the one containing
   `Cmf.Custom.Data/DEEs`). Trust the workspace when prompted.
2. **Connect** — click the **DEE Debugger** icon → **Discover Environments** → pick your stack
   → **Connect**.
3. **Authenticate** — the **Set Credentials…** chooser opens on its own; choose a **Personal
   Access Token** (recommended) or a browser-copied **Access Token**.
4. **Debug** — open an action, toggle **DEE Debug Mode**, **Attach Debugger to MES Host**, set a
   breakpoint, and trigger the action.

Inside VS Code, **DEE Debugger: Open Getting Started** opens a six-step walkthrough with a button
for each step. The longer [tutorial](docs/user-guide/tutorial-first-dee-debug.md) takes you from
an empty window to a breakpoint hit in ~30 minutes.

## Extension settings

| Setting | Description |
|---|---|
| `deeDebugger.environments` | Named environment profiles — the only connection configuration |
| `deeDebugger.activeEnvironment` | Which environment is in use (empty = not connected) |
| `deeDebugger.deesFolder` | DEEs folder, or a list of them (e.g. `Cmf.Custom.Data/DEEs`); subfolders are included and the first is where new files go. Auto-detected when empty (one per Data package) |
| `deeDebugger.hostSourceMap` | Maps the build root recorded in custom business PDBs to your repo — only needed when the DLL was built at a different path (default `/src` → your repo root, for container builds) |
| `deeDebugger.showDisabledActions` | Show disabled actions in the explorer (draft / not-yet-effective versions are always shown, with a badge) |
| `deeDebugger.attachAfterEnablingDebug` | After enabling debug mode: `ask` (default) whether to attach, `always` attach, or `never` ask |
| `deeDebugger.hostPatchCheck` | `prompt` (default) probes a containerized host for the #158143 PDB patch before debug mode / attach and offers to patch; `off` skips the probe |
| `deeDebugger.hostAppDir` | Folder inside the host container that holds `Cmf.Foundation.Common.dll`, used by **Patch Host for DEE Debugging** (default `/opt/app`) |
| `deeDebugger.expectedDotnetMajor` | Expected .NET major of the host for the attach-time mismatch warning; `0` (default) infers it from your local `Cmf.Custom.*` project |

Credentials are stored per environment in the OS keychain via VS Code **SecretStorage** —
never in settings files, never logged.

## Documentation

- [User guide](docs/user-guide/index.md) — getting started, environments, editing, debugging,
  [DEE vs business debugging](docs/user-guide/dee-vs-business-debugging.md), sync, troubleshooting, FAQ
- [Architecture](docs/architecture.md) · [Decision records](docs/adr/) · [Roadmap](docs/roadmap.md)

## Privacy

The extension collects **no telemetry**. It communicates only with the MES host you configure;
tokens live in the OS keychain (VS Code SecretStorage) and are never logged. Run **Collect
Support Bundle…** for a reviewable, secret-redacted diagnostic to attach to a support ticket.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup (`npm install` / `npm run build`
/ `npm test`, F5 for the Extension Development Host) and the architecture ground rules. Report
security issues privately per [SECURITY.md](SECURITY.md).

## License

BSD 3-Clause, © Critical Manufacturing — the same license as
[cmf-cli](https://github.com/criticalmanufacturing/cli). See [LICENSE.md](LICENSE.md). The
extension has **zero Node runtime dependencies**. It bundles one third-party component:
[Mono.Cecil](https://github.com/jbevain/cecil) (MIT), used only by the optional *Patch Host
for DEE Debugging* helper that runs inside the MES host container — see
[NOTICE.md](NOTICE.md).
