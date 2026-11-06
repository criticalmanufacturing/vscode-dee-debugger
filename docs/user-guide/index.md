# DEE Debugger for VS Code — User Guide

Develop Critical Manufacturing MES **DEE Actions** in VS Code, against a running MES —
with the full editor and a real debugger instead of the MES web UI's small code box.

**What it does:**

- **Browse** every DEE Action in the MES from a tree view.
- **Edit** any action as a normal `.cs` file, with full C# IntelliSense.
- **Upload** changes back to the MES — compile errors show inline in the editor.
- **Debug live** — set breakpoints and step through your action while the MES host runs
  it. *(The headline feature.)*
- **Sync** your whole action portfolio against a git-tracked customization project.

It works whether the MES host runs as a local Docker container, inside a devcontainer,
on a remote machine, in Kubernetes/OpenShift, or as a plain local process — and succeeds
the "Critical Manufacturing DEE Explorer" Visual Studio add-in, rebuilt for VS Code.

!!! info "What is a DEE Action?"
    A **DEE Action** (DEE = Dynamic Execution Engine) is a C# business rule stored in the
    MES **database**, not compiled into a customization DLL. Each attaches to an **Action
    Group** — an extension point like
    `MaterialManagement.MaterialManagementOrchestration.CreateMaterial.Pre` — and the host
    compiles and runs it on the fly when that operation happens. Because the code lives in
    the database, you'd normally edit it in the MES web UI; this extension gives you VS Code
    and a debugger instead.

!!! warning "Development and test environments only"
    The debugging and upload features are for **dev/test only**. Never attach a debugger to,
    or enable DEE debug mode on, a production MES.
    See the [FAQ](faq.md#can-i-use-this-against-production).

## How the guide is organized

| Page | Read it when you want to… |
|---|---|
| [Getting started](getting-started.md) | Install the extension and make your first connection (about 10 minutes) |
| [Tutorial: your first DEE debug session](tutorial-first-dee-debug.md) | Follow a guided 30-minute walkthrough from an empty VS Code window to a breakpoint hit |
| [Environments](environments.md) | Understand connection profiles, add or discover environments, and pick the right connection type for your setup |
| [Editing and uploading actions](editing-and-uploading.md) | Edit action code safely (the marker rules), save to the MES, create new versions, handle compile errors and conflicts |
| [Debugging DEE actions](debugging.md) | Understand how DEE debug mode works, attach the debugger, hit breakpoints, hot-reload code — and [attach to the host to debug compiled custom business DLLs](debugging.md#attaching-for-custom-business-debugging) |
| [Syncing with your local Actions project](sync.md) | Compare, download, and upload DEE actions in bulk against your git-tracked customization project |
| [How debugging works](how-debugging-works.md) | Client + host internals with diagrams — per-user semantics, host compile pipeline, multi-replica pinning |
| [Troubleshooting](troubleshooting.md) | Fix a specific symptom — including the expired-token problem — and collect a support bundle |
| [FAQ](faq.md) | Quick answers: per-user debugging, missing actions, versions, multiple users, performance |

## Where things live in VS Code

- **Getting Started walkthrough** — **DEE Debugger: Open Getting Started** (also Help →
  Welcome) walks through connect → authenticate → open → debug → sync with a button per
  step. The fastest first contact with the extension.
- **DEE Explorer** — the tree view in the **DEE Debugger** icon on the Activity Bar
  (left edge of the window). Its title bar holds **Refresh**, **New DEE Action…**,
  **Filter** and **Attach Debugger** (plus VS Code's own **Collapse All**); everything
  else (Switch Environment, Sync, Expand All, Show Disabled Actions, Show Output Log,
  Collect Support Bundle, Open Getting Started) is under the `…` menu. On a row, hover for the inline actions and right-click
  for the full menu, including **Open in MES UI**.
- **Command Palette** — press `Ctrl+Shift+P` (`Cmd+Shift+P` on macOS) and type
  "DEE Debugger" to see every command.
- **Status bar** — the `MES: <environment>` item shows which environment you are
  connected to (and how many actions are in debug mode); click it to switch. Routine
  confirmations such as *saved to MES* also appear there briefly.
- **DEE Debugger output channel** — **View → Output**, then pick **DEE Debugger** in
  the dropdown. This is the first place to look when something fails; see
  [Troubleshooting](troubleshooting.md#step-1-open-the-dee-debugger-output-channel).
