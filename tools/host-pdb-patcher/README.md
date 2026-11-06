# host-pdb-patcher — workaround for the Linux DEE debug-compile bug

## The MES host bug

> **Status (2026-10-18):** fixed in MES 12.0, which switches the compiler to `PortablePdb`, and the MES 12.0.0-beta.2 host image
> already ships it (this tool reports `already PortablePdb(2)` there). The patch is still
> needed for **MES 11.x** Linux hosts. The extension applies it with **Patch Host for DEE
> Debugging (dev/test)…** and offers it automatically; this tool is for scripts and CI.

The MES host's DEE compiler (`Cmf.Foundation.Common.DynamicExecutionEngine.Compiler.Compile`,
verified on 11.2.5; MES 12.0 pre-releases had the same code before the fix) requests
`DebugInformationFormat.Pdb` — the **Windows-native** PDB format — when compiling an action in
debug mode with embedded sources. Roslyn cannot write native PDBs on Linux (the DiaSymReader
writer is Windows-only), so on every Linux-containerized MES host, executing an action in DEE
debug mode fails with:

```
Unexpected error writing debug information -- 'Value cannot be null. (Parameter 'type')'.
```

(Roslyn CS0042, surfaced as "The Action <name> code is invalid" with a pile of Hidden
"Unnecessary using directive" noise around it.) In practice this means **DEE debug mode never
worked on Linux MES hosts before the fix** — the feature predates them.

The proper fix is in the host's compiler: use `DebugInformationFormat.PortablePdb` (works on
all OSes, supports embedded source, fully supported by vsdbg/coreclr) — the change MES 12.0 made.

## What this tool does

Until a fixed host image exists, this Mono.Cecil patcher flips the single IL constant in
`Cmf.Foundation.Common.dll`: the `DebugInformationFormat` argument of the `EmitOptions`
constructor call from `1` (Pdb) to `2` (PortablePdb). The instruction is identified positionally
(the `ldc.i4.1` between `metadataOnly=false` and the `pdbFilePath` load) — do NOT patch the
nearest `ldc.i4.1` before the ctor; that one is the `includePrivateMembers` boolean.

Verified against MES 11.2.5 (2026-08-14): after patching, `ExecuteAction` in debug mode
succeeds and the host emits a `.dll` + portable `.pdb` pair whose document path is the
registered debug source file — breakpoints bind.

## Usage (docker-in-docker devcontainer stack shown; adjust the exec prefix)

```bash
DC=<devcontainer-name>            # e.g. from: docker ps --format '{{.Names}}'
# 1. extract
docker exec $DC docker exec custom_host cat /opt/app/Cmf.Foundation.Common.dll > original.dll
# 2. inspect + patch (idempotent; reports "already PortablePdb" when done before)
dotnet run --project tools/host-pdb-patcher -- original.dll --patch patched.dll
# 3. back up + install + restart
docker exec $DC docker exec custom_host cp /opt/app/Cmf.Foundation.Common.dll /opt/app/Cmf.Foundation.Common.dll.orig
docker exec -i $DC docker exec -i custom_host sh -c 'cat > /opt/app/Cmf.Foundation.Common.dll' < patched.dll
docker exec $DC docker restart custom_host
```

Rollback: copy `/opt/app/Cmf.Foundation.Common.dll.orig` back and restart.

Caveats:
- The patch lives in the container's writable layer — recreating the stack
  (`cmf dev local stack down && up`) reverts to the broken DLL; re-apply.
- Restarting the host clears in-memory DEE debug registrations — re-toggle debug mode after.
- Strong-name signature is invalidated by patching; the .NET runtime does not validate it.
- Dev/test environments only.
