# Work item 1 — DEE debug mode broken on all Linux MES hosts (native PDB emit)

> **Status (2026-08-15):** filed as work item **158143** with a one-line fix in the host's
> `Compiler`. Once released, `tools/host-pdb-patcher` becomes unnecessary for stacks on fixed
> host images.
>
> **Update:** fixed in MES 12.0 — the compiler now emits `DebugInformationFormat.PortablePdb`,
> and the `criticalmanufacturing/host:12.0.0-beta.2` image already reports `PortablePdb`
> (2026-10-18). 11.x hosts still need the patcher until backports ship. The description
> below records the pre-fix state.

**Title:** DEE debug-mode compilation fails on Linux hosts: Compiler emits Windows-format
PDBs (`DebugInformationFormat.Pdb`), which Roslyn cannot write on Linux

**Area:** Platform / Host / Dynamic Execution Engine
**Severity:** High — the DEE debug-mode feature is entirely non-functional on every
Linux-containerized MES deployment (the standard deployment model since v10/v11).
**Affects:** verified on 11.2.5; MES 12.0 pre-releases had identical code until the
2026-08-18 fix (`Cmf.Foundation.Common.DynamicExecutionEngine.Compiler.Compile`).

## Description

When an action is in per-user debug mode, `Compiler.Compile` takes the debug branch
(file-backed syntax tree + `EmbeddedText`) and emits with:

```csharp
emitOptions = new EmitOptions(
    debugInformationFormat: DebugInformationFormat.Pdb,   // ← Windows-native PDB
    pdbFilePath: assemblyPdbFilePathAndName);
```

`DebugInformationFormat.Pdb` requires the Windows-only `Microsoft.DiaSymReader.Native`
writer. On a Linux host every execution of a debug-mode action therefore fails with
Roslyn CS0042, surfaced to the user as:

```
The Action <name> code is invalid. Errors:
[General][SourceFile] [Line n,0] Hidden: Unnecessary using directive.  (× many — noise)
Unexpected error writing debug information -- 'Value cannot be null. (Parameter 'type')'.
```

The feature predates Linux hosts and was evidently only ever exercised on Windows
(the DEE VS add-in docs still describe attaching to `HostConsole.exe`).

## Reproduction (any Linux stack, e.g. cmf-cli local docker-in-docker)

1. Create a scratch DEE action; call `ActivateDebugMode` with a host-readable source file
   (e.g. via the "Critical Manufacturing DEE Explorer" add-in or the DEE Debugger VS Code
   extension).
2. Execute the action (`ExecuteAction` or trigger its group).
3. Observe the CS0042 failure above; no `.pdb` is produced in the host temp DEE folder.

## Proposed fix (one line)

```csharp
debugInformationFormat: DebugInformationFormat.PortablePdb,
```

Portable PDBs are cross-platform, fully support `EmbeddedText`, and are the native
format for vsdbg/coreclr and current Visual Studio — so the fix also keeps Windows
hosts working. Verified end to end on a live 11.2.5 Linux host by IL-patching this one
constant in `Cmf.Foundation.Common.dll`: debug-mode execution then succeeds, the host
emits `<guid>.dll` + `<guid>.pdb` whose document path is the registered source file, and
VS Code breakpoints bind and hit (including hot-reload of edited-but-unsaved-to-DB code).

## Interim workaround in the field

The DEE Debugger for VS Code repo ships `tools/host-pdb-patcher` (Mono.Cecil), which
flips the constant in a running container; it must be re-applied after every stack
recreate — hence the priority on a proper product fix.

## Evidence

- Live verification log: DEE Debugger repo, `docs/smoke-test.md` and
  `tools/host-pdb-patcher/README.md`.
- An in-source comment in the host's `Compiler` already notes the file-origin requirement
  for debuggability; only the format constant is wrong.
