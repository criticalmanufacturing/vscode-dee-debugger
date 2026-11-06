/**
 * Host PDB-patch planning (pure, host-agnostic — no `vscode`, no Node I/O). The MES host's
 * DEE compiler requests the Windows-only `DebugInformationFormat.Pdb`, which Roslyn cannot
 * emit on Linux, so DEE debug mode fails on every Linux-containerized host (product bug
 * #158143). The bundled Mono.Cecil patcher flips that one IL constant to `PortablePdb` in
 * `Cmf.Foundation.Common.dll`. This module computes the paths, the in-container commands, and
 * the failure-signature detection; the VS Code layer streams the patcher in, runs it, backs up
 * the original, installs the patched DLL, and restarts the host. Dev/test only.
 */

import type { HostTarget } from "./types";

export const DEFAULT_HOST_APP_DIR = "/opt/app";
export const HOST_DLL_NAME = "Cmf.Foundation.Common.dll";
/** Working area inside the host container (cleaned up after patching). */
export const PATCHER_CONTAINER_DIR = "/tmp/dee-debugger/host-pdb-patcher";
export const PATCHED_OUT = "/tmp/dee-debugger/Cmf.Foundation.Common.patched.dll";

/**
 * The runtime files that must be streamed into the host to run the patcher under the host's
 * own .NET runtime (`dotnet host-pdb-patcher.dll …`). Shipped in
 * `resources/host-pdb-patcher/`; the native apphost and .pdb are intentionally excluded.
 */
export const PATCHER_FILES = [
  "host-pdb-patcher.dll",
  "host-pdb-patcher.deps.json",
  "host-pdb-patcher.runtimeconfig.json",
  "Mono.Cecil.dll",
  "Mono.Cecil.Pdb.dll",
  "Mono.Cecil.Mdb.dll",
  "Mono.Cecil.Rocks.dll",
] as const;

export interface HostPatchPaths {
  /** Host app directory (holds Cmf.Foundation.Common.dll). */
  appDir: string;
  /** The DLL to patch. */
  targetDll: string;
  /** Backup of the untouched original (preserved across re-runs). */
  backupDll: string;
  /** Where the patcher runtime files are streamed. */
  patcherDir: string;
  /** The patcher's output before it is installed over the target. */
  patchedOut: string;
}

function joinPosix(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export function hostPatchPaths(appDir: string = DEFAULT_HOST_APP_DIR): HostPatchPaths {
  const targetDll = joinPosix(appDir, HOST_DLL_NAME);
  return {
    appDir: appDir.replace(/\/+$/, ""),
    targetDll,
    backupDll: `${targetDll}.orig`,
    patcherDir: PATCHER_CONTAINER_DIR,
    patchedOut: PATCHED_OUT,
  };
}

/** The inner command (for execInHostArgs) that runs the bundled patcher on the target DLL. */
export function patcherInvocation(paths: HostPatchPaths): string[] {
  return ["dotnet", joinPosix(paths.patcherDir, "host-pdb-patcher.dll"), paths.targetDll, "--patch", paths.patchedOut];
}

/**
 * The Linux DEE debug-compile failure signature (#158143). The host surfaces Roslyn's native-PDB
 * writer failure as "Unexpected error writing debug information -- 'Value cannot be null.
 * (Parameter 'type')'." (often wrapped as "The Action <name> code is invalid"). Used to offer the
 * patch as the fix when a debug-mode execute/compile fails.
 */
export function isPdbCompileError(text: string | undefined | null): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("unexpected error writing debug information") ||
    (t.includes("value cannot be null") && t.includes("parameter 'type'"))
  );
}

/** Lowest host .NET major the bundled patcher can run on (MES 10 = .NET 6). */
export const MIN_HOST_DOTNET_MAJOR = 6;

/**
 * Adapt the bundled patcher's runtimeconfig to the .NET major actually installed on the host,
 * so it requests exactly that runtime rather than relying on roll-forward from a fixed target
 * (v10 → 6, v11 → 8, v12 → 10). `rollForward: LatestMajor` is kept as belt-and-braces. `baseJson`
 * is the shipped `host-pdb-patcher.runtimeconfig.json`; returns the adapted JSON to stream in.
 */
export function adaptRuntimeConfig(baseJson: string, hostMajor: number): string {
  const cfg = JSON.parse(baseJson) as { runtimeOptions?: Record<string, unknown> };
  const ro = (cfg.runtimeOptions ??= {});
  ro["tfm"] = `net${hostMajor}.0`;
  ro["framework"] = { name: "Microsoft.NETCore.App", version: `${hostMajor}.0.0` };
  ro["rollForward"] = "LatestMajor";
  return JSON.stringify(cfg, null, 2);
}

/**
 * Proactive detection (test-user report, 2026-10-18): the patch prompt used to appear only when
 * an API call made BY THE EXTENSION returned the #158143 compile error. In the normal flow the
 * action is triggered from the MES UI, the host fails the debug compile out of our sight,
 * breakpoints never bind, and the user concludes "attach doesn't work" — with no prompt. So the
 * host is now probed (the bundled patcher without `--patch` is read-only and reports the IL
 * constant it finds) before enabling debug mode and before attaching.
 */
export type HostPatchState = "patched" | "unpatched" | "unknown";

/** Read-only run of the patcher: prints `… = Pdb(1) <-- target` or `… already PortablePdb(2)`. */
export function patcherCheckInvocation(paths: HostPatchPaths): string[] {
  return ["dotnet", joinPosix(paths.patcherDir, "host-pdb-patcher.dll"), paths.targetDll];
}

export function interpretPatchCheckOutput(stdout: string | undefined | null): HostPatchState {
  const s = (stdout ?? "").toLowerCase();
  if (s.includes("already portablepdb")) return "patched";
  if (s.includes("<-- target") || /=\s*pdb\(1\)/.test(s)) return "unpatched";
  return "unknown";
}

/** The bug is Linux-only; a local `process` host (Windows) emits native PDBs just fine. */
export function hostPatchApplies(target: Pick<HostTarget, "kind">): boolean {
  return target.kind !== "process";
}

/** A probe costs one exec round-trip; cache it per environment, but not across a stack recreate. */
export const HOST_PATCH_CHECK_TTL_MS = 10 * 60_000;
export function patchStateIsFresh(checkedAt: number, now: number): boolean {
  return now - checkedAt >= 0 && now - checkedAt < HOST_PATCH_CHECK_TTL_MS;
}

/** The prompt shown when the host is unpatched; `reason` tunes the consequence sentence. */
export function describeUnpatchedHost(envName: string | undefined, reason: "debug" | "attach"): string {
  const where = envName ? `'${envName}'` : "this environment";
  const consequence =
    reason === "debug"
      ? "Every execution of an action in debug mode will fail to compile on the host and breakpoints will never bind."
      : "DEE-action breakpoints will not bind in this session (custom-business DLL breakpoints are unaffected).";
  return (
    `The MES host of ${where} is not patched for DEE debugging (Linux host PDB bug #158143). ${consequence} ` +
    "Patch it now? Dev/test hosts only — the host restarts afterwards."
  );
}

/** Interpret the patcher's stdout/exit. It exits non-zero when `--patch` finds nothing to do. */
export type PatchOutcome = "patched" | "already-patched" | "failed";
export function interpretPatcherOutput(stdout: string, exitOk: boolean): PatchOutcome {
  const s = stdout.toLowerCase();
  if (s.includes("already portablepdb")) return "already-patched";
  if (exitOk && /patched=[1-9]/.test(s)) return "patched";
  return "failed";
}
