# Module 4 — Editing and uploading actions safely

**Duration:** 60 min (self-paced) · 60 min (instructor-led — do not compress)
**Required reading:** [User guide — Editing and uploading](../user-guide/editing-and-uploading.md)
**Prerequisites:** Modules 1–3; connected environment; the `Training_Scratch` action
from Module 2.

## Learning objectives

After this module you can:

1. **State** the marker contract and **predict** what happens to edits placed outside
   the markers (not uploaded; overwritten whenever the wrapper is regenerated).
2. **Apply** `UseReference(...)` to reference an additional assembly instead of
   editing the `using` block.
3. **Distinguish** the three save operations — local save, *Save Action to MES
   (Compile & Save)*, *Save as New Version…* — by their effect on the MES, on other
   users, and on version history.
4. **Resolve** a server compile error using the Problems panel, and **handle** a
   concurrency conflict without losing either side's work.
5. **Use** *Execute Action…* (read-only) to test an action without side effects, and
   *Reload Action from MES* to recover a clean wrapper.

## Key concepts

### 1. What a downloaded action file is

Clicking an action in the tree opens your existing `<ActionName>.cs` wherever it is in your
DEEs folders (a `DeeDevBase`-format file gets a working copy under `.dee-debug/`), or downloads
it into the primary DEEs folder (auto-detected, or `deeDebugger.deesFolder`) and opens it: a complete, compilable C#
file — `using` directives, a **server-generated wrapper class**, and, inside four
marker comments, *your* two code bodies. With the standard Actions project in the
workspace, the C# extension gives IntelliSense and local squiggles for free.

### 2. The marker contract — the #1 way to lose work

```csharp
/** START OF USER-DEFINED CODE (DO NOT CHANGE OR DELETE THIS LINE!) **/
// action code
/** END OF USER-DEFINED CODE (DO NOT CHANGE OR DELETE THIS LINE!) **/

/** START OF USER-DEFINED VALIDATION CODE (DO NOT CHANGE OR DELETE THIS LINE!) **/
// test condition — must end in a return of a boolean, e.g. return true;
/** END OF USER-DEFINED VALIDATION CODE (DO NOT CHANGE OR DELETE THIS LINE!) **/
```

In the real file the action-code pair sits in the `EvaluateRule` method and the
validation pair in `ValidateAction`; each marker must be a line of its own, exactly as
shown.

**Only the code between a START and its END marker belongs to you.** Everything else
is a wrapper the server generates and *will regenerate*. Consequences to internalize:

- **Edits outside the markers are not uploaded** — only marker bodies are sent.
- **Out-of-marker edits get overwritten.** While debug mode is on, the host
  regenerates the wrapper of the file it compiles whenever it differs, and the
  extension copies that rewrite over your local file (with a notification). *Reload
  Action from MES* also writes a fresh wrapper.
- Never delete, duplicate, or add text on a marker line. The extension validates
  markers **before every upload** and refuses with a specific message if damaged.
- Recovery from damaged markers: don't hand-repair — copy your body code out, run
  **Reload Action from MES**, paste back inside the markers.

**Need another assembly?** You can't touch the `using` block, so from *inside* the
action-code markers:

```csharp
UseReference("Cmf.Navigo.BusinessObjects.dll", "Cmf.Navigo.BusinessObjects");
```

(first argument: assembly; second: namespace to import). A hand-added `using` above
the markers is exactly the edit the host's rewrite erases.

