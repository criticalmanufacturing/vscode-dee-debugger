# Tutorial: your first DEE debug session

From an empty VS Code window to a breakpoint hit inside a running MES — in about
30 minutes. Each part ends with a **Checkpoint**; don't move on until it holds, and if
it doesn't, the linked troubleshooting row will unblock you.

**You need before starting:**

- A **development** MES stack you're allowed to play with (e.g.
  `cmf dev local stack up` in your customization project) — never a shared or
  production instance.
- VS Code 1.145+ and a working `docker` CLI
  (details: [Getting started — what you need](getting-started.md#what-you-need)).
- A MES login that can open **Administration → DEE Actions** in the MES UI.

---

## Part 1 — Install and open a workspace (≈ 5 min)

1. Install the extension: in the Extensions view, search for **DEE Debugger** and select
   **Install**, or run
   `code --install-extension CriticalManufacturing.dee-debugger --pre-release`. The
   Microsoft C# extension installs alongside it as a dependency. Offline, use the VSIX
   ([Getting started — Step 1](getting-started.md#step-1-install-the-extension)).
2. Open a folder — ideally your customization project (the one with
   `Cmf.Custom.Data/DEEs`); any empty folder also works for this tutorial.
3. If VS Code asks about Workspace Trust, choose **Trust**.

**Checkpoint 1:** the **DEE Debugger** icon is on the Activity Bar, and clicking it
shows the "Connect to a development or test MES" welcome view with a **Discover
Environments** button. (Prefer a guided tour? **DEE Debugger: Open Getting Started**
mirrors Parts 1–5 as a VS Code walkthrough.)
*(No icon? → [extension doesn't activate](troubleshooting.md#extension-or-tree-problems).)*

## Part 2 — Create a scratch action to play with (≈ 5 min)

Never learn on a real business rule. In the MES web UI:

1. Log in (on a local stack: `http://localhost`) and go to
   **Administration → DEE Actions**.
2. Create a new action named `Tutorial_MyFirstDee` — any classification, **no action
   group needed**. (Action names may contain only letters, digits and underscores, and
   must start with a letter — no dots.)
3. Action code: `Input["touched"] = 1;`
   Test condition: `return true;`
4. Save it.

**Checkpoint 2:** `Tutorial_MyFirstDee` exists in the MES UI's DEE Actions list.

## Part 3 — Connect (≈ 5 min)

1. In the DEE Explorer's welcome view, click **Discover Environments** and wait for
   the probe to finish.
2. Select your stack (reachable ones are pre-checked) and choose **Connect**.
   *(Nothing found? Your topology needs a manual profile — detour to the
   [connection decision tree](environments.md#which-connection-type-am-i-decision-tree),
   then come back.)*
3. When prompted for credentials, the extension asks how you'd like to authenticate.
   Use a **Personal Access Token** if your Security Portal offers them (user security page →
   **Personal Access Tokens**), via **Set Personal Access Token…**. Otherwise copy an access
   token from the browser
   ([how](getting-started.md#copying-an-access-token-from-the-browser)) — noting it will
   [expire in 1 hour](troubleshooting.md#expired-tokens-the-1-hour-problem)
   on Security Portal stacks, which is fine for this tutorial.

**Checkpoint 3:** the tree shows a **Connected · \<environment\>** row (green plug icon), action
groups underneath, and `Tutorial_MyFirstDee` near the root (it has no group — group
names nest as folders, ungrouped actions sit at the root). The Status Bar shows
**MES: \<environment\>**.
*(Tree empty or errors? → [Connection problems](troubleshooting.md#connection-problems).)*

## Part 4 — Open, edit, upload (≈ 5 min)

1. Click `Tutorial_MyFirstDee` in the tree. A file `Tutorial_MyFirstDee.cs` opens:
   generated `using`s, a wrapper class, and your two code snippets between marker
   comments.
2. Read this once, it's the golden rule:
   **only edit between the START/END markers** — the wrapper is server-owned and edits
   to it get discarded and can cost you work
   ([the marker contract](editing-and-uploading.md#the-marker-contract-what-you-may-and-may-not-edit)).
3. Inside the **USER-DEFINED CODE** markers, add a line:

   ```csharp
   Input["greeting"] = "hello from vs code";
   ```

4. Save the file (`Ctrl+S`). Notice the action's **pending upload** badge in the tree —
   the MES is *not* updated yet.
5. Hover the action in the tree and click its cloud-upload icon (**Save Action to MES
   (Compile & Save)**; also in the Command Palette). Expect a brief *saved to MES*
   message in the status bar and the **pending upload** badge to clear.
6. See what failure looks like, so you recognize it later: add a broken line inside
   the markers (`var oops = ;`), save, upload again. The upload fails and the
   **Problems** panel points at the broken line. Delete the line, save, upload —
   clean again.

**Checkpoint 4:** the MES UI's DEE editor shows your `greeting` line in
`Tutorial_MyFirstDee`, and the Problems panel is empty.
*(Upload failed without a compile error? → likely the
[expired token](troubleshooting.md#expired-tokens-the-1-hour-problem).)*

## Part 5 — Debug it (≈ 10 min)

Mental model in one sentence: debug mode makes the host compile **your file** with
debug symbols **for your user only**, hot-reloading on every save — colleagues and the
stored version are untouched
([full model](debugging.md#the-mental-model)).

1. **Linux host prerequisite** (MES 11 and older containerized stacks): the host must
   emit cross-platform debug symbols; unpatched hosts fail with a "writing debug
   information" error due to a known product bug. You don't need to check this yourself:
   when you enable debug mode the extension probes the host and, if needed, offers
   **Patch Host for Debugging** (one click, the host restarts). MES 12 images already
   contain the fix. Details:
   [the Linux prerequisite](debugging.md#linux-mes-hosts-the-pdb-prerequisite).
2. Right-click `Tutorial_MyFirstDee` → **Enable DEE Debug Mode** (or the bug icon on
   the row). A **DEBUG** badge appears (the row icon turns into a bug), the status bar
   shows `🐞 1`, and a dialog asks whether to attach the debugger now — its text explains
   the semantics.
3. Choose **Attach Debugger**. The very first attach shows a one-time dialog listing the
   prerequisites — choose **Attach**. On a fresh container, accept the offer to install
   the debugger (`vsdbg`) — this takes a minute. The extension then attaches to the MES host
   process (if a picker appears, choose the `dotnet` process running
   `Cmf.Foundation.Services.HostService.dll`).
4. Set a breakpoint on your `Input["greeting"] = …` line (click in the gutter). A
   hollow circle is normal — it binds when the action first executes.
5. Trigger the action: right-click it in the tree → **Execute Action…** → keep the
   input as `{}` → choose a **read-only** execution.

**The breakpoint hits.** The editor jumps to your line; inspect `Input` in the
Variables pane, hover variables, step with `F10`.

6. While paused, notice the freeze: the MES UI and API don't respond — a stopped
   debugger suspends the whole host
   ([why](debugging.md#while-you-are-paused-everything-freezes)). Press **Continue**
   (`F5`) to let it finish; the execution report opens with your output values. Continue
   within a minute: the extension gives up on a MES request after 60 seconds, and
   **Execute Action…** then reports a failure instead of opening the report.
7. Feel the hot reload: **without** any upload, change the greeting text, save
   (`Ctrl+S` — the status bar flashes "DEE: pushed"), and run **Execute Action…**
   again. The breakpoint hits with the **new** value — the MES database still holds
   the old code.

**Checkpoint 5:** you've hit a breakpoint twice, the second time on code you never
uploaded.
*(Breakpoint never hit? → [debugging problems](troubleshooting.md#debugging-problems) —
the top cause is triggering the action as a different user than your token's.)*

## Part 6 — Clean up (≈ 2 min)

1. Right-click the action → **Disable DEE Debug Mode** to turn debug off — the stored
   version takes over again (the `🐞` count in the status bar disappears).
2. Disconnect the debugger (the plug icon on the debug toolbar).
3. If you want the greeting change kept, it's already on the MES from Part 4's upload
   flow — otherwise upload your final state, or delete `Tutorial_MyFirstDee` in the
   MES UI.

## Where to go next

- [Editing and uploading](editing-and-uploading.md) — versions, conflicts, and the
  full save semantics.
- [Sync](sync.md) — bring your whole DEE portfolio under git.
- [Environments](environments.md) — add your team's shared dev/test instances.
