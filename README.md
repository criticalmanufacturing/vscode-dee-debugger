# DEE Debugger for Critical Manufacturing MES

[![License: BSD-3-Clause](https://img.shields.io/badge/License-BSD--3--Clause-blue.svg)](LICENSE.md)
![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.145-007ACC.svg)
![Telemetry](https://img.shields.io/badge/telemetry-none-brightgreen.svg)

Edit and debug Critical Manufacturing MES **DEE Actions** and custom business code in VS Code,
against a running MES host. Set a breakpoint, trigger the action, and step through the code the
host runs. Successor to the DEE Explorer add-in for Visual Studio.

<!-- TODO(release): add a short demo GIF — DEE Explorer → open action → breakpoint hits.
     A GIF must be captured from a live Extension Development Host (F5); it can't be generated. -->

## Features

- **Browse and edit** DEE Actions as `.cs` files with C# IntelliSense. Compile errors show
  inline when you upload.
- **Debug live**: DEE Actions and your `Cmf.Custom.*` business DLLs in one debug session.
- **Any host**: Docker, devcontainers, remote Docker, WSL, Kubernetes, OpenShift, or a local
  process.
- **Sync** DEEs with your cmf-cli project (`Cmf.Custom.Data/DEEs`) and commit them to git.

## Requirements

- VS Code 1.145 or later. The Microsoft C# extension installs automatically.
- A development or test MES you can change, such as a `cmf dev local stack up` stack.
- For containerized hosts, the `docker` CLI.

> ⚠️ **Development and test only.** Debugging can pause the whole MES host. Never use it on a
> production MES.

## Quick start

1. Download the VSIX from GitHub Releases or from a
   [CI build](https://github.com/criticalmanufacturing/vscode-dee-debugger/actions/workflows/ci.yml)
   (artifact `dee-debugger-vsix`), and install it:

   ```bash
   code --install-extension dee-debugger-<version>.vsix
   ```

2. Open your customization project, the folder that contains `Cmf.Custom.Data/DEEs`.
3. Select the **DEE Debugger** icon, then **Discover Environments**, pick your stack, and
   **Connect**. When asked for credentials, use a **Personal Access Token**.
4. Open an action, turn on **DEE Debug Mode**, run **Attach Debugger to MES Host**, set a
   breakpoint, and trigger the action.

For a guided walkthrough, run **DEE Debugger: Open Getting Started**, or follow the
[30-minute tutorial](docs/user-guide/tutorial-first-dee-debug.md).

## Learn more

- [User guide](docs/user-guide/index.md): environments, editing, debugging, sync,
  troubleshooting.
- Settings: **Settings > Extensions > DEE Debugger**.
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

BSD 3-Clause © Critical Manufacturing. See [LICENSE.md](LICENSE.md) and [NOTICE.md](NOTICE.md).
The extension sends no telemetry and talks only to the MES host you configure.
