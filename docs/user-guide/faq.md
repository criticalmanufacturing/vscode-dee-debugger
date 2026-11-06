# FAQ

## Debugging

### If I enable debug mode, does it affect my colleagues?

No. DEE debug mode is **per user**: the MES host runs *your* local file's code only
for operations executed under *your* user account. Everyone else keeps executing the
stored database version, at full speed, with no idea you're debugging. The database
version doesn't change until you explicitly run **Save Action to MES**.

Two caveats on shared instances:

- While you're **paused at a breakpoint**, the whole host process is suspended — the
  MES freezes for everyone until you continue. Pause briefly.
- **Save Action to MES** (as opposed to just saving the file) publishes for everyone —
  know [which save you're doing](editing-and-uploading.md#the-three-ways-to-save).

### Why does my breakpoint never hit, even though the action runs?

Because debug mode is per-user, the execution must happen **as the user your token
belongs to**. The classic miss: your token is for user A (say, the account whose PAT
you generated), but you trigger the operation in the MES UI logged in as user B — B's
execution runs the stored version, and your breakpoint stays cold. Trigger the
operation logged in as the token's user, or use **Execute Action…** in VS Code (which
always runs as your token's user).

Other causes, in order of likelihood: the action simply hasn't executed yet since you
enabled debug mode (breakpoints show hollow and bind on first execution); a load
balancer routed the execution to a different host instance; the host restarted and
forgot the registration. Details in
[Troubleshooting](troubleshooting.md#debugging-problems).

### Do I need to upload before debugging my changes?

No — that's the point. With debug mode on, saving the file (`Ctrl+S`) is enough: the
host compiles your file on the next execution. **Save Action to MES** is only for
publishing the finished change to everyone.

### Can I use this against production?

**Never.** Debug mode and debugger attach are development/test tools:

- A breakpoint pause **stops the entire MES** for all users.
- Attaching a debugger to the host process is highly privileged.
- Debug mode changes which code executes for your user — on production data.

The extension warns before attaching to non-local addresses, but the real safeguard is
you: keep production environments out of your environment list entirely.

## The tree and filtering

### Why don't I see all actions in the tree (or in Sync)?

The DEE Explorer shows **every action the MES reports**, one row per action — the same
list as Administration → DEE Actions. Two things can still make a row disappear:

- **Disabled actions** are hidden by default. When any are hidden the tree shows a
  *"N disabled actions hidden — click to show"* row; click it (or run **Toggle Show
  Disabled Actions**, or set **deeDebugger.showDisabledActions**) to reveal them.
- A **text filter** is active: a filled filter icon in the DEE Explorer's title means one
  is — click it and clear the text to restore the full tree.

Actions whose current version is **not yet effective** (a draft) are *not* hidden — they
carry a `not effective (Active)` badge. Sync always covers every action the MES
reports, including disabled actions and drafts.

### I created a DEE — does it run before I make it effective?

Yes. A newly created action is stored as **version 1 in state Active, not effective**,
and the MES runs the effective version or, when none is effective, the **highest**
version — so v1 runs. The `not effective` badge still matters: until a version is
effective, a version staged later (**Save as New Version…**) takes over immediately.
Right-click → **Make Version Effective** (or the ✓ inline icon) fixes the version that
runs. **New DEE Action…** asks this up front, and a Sync upload that creates actions offers
it at the end of the batch.

If a new action doesn't run at all, check that it is **enabled** and belongs to an
**action group** — membership is configured in the MES UI.

### Why does the same action appear more than once?

An action can belong to several action groups; it appears under each of them. It's the
same action — editing or toggling debug from any of its entries affects all of them.

## Versions and collaboration

### What's the difference between "Save to MES" and "Save as New Version"?

**Save Action to MES (Compile & Save)** overwrites, in place, the version you are working
on — the one you opened (effective, or the draft when none is effective), or the version
you last created with **Save as New Version…**. When that version is a draft you are
offered **Make Effective**; the message says whether the MES runs that draft (it does
when no other version is effective). **Reload Action from
MES** returns you to the version shown in the tree.
**Save Action to MES as New Version…** creates a new version and lets you choose
whether it becomes effective immediately — the previous version stays in the history
as a rollback point. Use new versions for significant changes on shared environments.
**Show Version History…** lists every version (effective one marked) and can diff any
of them against your local file. See
[versioning semantics](editing-and-uploading.md#the-three-ways-to-save).

### Two of us edited the same action — what happens?

Whoever uploads second gets a conflict dialog: the action changed on the MES since
they loaded it, with the choice to **Overwrite** or cancel and reconcile first. Bulk
sync uploads similarly refuse entries that changed server-side since your last
compare. Nothing is silently lost — but agree with your team on who owns an action, or
use new versions. Details:
[concurrency conflicts](editing-and-uploading.md#concurrency-conflicts-someone-else-changed-it).

### Can several people debug on the same dev instance?

Yes — debug registrations are per (user, action), so two developers can debug
different (or even the same) actions with their own files, each seeing only their own
code changes. The shared limits: only one debugger can be attached to the host process
at a time, and anyone's breakpoint pause freezes the instance for all.

## Practicalities

### Where do the .cs files go? Do I have to commit them?

Into your workspace's DEEs folder — auto-detected (every folder containing
`DeeDevBase.cs`, or every folder named `DEEs` that contains a `.csproj`), configurable via
**deeDebugger.deesFolder** (one folder or a list), falling back to a `.dees/` folder. Existing
files are used where they are, subfolders included; only new actions are downloaded, into the
first folder. `DeeDevBase`-format files get a working copy under `.dee-debug/`, which is never
committed (see [working copies](editing-and-uploading.md#deedevbase-files-working-copies)). Committing them is optional but recommended: with the
standard Actions project you get IntelliSense, reviewable diffs, and the
[sync workflow](sync.md#a-typical-git-workflow).

### Is the tool slow with big environments?

Loading the tree takes two requests (all groups and all actions), sent in parallel.
Environments with thousands of actions take a few seconds to refresh but stay
responsive (loading is in the background). Use **Filter Actions…** rather than scrolling; opening, uploading,
and debugging single actions is unaffected by environment size. If a refresh feels
stuck while a debug session is active, remember a
[paused host](troubleshooting.md#debugging-problems) answers nothing.

### Where are my tokens stored? Is anything sent anywhere?

Tokens live in your operating system's secure credential store (via VS Code's secret
storage), scoped per environment — never in settings files or your repo. This covers both
credential kinds: a browser-copied access token and a Personal Access Token. The extension
collects **no telemetry** and talks only to the MES hosts you configure.
Logs and the [support bundle](troubleshooting.md#when-youre-stuck-collect-support-bundle)
automatically redact credentials.

### Does it work on Windows / macOS / Linux / WSL?

Yes — anywhere VS Code and (for containerized hosts) the `docker` CLI work. The one
platform note concerns installing the debugger (`vsdbg`) into the host. When the host
container has no `curl` or `wget` — true of MES 11.x host images; MES 12 images have
`curl` — the extension downloads `vsdbg` locally and streams it in, which needs local
`bash` and `tar`. That path isn't available on plain Windows without WSL. One current limitation: in a multi-root workspace, only the first
folder is searched for the DEEs project.
