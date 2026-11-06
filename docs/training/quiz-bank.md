# Quiz Bank — DEE Debugger for VS Code

All knowledge-check questions from Modules 1–7 (41 questions, for LMS import and
retakes) plus a 10-question **scenario-based final assessment**. Answers and
rationales are keyed [at the end](#answer-key) — do not distribute that section to
learners taking the assessment. Passing per the
[completion criteria](course-overview.md#completion-criteria): ≥ 80% per module
check; ≥ 80% on the scenario section if used as a final assessment.

---

## Module 1 — Orientation

**1.1** Where does the source code of a DEE Action live?
- A. In the customization project's compiled DLL
- B. In the MES database, compiled on the fly by the MES host
- C. In a `.cs` file inside the host container image
- D. In the extension's workspace storage

**1.2** What is an Action Group?
- A. A folder of `.cs` files in the customization project
- B. A set of users allowed to edit an action
- C. An extension point (e.g. `…CreateMaterial.Pre`) to which actions are attached and executed by the MES
- D. A VS Code workspace concept

**1.3** Which of these is NOT one of the four extension surfaces in VS Code?
- A. The DEE Explorer tree view
- B. The `MES: <environment>` status bar item
- C. The DEE Debugger output channel
- D. A dedicated "DEE" panel in the terminal area

**1.4** Why must debug mode and debugger attach never be used against production? (pick the BEST answer)
- A. The extension is not licensed for production
- B. A paused debugger suspends the entire MES host, and debug mode alters which code executes for your user on live data
- C. Production databases reject the CompileAndSave call
- D. Breakpoints cannot bind on production builds

**1.5** An action appears twice in the DEE Explorer tree, under two different groups. What does that mean?
- A. There are two copies of the action; edit each separately
- B. It is one action that belongs to both groups — editing or toggling debug from either entry affects both
- C. A rendering bug — refresh the tree
- D. One entry is the effective version, the other is a draft

## Module 2 — Install, connect, authenticate

**2.1** Why does the extension require the Microsoft C# extension?
- A. It renders the DEE Explorer tree
- B. It provides the .NET debugger the extension uses
- C. It stores the tokens
- D. It compiles actions before upload

**2.2** On a standard local development stack (with Security Portal), how long does a browser-copied access token last?
- A. Until VS Code restarts
- B. About 14 days
- C. 1 hour
- D. It never expires

**2.3** Where does the extension store your tokens?
- A. In `settings.json`, base64-encoded
- B. In the workspace's `.vscode` folder
- C. In the OS keychain via VS Code SecretStorage, per environment
- D. In the MES database

**2.4** You paste a PAT into the *Set Access Token…* prompt by mistake. What happens?
- A. Authentication fails until you clear credentials
- B. The extension recognizes it and stores it as a PAT, telling you so
- C. The token is rejected as malformed
- D. It is stored as an access token and expires in 1 hour

**2.5** *Discover Environments* finds nothing, but your MES runs in a Kubernetes cluster. What is the correct conclusion?
- A. The stack is down
- B. Your token is wrong
- C. Discovery only probes local topologies — create a manual environment for the cluster
- D. Reinstall the extension

**2.6** After connecting, where do ungrouped actions (no action group) appear in the tree?
- A. They are hidden until you enable a setting
- B. Under a special "Ungrouped" folder
- C. At the root of the tree
- D. They cannot exist — every action needs a group

## Module 3 — Environments

**3.1** From outside the devcontainer, `docker ps` shows only one container, whose image is `vsc-myproject-a1b2…`. Which connection type is correct?
- A. Docker (local)
- B. Docker-in-docker (devcontainer)
- C. Docker (remote)
- D. Local process

**3.2** What is the default MES host container name on cmf-cli scaffolded stacks?
- A. `host`
- B. `mes_host`
- C. `custom_host`
- D. `traefik`

**3.3** An environment stores both an access token and a PAT. Which is used?
- A. The PAT, because it is long-lived
- B. The access token
- C. Whichever was stored last
- D. The extension asks each time

**3.4** After a devcontainer rebuild, a previously working environment cannot connect. Most likely cause?
- A. The PAT expired
- B. The devcontainer's auto-generated name (and possibly IP) changed
- C. The MES database was wiped
- D. VS Code lost the SecretStorage entries

**3.5** Why does the extension refuse to run in untrusted workspaces?
- A. VS Code requires it for all extensions
- B. Downloaded `.cs` files could contain malicious code
- C. A workspace could plant an environment whose `engineCommand` executes arbitrary commands on your machine
- D. Tokens cannot be stored in untrusted workspaces

**3.6** You rename an environment in Manage Environments…. What happens to its stored token?
- A. It is deleted; you must set it again
- B. It follows the new name automatically
- C. It stays under the old name and must be migrated manually
- D. It is copied to all environments

## Module 4 — Editing and uploading

**4.1** You add `using MyCompany.Helpers;` above the first marker and upload. What reaches the MES?
- A. The whole file including your `using`
- B. Only the marker bodies — your `using` line is not uploaded, and a later host rewrite will erase it locally
- C. The upload is refused
- D. The `using` is converted to a `UseReference` automatically

**4.2** With debug mode OFF, what does Ctrl+S do?
- A. Compiles and saves on the MES
- B. Saves locally only; the MES is untouched and the tree shows a pending upload badge
- C. Creates a new version
- D. Pushes the file into the host container

**4.3** When is *Save Action to MES as New Version…* the right choice?
- A. Never — it duplicates data
- B. For significant changes on shared environments: it preserves a rollback point and can stage a version without making it effective
- C. Only when the upload would otherwise conflict
- D. When you want the change visible to your user only

**4.4** Your upload is refused: "the action was changed on the MES since it was loaded". Which statement is true?
- A. Your local changes were discarded
- B. The server version was overwritten by yours
- C. Nothing was changed anywhere yet — you choose Overwrite (your bodies win) or Cancel (reconcile first)
- D. The MES merged both versions

**4.5** What's the correct recovery for damaged markers (upload refused with a marker error)?
- A. Retype the marker line by hand
- B. Copy your body code out, run Reload Action from MES, paste your code back inside the markers
- C. Delete the file and re-download
- D. Upload with force

**4.6** What distinguishes read-only from full in *Execute Action…*?
- A. Read-only skips the validation block
- B. Read-only runs the code without persisting side effects and needs no confirmation; full behaves like the real operation and confirms first
- C. Read-only runs the stored version, full runs your local file
- D. Full is only available with debug mode on

## Module 5 — Debugging

**5.1** Debug mode is ON for an action; a colleague (different MES user) triggers the hooked operation. What runs for them?
- A. Your local file, with your breakpoints active
- B. The stored database version, completely unaffected by your debug mode
- C. Nothing — the action is locked while you debug
- D. Your file, but without breakpoints

**5.2** With debug mode ON, what does Ctrl+S do beyond saving locally?
- A. Nothing extra — you must still Compile & Save
- B. Pushes the file to the host so your NEXT execution compiles and runs it — the database version is untouched
- C. Publishes the change to all users
- D. Creates a new version automatically

**5.3** Your breakpoint shows as a hollow circle right after attaching. What does it mean?
- A. The symbol format is wrong — apply the PDB patch
- B. Normal: the debug-compiled assembly loads when the action first executes; the breakpoint binds and hits then
- C. The breakpoint is outside the markers
- D. vsdbg is not installed

**5.4** Executing a debug-mode action on a Linux host fails with "Unexpected error writing debug information -- 'Value cannot be null. (Parameter 'type')'". What is it, and what fixes it?
- A. A syntax error in your action — fix the code
- B. A known product bug in the host's debug-symbol format — run **Patch Host for DEE Debugging** (offered automatically when the host is unpatched)
- C. An expired token — set a new PAT
- D. Wrong container name in the environment

**5.5** Someone recreated the stack overnight. Which pair of recovery steps applies to your debugging setup?
- A. Nothing — debug registrations persist in the database
- B. Re-apply the PDB patch (writable layer wiped) and accept the extension's offer to re-enable debug mode (in-memory registration lost)
- C. Reinstall the extension and re-create the environment
- D. Only re-attach the debugger; everything else survives

**5.6** While you are stopped at a breakpoint, a colleague reports the MES UI is not responding. What is the correct reading?
- A. The stack crashed — restart the host
- B. Expected: a stopped debugger suspends the entire host process; press Continue and it resumes
- C. The load balancer failed over
- D. Their token expired

## Module 6 — Sync

**6.1** A local file differs from the MES only in trailing spaces at line ends and in line endings (CRLF vs LF). What does Compare report?
- A. Differ — every byte counts
- B. In sync — trailing whitespace and line-ending differences are ignored
- C. Local-only
- D. A merge conflict

**6.2** During a sync download, one selected file is open in an editor with unsaved changes. What happens to it?
- A. The disk file is overwritten; the editor shows a conflict
- B. The editor buffer is updated in place
- C. The entry is skipped, counted as a failure, and named in the summary
- D. The download aborts entirely

**6.3** In a 10-file sync upload, file 4 has a compile error. What is the outcome?
- A. The batch stops at file 4
- B. All 10 are rolled back
- C. The other files upload; file 4 is reported as failed, with its errors in the Problems panel
- D. File 4 is uploaded without compiling

**6.4** You start *Sync: Upload Local Changes to MES*; while its picker is open, a colleague saves a change to action X on the MES. You then confirm the upload with X selected. What happens?
- A. Your version silently overwrites theirs
- B. The entry fails; the summary lists it and the output log says to run Compare again — you re-compare, review, then re-upload
- C. An automatic merge is attempted
- D. The whole batch is refused

**6.5** Which of these does sync transfer between your repo and the MES?
- A. Action code (marker bodies) only
- B. Action group membership
- C. Evaluation order
- D. Enabled/effective flags

**6.6** Why do downloaded updates to existing files keep your local file's layout and update only marker bodies?
- A. Performance — writing less is faster
- B. So version-control diffs show only real rule changes, keeping reviews minimal
- C. Because the server does not send the wrapper
- D. To avoid recompiling the wrapper locally

## Module 7 — Troubleshooting

**7.1** *Test Connection* fails with "Could not reach the MES host at …". Which class of problem is it, and which is ruled out?
- A. Authentication problem; connectivity ruled out
- B. Connectivity/address problem; it is not (yet) a token issue
- C. Compile problem
- D. A damaged marker

**7.2** A valid PAT has been stored for weeks. This morning you pasted a browser access token with *Set Access Token…*; an hour later every call fails with 401. Most likely cause?
- A. PATs don't work on Security Portal stacks
- B. The stored access token takes precedence over the PAT and has now expired — set the PAT again (that removes the access token), or Clear Credentials and set the PAT
- C. The stack is down
- D. The PAT must be set per action

**7.3** Mid-debug-session, tree refreshes start failing with "could not reach the MES host". First thing to check?
- A. The token expiry
- B. Whether you are paused at a breakpoint — the suspended host answers nothing; Continue (F5) and retry
- C. The devcontainer IP
- D. Whether vsdbg is installed

**7.4** Refresh fails with "returned unparseable JSON". What does that indicate?
- A. The MES database is corrupted
- B. The address answered something that is not the MES API (wrong port or sub-path) — fix the environment's base URL
- C. Your action has a syntax error
- D. The output channel is full

**7.5** What does the support bundle contain about your token?
- A. The full token, encrypted
- B. Nothing at all
- C. Metadata only — type and expiry — never the token itself
- D. The last four characters

**7.6** The DEE Explorer shows fewer actions than Administration → DEE Actions. Which TWO checks resolve it? (pick the answer listing both)
- A. Restart VS Code; reinstall the extension
- B. Clear the text filter (filled filter icon) and/or click the "N disabled actions hidden" row
- C. Clear Credentials; re-add the environment
- D. Re-apply the PDB patch; re-attach

---

## Final assessment — scenario questions

Cross-module reasoning; use for the final assessment or the instructor-led wrap-up.

**S1.** At 09:00 a developer connects with a browser-copied access token and works
happily. At 10:05, *Save Action to MES* fails; refreshing the tree fails; editing the
local file still works. She restarts the stack; now her earlier debug registration is
gone too, but the save still fails. What single root cause explains the 10:05
failures, and what did the restart cost her?
- A. The stack was down; the restart fixed it
- B. Her access token expired at the 1-hour mark (auth failures on every server call); the restart was unnecessary and additionally cleared her in-memory debug registration
- C. Damaged markers; the restart regenerated the wrapper
- D. The devcontainer IP changed; the restart renewed it

**S2.** A developer enables debug mode on `Sales.CreateOrder.Pre`, attaches, sets a
breakpoint (hollow), then asks a tester to create an order in the MES UI so "we can
step through it". The tester's order is created; the breakpoint stays hollow and
never hits. Why, and what is the fastest correct way to hit it?
- A. The PDB patch is missing; re-apply and retry
- B. Debug mode is per-user — the tester's execution ran the stored version; trigger it yourself, e.g. via Execute Action…, which always runs as your token's user
- C. The breakpoint is outside the markers; move it
- D. vsdbg attached to the wrong process; re-attach

**S3.** During a debug session, a developer edits her action, saves, and sees
*DEE: pushed…*. Minutes later she notices the file content on disk **reverted** to a
wrapper that no longer contains a `using` she had added near the top of the file.
What happened?
- A. Sync download overwrote her file
- B. She edited outside the markers (the hand-added `using`); the host regenerated its wrapper and the extension pulled the rewrite over her out-of-marker edit — `UseReference(...)` inside the markers is the supported way
- C. A colleague uploaded over her version
- D. Git checkout reverted the file

**S4.** Two developers, separate MES accounts, one shared dev instance. Dev A has
debug mode on action X and is stepping at a breakpoint. Dev B, mid-demo to a
customer, finds the MES UI frozen. Dev B's own debug registration on action Y is
untouched. Which statements are BOTH true?
- A. A's debug mode changed the code B executes, and the freeze is a crash
- B. The freeze is A's breakpoint pause suspending the whole host process, and B's executions of X (when the host resumes) still run the stored version — registrations are per user
- C. B must clear credentials, and A must re-apply the PDB patch
- D. Only one registration can exist per instance, so B's was dropped

**S5.** After the nightly `cmf dev local stack down && up`, a developer's morning
debug session fails: executing the action in debug mode returns "Unexpected error
writing debug information — 'Value cannot be null. (Parameter 'type')'", and the
extension reported "debug mode was lost" on first refresh. Which recovery sequence is
complete and correctly ordered?
- A. Re-attach the debugger; everything else is automatic
- B. Accept the patch prompt / run Patch Host for DEE Debugging (recreate reverted the container's writable layer), re-enable debug mode (in-memory registration lost), re-attach — expect the vsdbg install offer again on the fresh container
- C. Clear Credentials, set a new PAT, refresh
- D. Recreate the environment profile; the old one is bound to the dead container ID

**S6.** A team lead wants DEE changes reviewed in pull requests. A developer edits
five actions over a sprint using the single-action loop and publishes each with
Compile & Save. To produce the PR, he runs Sync: Compare, downloads two actions a
colleague changed via the MES UI, commits, and opens the PR. The diff shows only
marker-body line changes across seven files. Which course concepts does this workflow
depend on? (pick the complete set)
- A. Hot reload and the vsdbg fallback
- B. Layout-preserving downloads, whitespace-tolerant compare, the DEEs-folder git baseline, and sync's code-only scope
- C. Save-as-new-version and the version history diff
- D. Dirty-editor protection and the support bundle

**S7.** A developer moves from her local stack to the team's shared test cluster
(Kubernetes) to reproduce a bug. She adds a kubectl environment, switches to it, and
her breakpoints on the shared cluster sometimes hit and sometimes don't, though she
triggers every execution herself. The cluster runs three host replicas behind a load
balancer. What is happening, and the sanctioned fix while debugging?
- A. Her token intermittently expires; use a PAT
- B. Her debug registration and attach live on one host instance, but the balancer routes some executions to other instances running the stored version — point the environment directly at a single instance while debugging
- C. Kubernetes pods drop vsdbg on each request; reinstall it
- D. The PDB patch only applied to one replica; patch is per-cluster

**S8.** During an upload, a developer gets the conflict dialog: the action changed on
the MES since she loaded it. She knows her change is important but has no idea what
the other change is. Ranked by safety, which is the BEST next step the tooling
offers?
- A. Overwrite — her wrapper will merge with theirs
- B. Cancel, inspect via Show Version History… / a sync diff, then either re-apply on top or use Save as New Version… so both states are preserved
- C. Toggle debug mode to bypass the conflict
- D. Delete the local file and re-download

**S9.** A new team member reports: "The extension is broken — no DEE Debugger icon at
all." You learn he opened a single `.cs` file directly (no folder), clicked "Don't
Trust" on a prompt earlier, and his machine has no Marketplace access so the C#
extension never installed. How many independent problems must he fix before he can
work with the extension?
- A. One — the trust prompt
- B. Two — trust and the missing C# extension
- C. Three — no folder open, untrusted workspace, and the missing required C# extension
- D. None — the icon only appears after connecting

**S10.** A support ticket reads: "Debugging stopped working." The attached support
bundle shows: token type PAT (not expired), environment kind docker with engineCommand
`["docker","exec","-i","elegant_hopper","docker"]`, and an engine probe reporting the
host container NOT reachable because there is no container `elegant_hopper`. The user
mentions "IT rebuilt my devcontainer yesterday". What do you tell them?
- A. Regenerate the PAT
- B. The devcontainer's auto-generated name changed on rebuild, so the environment's engine command targets a container that no longer exists — update name (and possibly IP) via Manage Environments…, and pin the name in devcontainer.json to prevent recurrence
- C. Re-install vsdbg
- D. The PDB patch reverted; re-apply it

---

## Answer key

*Instructor/LMS use only.*

### Module questions

| Q | Answer | Rationale (one line) |
|---|---|---|
| 1.1 | B | DEE actions are database-stored rules the host compiles at execution time. |
| 1.2 | C | Groups are MES extension points; their dot-delimited names become the tree hierarchy. |
| 1.3 | D | The four surfaces: tree, Command Palette, status bar item, output channel — no terminal panel. |
| 1.4 | B | The guide's two reasons: whole-host suspension and privileged, behavior-altering access. |
| 1.5 | B | One action can belong to several groups and is listed under each; still a single action. |
| 2.1 | B | `ms-dotnettools.csharp` supplies the coreclr debugger; declared dependency. |
| 2.2 | C | Security Portal stacks expire access tokens after 1 hour — the most common failure. |
| 2.3 | C | Per-environment secrets in the OS keychain via SecretStorage; never in settings. |
| 2.4 | B | Pasted tokens are auto-classified; a PAT is rerouted to PAT storage with a message. |
| 2.5 | C | Discovery probes local Docker, docker-in-docker devcontainers, local processes only. |
| 2.6 | C | Ungrouped actions sit at the root; group names nest as folders. |
| 3.1 | B | Only the devcontainer (image `vsc-…`) visible = the stack runs on a daemon inside the devcontainer. |
| 3.2 | C | `custom_host` is the cmf-cli default; some stacks use `host`. |
| 3.3 | B | Access token takes precedence. Setting a PAT clears the access token, so "both stored" means an access token was set after the PAT. |
| 3.4 | B | Devcontainer names regenerate on rebuild, IPs can change on restart. |
| 3.5 | C | `engineCommand` executes locally; trust is the gate against hostile planted profiles. |
| 3.6 | B | Rename migrates stored credentials automatically; only removal wipes them. |
| 4.1 | B | Only marker bodies upload; the wrapper is server-owned and regenerated. |
| 4.2 | B | Plain save is local-only (pending badge); publishing needs Save Action to MES. |
| 4.3 | B | New versions preserve rollback points and can be staged non-effective. |
| 4.4 | C | The conflict dialog is a refusal; nothing changes until you choose. |
| 4.5 | B | Copy-out → Reload Action from MES → paste-in restores a pristine wrapper. |
| 4.6 | B | Read-only persists nothing (no confirmation); full is real and confirms first. |
| 5.1 | B | Debug registration is per-user; other users run the stored version. |
| 5.2 | B | Hot reload: save pushes to the host for your next execution; the DB is untouched. |
| 5.3 | B | Unbound-until-first-execution is normal; it binds when the debug assembly loads. |
| 5.4 | B | MES 11.x Linux hosts request the Windows-only PDB format; the patch fixes it once per container (until a stack recreate). |
| 5.5 | B | Recreate loses the patch (writable layer) and the registration (host memory). |
| 5.6 | B | A stopped debugger suspends the entire host — expected .NET behavior. |
| 6.1 | B | Compare ignores line endings, trailing whitespace and leading/trailing blank lines (not indentation changes). |
| 6.2 | C | Dirty-editor protection skips, counts as a failure, and names the file. |
| 6.3 | C | Batch upload continues past failures; diagnostics land on the right files. |
| 6.4 | B | Upload compares first; an entry changed on the MES after that comparison is refused individually with a re-compare note. |
| 6.5 | A | Sync moves code only; membership, order, flags are MES-UI/Data-package matters. |
| 6.6 | B | Layout preservation + whitespace tolerance keep git/PR diffs minimal. |
| 7.1 | B | Test Connection splits reach vs auth; "could not reach" is connectivity. |
| 7.2 | B | Access-token-over-PAT precedence: a token set after the PAT shadows it, even after it expires; setting the PAT again removes it (or Clear Credentials first). |
| 7.3 | B | A paused host answers nothing; Continue and retry. |
| 7.4 | B | Non-JSON where JSON was expected = wrong address (port/path). An HTML login page gets its own "returned a login page" message instead. |
| 7.5 | C | Bundles carry token metadata (type, expiry) only; credentials are redacted. |
| 7.6 | B | Hidden disabled actions (announced by a clickable row) and text filters are the two visibility causes; drafts stay visible with a badge. |

### Scenario questions

| Q | Answer | Rationale |
|---|---|---|
| S1 | B | Classic 1-hour expiry: every server call fails, local edits work. The restart fixed nothing (401 ≠ reachability) and cleared her in-memory debug registration — a pure loss. |
| S2 | B | Per-user debug mode: the tester's execution runs the stored version. Execute Action… runs as the token's user, making it the reliable trigger. The hollow breakpoint was simply never bound because *her* file never executed. |
| S3 | B | Out-of-marker edits are not uploaded and are destroyed when the host regenerates the wrapper and the extension pulls the rewrite; `UseReference(...)` inside the markers is the supported mechanism. |
| S4 | B | Pause = whole-host suspension for everyone (freeze); per-(user, action) registrations mean B never executes A's file. Both facts are core Module 5 consequences. |
| S5 | B | A recreate wipes the writable layer (patch gone, vsdbg gone) and host memory (registration gone): re-patch, re-enable, re-attach with a fresh vsdbg install. Credentials and the environment profile are unaffected. |
| S6 | B | The clean-PR workflow rests on layout-preserving downloads, whitespace-tolerant compare, a committed baseline, and knowing sync carries code only. |
| S7 | B | Registration and attach are pinned to one instance; a balancer scatters executions. The guide's fix: aim the environment at a single instance while debugging. |
| S8 | B | Cancel is free; Version History and Save-as-New-Version make the conflict lossless. Overwrite without looking risks a colleague's work; C and D do not address the conflict. |
| S9 | C | Three independent problems: a folder must be open (to hold downloaded files), the workspace must be trusted (the extension is disabled in Restricted Mode), and the C# extension is a required dependency. |
| S10 | B | The bundle pinpoints it: the engine command names a devcontainer that no longer exists — the rebuild gave it a new random name. Update the environment; pin the name via `runArgs` to prevent recurrence. |
