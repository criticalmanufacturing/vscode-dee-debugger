# ADR 0012 — DEE files in subfolders and several Data packages; working copies for DeeDevBase files

Status: accepted (2026-10-19).

## Context
Up to v0.2.0, **open**, **reload** and **debug** always used `<DEEs folder>/<ActionName>.cs`,
where the DEEs folder was a single folder (the setting, or the first auto-detected one).
Customization projects do not always look like that:

- DEE files are often grouped in **subfolders** of `DEEs/` (by area, by feature).
- A repository can hold **several Data packages**, each with its own `DEEs/` folder.
- Many projects author DEEs in the cmf-cli **DeeDevBase format** (`//---Start DEE Code---`
  markers, `DeeDevBase` base class), not in the generated MES format.

Consequences in v0.2.0:

1. Opening an action **overwrote** the root `<ActionName>.cs` with the MES version every time.
   A DeeDevBase-format file of that name was replaced by the generated format (data loss for
   uncommitted work, and a format change in the repository).
2. For a file in a subfolder, a second copy appeared at the DEEs root. `cmf build` packages
   everything under `DEEs/` (except `bin`, `obj`, `ProcessRules`, `*.csproj`), so the stray
   copy would ship.
3. Sync scanned only the top level of one folder.

Host facts this rests on (MES 12.0 host):

- The debug compile (`Compiler.cs`, `ExtractSourceCodeFromFile`) reads **only the generated
  markers** from the registered file and **rewrites** that file when its regenerated wrapper
  differs. A DeeDevBase-format file registered directly would compile empty bodies and then be
  overwritten.
- `ActivateDebugMode` takes a path in the host's filesystem; the attach `sourceFileMap` maps a
  host folder prefix back to a local folder.

## Decision
1. **Index recursively.** DEE files are found with `**/*.cs` under **every** DEE folder:
   `deeDebugger.deesFolder` (now a string *or* a list), otherwise every folder that contains
   `DeeDevBase.cs`, otherwise every `DEEs` folder with a `.csproj`, otherwise `<workspace>/.dees`.
   `bin`, `obj`, `node_modules`, `.dee-debug` and `DeeDevBase.cs` are skipped. Open, debug and
   sync share this index (`vscode/localDees.indexLocalDees`). The first folder is the
   **primary** one: new files are created there.
2. **Pick the file by format** (`core/localDees.planLocalFile`):
   - a **generated-format** file is opened, uploaded and debugged **in place**, wherever it is;
   - a **DeeDevBase-format** file is **never rewritten or registered**. A generated
     **working copy** (MES wrapper + the source's bodies) is created under
     `<workspace>/.dee-debug/<path of the source relative to the workspace>`, and that copy is
     edited, uploaded and debugged. **Write Code Back to Source File** copies the bodies into
     the source, keeping its layout and line endings; it is offered after each successful
     save to the MES. Saving the source refreshes the working copy's bodies. `.dee-debug/`
     carries its own `.gitignore` (`*`) and sits outside every `DEEs/` folder, so it is never
     committed or packaged;
   - with **no** local file, `<primary folder>/<ActionName>.cs` is created from the MES.
3. **An existing local file wins.** Opening an action no longer downloads it over a local file.
   When the local bodies differ from the MES version, a notice offers **Compare** and
   **Reload from MES**. **Reload** is the explicit way to take the MES version.
4. **Never overwrite what we cannot parse.** If `<primary>/<ActionName>.cs` exists but has no
   valid DEE markers, open refuses and says why. If several indexed files belong to one action
   (for example the same DEE in two packages), open refuses and lists them instead of guessing.
5. **Mirror the relative path on the host.** The host path registered for debugging is the
   local file's path relative to a local root, appended to `sourcePathInHost`
   (`core/localDees.hostDebugPath`). The local root is the **workspace folder**, or the
   **primary DEE folder** with `useMount`. One `sourceFileMap` entry
   `{ sourcePathInHost: localRoot }` then maps every subfolder and working copy back to the
   right local file, and same-named files in different packages get distinct host paths.
   Container streaming creates the remote folder first.

## Consequences
- Projects with subfolders, several packages or DeeDevBase files can be opened, debugged and
  synced without moving files and without changing files the user did not ask to change.
- **Behaviour change:** clicking an action opens the existing local file instead of the MES
  version. The differs notice and Reload cover the "I want the MES version" case.
- DeeDevBase users work in a second file. The editor title shows **Write Code Back to Source
  File** on working copies, and the write-back prompt after saving to the MES keeps the
  repository in step.
- With `useMount`, the mount must cover the primary DEE folder, and only files inside it can be
  debugged. Working copies and other packages live outside it, so the extension stops with a
  message naming the file. Streaming (the default) has no such limit.
- Attach maps `sourcePathInHost` to the workspace folder instead of the DEEs folder. Debug files
  registered by an older version under the flat layout must be re-enabled once.
- Requirement F5.4 is extended (recursive scan, several folders, DeeDevBase working copies).