**In scope inside the markers:** `Input` (a `Dictionary<string, object>` with the
operation's data), `Input["ServiceProvider"]` (DI service provider for MES services);
the validation block must end with a boolean `return` deciding whether the action code
runs.

### 3. The three ways to save — know which one you're doing

| Operation | Effect |
|---|---|
| **Ctrl+S** (save file) | **Local only.** MES untouched; the tree shows a `pending upload` badge. (Exception: with debug mode ON, saving also pushes the file to the host for *your* executions — Module 5.) |
| **Save Action to MES (Compile & Save)** — the cloud-upload icon on the action's row | Compiles your marker bodies on the MES and **overwrites the current version for all users**. The "publish" step. Success shows briefly in the status bar. It writes to the version you are working on: the one you opened, or the version you last created with *Save as New Version…*. If that version is a draft (`not effective`), the code is saved into that draft and you are offered **Make Effective**. |
| **Save Action to MES as New Version…** — right-click the action | Compiles and saves a **new version**, previous version intact in history; you choose *Save as new version and make it effective* or *Save as new version (keep current version effective)*. |

Versioning model: the MES keeps every version; at most one is *effective*. The MES
runs the effective version or, when none is effective, the highest version. *Save as New Version…* is the safer choice for significant changes on
shared environments — rollback point preserved, and "save but don't make effective"
stages a change without changing behavior. **Show Version History…** (right-click)
lists the versions and diffs the one you pick against your local file; a staged
version can be promoted from there with **Make vN Effective**.

### 4. When the server pushes back

- **Compile errors:** shown in the **Problems** panel mapped to the correct lines of
  your local file (inside the right marker region) and as squiggles; the raw server
  response goes to the output channel; a successful save clears them.
- **Concurrency conflict:** if the action changed on the MES after you loaded it
  (colleague upload, MES-UI edit), your upload is refused with a dialog —
  **Overwrite** (the latest server copy is refetched and your bodies are saved onto
  it) or **Cancel** (nothing is sent; diff and reconcile first). Before overwriting,
  consider **Show Version History…** or *Save as New Version…* so nothing is lost.

### 5. Testing and recovering

- **Execute Action…** runs the action ad hoc with a JSON input you provide:
  **read-only** (no persisted side effects) or **full** (behaves like the real thing;
  asks for confirmation). Result opens as a JSON report: input, decoded output,
  duration.
- **Reload Action from MES** replaces your local file with the server's content
  after a confirmation dialog (pending local changes are lost). It is the standard fix
  for a broken wrapper. Reload and sync download refuse to overwrite a file that is
  open with **unsaved** changes ([dirty-editor protection](../user-guide/sync.md#dirty-editor-protection)).

## Demo script (instructor variant)

*Setup: instructor connected; own scratch action `Demo_Scratch` created; MES UI in a
browser tab.*

1. **Open and dissect the file** (5 min). Click `Demo_Scratch`. Walk the file top to
   bottom: `using` block ("server's"), wrapper class ("server's"), the four markers
   ("these two gaps are the only real estate you own"). *Say:* "The server will
   regenerate everything else without asking. Rule of the module: **between the
   markers or it doesn't exist**."
2. **Demonstrate the loss, safely** (5 min). Type a comment *above* the first marker.
   *Say:* "This will never reach the MES — only marker bodies are uploaded — and the
   next time the host regenerates the wrapper, it vanishes from disk too." Delete it.
   Then show `UseReference(...)` inside the markers as the sanctioned way to get more
   assemblies.
3. **The three saves, in sequence** (8 min).
   - Add `Input["demo"] = "v1";` inside the action markers, **Ctrl+S**. Show the
     pending badge in the tree; switch to the MES UI editor — unchanged. "Local only."
   - Click the row's cloud-upload icon (**Save Action to MES (Compile & Save)**).
     Refresh MES UI — changed; the status bar confirms the save.
     "Now it's real, for everyone."
   - Change to `"v2"`, right-click → **Save Action to MES as New Version…**, choose
     *Save as new version and make it effective*. Open **Show Version History…** —
     two versions, effective marked; diff one against the local file. "Rollback
     point preserved."
4. **Compile error round-trip** (5 min). Add `var oops = ;`, save, upload. Show the
   failure notification, the Problems entry jumping to the exact line, the squiggle,
   and the raw payload in the output channel. Fix, upload clean, diagnostics clear.
5. **Concurrency conflict, staged live** (7 min). Edit `Demo_Scratch` in the **MES
   UI** and save there. Back in VS Code, change the local body and upload → the
   "changed on the MES since it was loaded" dialog. Click **Cancel** first ("nothing
   touched — you can diff"), then re-upload and **Overwrite** ("my bodies win; their
   wrapper is refetched"). *Say:* "Nothing here is ever silently lost — but on shared
   instances, prefer Save as New Version when in doubt."
6. **Execute scratchpad** (5 min). Right-click → **Execute Action…** →
   **Execute read-only** → input `{"x": 1}`. Walk the JSON report (input, output,
   duration). *Say:* "Read-only asks no confirmation because it persists nothing; full execution
   confirms first and is the real thing."
7. **Marker damage and recovery** (3 min). Delete an END marker line, try to upload —
   blocked client-side with a specific message, nothing sent. Recover the guide's
   way: copy body out, **Reload Action from MES**, paste back.

## Hands-on exercise

All on `Training_Scratch` in your own stack.

1. Open `Training_Scratch` from the tree; identify the four marker lines and the two
   bodies.
2. Inside the **action-code** markers add:
   `Input["greeting"] = "hello from training";` — **Ctrl+S** only. Verify: pending
   badge in the tree; MES UI editor still shows the old code.
3. **Save Action to MES (Compile & Save)** (cloud-upload icon on the row); verify the
   greeting line now appears in the MES UI editor and the badge cleared.
4. Break it: add `var oops = ;` inside the markers, save, upload. Verify the Problems
   panel points at the broken line. Fix, save, upload clean.
5. Create a version: change the greeting text, **Save Action to MES as New
   Version…**, choose **Save as new version (keep current version effective)** (stage
   without activating). Open **Show Version History…**; confirm the new version exists and the effective mark did not move.
   Diff the effective version against your local file.
6. Stage a conflict. First run **Reload Action from MES** — after step 5 your session
   points at the staged draft, and a conflict needs you working on the effective
   version. Then edit the action's code in the **MES UI** (add a comment) and
   save there. In VS Code, change your local body and upload. At the conflict dialog,
   choose **Cancel**; run **Show Version History…** to inspect; then upload again and
   choose **Overwrite**. Verify your body won in the MES UI.
7. Run **Execute Action…** → **Execute read-only** with input `{}`; confirm the report
   shows your `greeting` value in the output.
8. Damage drill: delete one marker line, attempt an upload (observe the specific
   refusal), then recover via copy-out → **Reload Action from MES** → paste-in →
   upload clean.

**Success criteria:**

- [ ] You predicted correctly, *before* checking, whether each of steps 2/3 changed
      the MES.
- [ ] Compile error appeared in Problems on the right line and cleared after the fix.
- [ ] Version history shows your staged (non-effective) version.
- [ ] Conflict dialog seen; both Cancel and Overwrite paths exercised; no work lost.
- [ ] Read-only execution report shows your output value.
- [ ] Marker recovery done via Reload, not hand-repair.

## Common mistakes to preempt

- **Editing the wrapper** — adding a `using`, tweaking the class, "fixing"
  formatting outside the markers. Not uploaded, and destroyed by the next wrapper
  rewrite. The mysterious "my local file changed on disk by itself" symptom is the
  host rewriting a wrapper you edited
  ([troubleshooting row](../user-guide/troubleshooting.md#uploads-and-compile-errors)).
- **Thinking Ctrl+S published.** The pending badge means *not yet on the MES*. The
  inverse mistake is worse: running Compile & Save casually on a shared instance —
  it overwrites the current version **for everyone**.
- **Hand-repairing damaged markers.** The reliable path is copy bodies → Reload →
  paste. Hand repair tends to leave near-miss marker lines the validator still
  rejects.
- **Forgetting the validation block must end in a boolean `return`.** `return true;`
  is the minimal valid test condition.
- **Upload fails with no compile error → blaming the code.** An authentication
  failure (expired token) also fails uploads — check the message class first
  (Module 7).
- **Overwriting on conflict reflexively.** Cancel costs nothing; Version History and
  Save-as-New-Version exist precisely so a conflict never has to destroy anyone's
  work.

## Knowledge check

**Q1.** You add `using MyCompany.Helpers;` above the first marker and upload. What
reaches the MES?
- A. The whole file including your `using`
- B. Only the marker bodies — your `using` line is not uploaded, and a later host rewrite will erase it locally ✔
- C. The upload is refused
- D. The `using` is converted to a `UseReference` automatically

*Rationale: only marker bodies are sent; the wrapper is server-owned and regenerated — use `UseReference(...)` inside the markers instead.*

**Q2.** With debug mode OFF, what does Ctrl+S do?
- A. Compiles and saves on the MES
- B. Saves locally only; the MES is untouched and the tree shows a pending upload badge ✔
- C. Creates a new version
- D. Pushes the file into the host container

*Rationale: plain file save is local; publishing requires Save Action to MES. (With debug mode ON, save additionally pushes to the host for your executions — Module 5.)*

**Q3.** When is *Save Action to MES as New Version…* the right choice?
- A. Never — it duplicates data
- B. For significant changes on shared environments: it preserves a rollback point and can stage a version without making it effective ✔
- C. Only when the upload would otherwise conflict
- D. When you want the change visible to your user only

*Rationale: new versions keep history intact and let you choose effectiveness; per-user behavior is debug mode's job, not versioning's.*

**Q4.** Your upload is refused: "the action was changed on the MES since it was
loaded". Which statement is true?
- A. Your local changes were discarded
- B. The server version was overwritten by yours
- C. Nothing was changed anywhere yet — you choose Overwrite (your bodies win) or Cancel (reconcile first) ✔
- D. The MES merged both versions

*Rationale: the conflict dialog is a refusal, not an action; nothing is lost until you decide — and Version History / new versions are the lossless outs.*

**Q5.** What's the correct recovery for damaged markers (upload refused with a marker
error)?
- A. Retype the marker line by hand
- B. Copy your body code out, run Reload Action from MES, paste your code back inside the markers ✔
- C. Delete the file and re-download
- D. Upload with force

*Rationale: Reload restores a pristine server wrapper; re-downloading also works but loses nothing only if you copied your bodies first — the guide prescribes the copy-out/reload/paste sequence.*

**Q6.** What distinguishes read-only from full in *Execute Action…*?
- A. Read-only skips the validation block
- B. Read-only runs the code without persisting side effects and needs no confirmation; full behaves like the real operation and confirms first ✔
- C. Read-only runs the stored version, full runs your local file
- D. Full is only available with debug mode on

*Rationale: read-only is the safe quick check; full persists side effects, hence the confirmation.*

---

Next: [Module 5 — Debugging DEE actions live](module-05-debugging.md)
