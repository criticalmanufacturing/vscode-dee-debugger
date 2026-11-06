# ADR 0010 — Ship the host PortablePdb patch (#158143) as an in-extension feature

Status: **accepted** (2026-08-15)

## Context
DEE debug mode is broken on **every Linux-containerized MES host** by product bug #158143: the
DEE compiler requests the Windows-only `DebugInformationFormat.Pdb`, which Roslyn cannot emit on
Linux, so executing an action in debug mode fails with *"Unexpected error writing debug
information -- 'Value cannot be null. (Parameter 'type')'"*. **Already-released MES versions carry
this bug**, so a shipped host image fix does not help existing installs. The repo already had a
manual Mono.Cecil patcher (`tools/host-pdb-patcher`) that flips the one IL constant to
`PortablePdb`, but running it is a multi-step, topology-specific chore (extract → patch → back up
→ reinstall → restart) — the single biggest first-run cliff for Linux hosts.

## Decision
Expose the patch as a first-class extension feature, since released versions need it.

1. **Bundle the patcher, run it in-container.** Ship a framework-dependent build of the existing
   Cecil patcher in `resources/host-pdb-patcher/` (~0.5 MB, runtime files only — no native
   apphost/pdb; `rollForward: LatestMajor`). The extension streams it into the host and runs it
   with the host's **own .NET runtime** (`dotnet host-pdb-patcher.dll …`), so no .NET is needed
   on the developer's machine and the proven tool is reused verbatim (rather than reimplementing
   ECMA-335 parsing in TypeScript). The host runtime tracks the MES line — **v10 → .NET 6,
   v11 → .NET 8, v12 → .NET 10**. The patcher targets the **lowest** supported runtime (`net6.0`),
   and the patch preflight **detects the host's installed runtime major** (`dotnet
   --list-runtimes`) and **adapts the streamed runtimeconfig to it** (framework version
   `<hostMajor>.0.0`), so the patcher requests exactly the installed runtime rather than relying on
   roll-forward alone (`rollForward: LatestMajor` is kept as belt-and-braces). One bundled build
   covers .NET 6/8/10; the preflight fails early with a clear message if the host has no runtime or
   one below .NET 6. (The extension also detects the host major on attach and warns if the local
   project targets a different major — `deeDebugger.expectedDotnetMajor`.)
2. **Command `deeDebugger.patchHostForDebugging`** — with an explicit consent dialog and the
   existing non-local-host guard (dev/test only): preflight (`dotnet` present, target DLL found),
   patch in place, **back up the original once** to `…/Cmf.Foundation.Common.dll.orig`, install
   the patched DLL, clean up, then restart. Idempotent — an already-PortablePdb DLL is detected
   and left alone.
3. **Restart policy** — auto-restart **docker / docker-in-docker** (via `restartHostArgs`, which
   nests through the engine command); for **Kubernetes / OpenShift** patch and then show the
   `rollout restart` to run (cluster restarts have more moving parts/permissions); **process**
   kind is guided (not a container). Restart clears in-memory debug registrations, so the user is
   told to re-toggle Debug Mode.
4. **`deeDebugger.restoreHostDll`** — undo, restoring the `.orig` backup and restarting.
5. **Offered as the fix at the point of failure** — a debug execute/compile error matching the
   #158143 signature (`isPdbCompileError`) surfaces a *Patch Host for Debugging…* button.
6. **`deeDebugger.hostAppDir`** setting (default `/opt/app`) locates the DLL for non-standard
   host layouts.

Argv building stays in `core/hostExec.ts` (invariant); path planning, the failure signature, and
patcher-output interpretation are pure and unit-tested in `core/hostPatch.ts`. Stock coreclr
debugging is unchanged (ADR 0001); this only makes the host emit a format vsdbg can read.

## Consequences
- **Removes the #158143 cliff for released MES versions** without waiting for a host image fix —
  one command instead of a manual multi-step procedure across topologies.
- **Modifies a product assembly in the host container** — mitigated by: explicit consent, dev/test
  gating (non-local warning), a preserved `.orig` backup, one-command restore, and idempotency.
  The strong-name signature is invalidated by patching; the .NET runtime does not validate it.
- **Transient by nature** — the patch lives in the container's writable layer and is reverted by
  `cmf dev local stack down/up`; re-running the command re-applies it. This is inherent to
  patching a deployed image and is documented.
- **First bundled third-party code** — Mono.Cecil (MIT). The README's "no third-party code" claim
  is corrected and attribution added in `NOTICE.md`. Cecil ships in the VSIX but is never loaded
  into the extension's Node process — it only runs inside the host container.
- **Validated end-to-end (2026-08-15)** against the live 11.2.5 stack: the bundled patcher, run
  under the host runtime, patched the real `Cmf.Foundation.Common.dll` (Pdb→PortablePdb, exit 0)
  and correctly reported already-patched on re-run.

## Alternatives considered
- **Reimplement the IL flip in pure TypeScript** (no bundled binaries): rejected — a large,
  fragile chunk of PE/CLI-metadata parsing to locate one instruction, versus reusing the proven,
  positionally-precise Cecil tool.
- **Run the patcher on the developer's machine**: rejected — adds a host-machine .NET dependency
  many developers won't have, plus extract/reinject round-trips.
- **Document-only (keep it manual)**: rejected — released versions all need it; the manual flow is
  the main first-run cliff. (`tools/host-pdb-patcher` is retained for scripted/CI use.)

## Amendment (2026-10-18) — proactive detection
The original decision wired the patch offer only to compile errors that reach the extension.
A test user reported that attach "sometimes fails and the system needs to be patched, but
nothing is prompted": with the action triggered from the MES UI, the host's debug compile fails
inside the host and the extension never sees an error — breakpoints simply never bind. The
patcher already distinguishes `Pdb(1)` from `PortablePdb(2)` without `--patch`, so that
read-only run is now used as a probe (`checkHostPatchState`) before enabling debug mode
(blocking prompt with *Continue Anyway*) and before attaching (non-blocking warning), cached per
environment for 10 minutes and invalidated by patch/restore. Opt-out: `deeDebugger.hostPatchCheck`.
The consent dialog is skipped when the user already chose *Patch Host for Debugging* in the
prompt — one question, not two. Requirement F4.7; test plan TC-D11.


## Erratum (2026-10-18)
"Every Linux host / all released versions carry this bug" is no longer true: MES 12.0 emits
`PortablePdb`, and the MES 12.0.0-beta.2 host image already ships the fix (verified with a read-only patcher run). The patch remains needed for
MES 11.x Linux hosts; the proactive probe reports 12.0 hosts as patched, so nothing changes for
their users.
