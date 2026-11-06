import * as path from "node:path";
import * as fs from "node:fs/promises";
import { HostTarget } from "../core/types";
import { execInHostArgs, listHostRuntimesArgs, restartHostArgs } from "../core/hostExec";
import {
  adaptRuntimeConfig,
  hostPatchPaths,
  interpretPatchCheckOutput,
  interpretPatcherOutput,
  MIN_HOST_DOTNET_MAJOR,
  patcherCheckInvocation,
  patcherInvocation,
  PATCHER_FILES,
  type HostPatchState,
  type PatchOutcome,
} from "../core/hostPatch";
import { parseHostRuntimeMajor } from "../core/dotnetRuntime";
import { runCli } from "./fileBridge";

const RUNTIMECONFIG_FILE = "host-pdb-patcher.runtimeconfig.json";

/**
 * Apply the #158143 PortablePdb patch to the MES host, in place, using the host's own .NET
 * runtime and the bundled Mono.Cecil patcher (ADR 0010). Streams the patcher into the
 * container, runs it, backs up the original DLL (once), installs the patched DLL, and cleans
 * up. Restarting the host is the caller's responsibility (topology-dependent). Dev/test only.
 */

const VSDBG_TIMEOUT_MS = 120_000;

export interface HostPatchResult {
  outcome: PatchOutcome;
  /** Human-readable detail (patcher stdout tail, or the failure reason). */
  detail: string;
  /** True when the original was backed up during this run (false if a backup already existed). */
  backedUp: boolean;
}

const shTest = (cmd: string): string[] => ["sh", "-c", cmd];

/**
 * Preflight: the host must have a usable .NET runtime and the target DLL must exist. Also detects
 * the host's runtime major so the patcher's runtimeconfig can be adapted to it (rather than
 * relying on roll-forward alone). Returns the detected major on success.
 */
export async function checkHostPatchPrereqs(
  target: HostTarget,
  appDir: string,
  log?: (m: string) => void,
): Promise<{ ok: boolean; reason?: string; hostMajor?: number }> {
  const paths = hostPatchPaths(appDir);
  try {
    const { stdout: dllOut } = await runCli(
      execInHostArgs(target, shTest(`test -f ${q(paths.targetDll)} && echo DLL_OK || echo NO_DLL`)),
    );
    if (!dllOut.includes("DLL_OK")) {
      return { ok: false, reason: `Could not find ${paths.targetDll} in the host — set deeDebugger.hostAppDir if your host app directory differs.` };
    }
    // Detect the installed runtime major (dotnet muxer must be present AND report a runtime).
    let runtimes = "";
    try {
      ({ stdout: runtimes } = await runCli(listHostRuntimesArgs(target), undefined, 10_000));
    } catch {
      return { ok: false, reason: "The MES host container has no `dotnet` runtime on PATH — cannot run the patcher there." };
    }
    const hostMajor = parseHostRuntimeMajor(runtimes);
    if (hostMajor === undefined) {
      return { ok: false, reason: "No .NET runtime (Microsoft.NETCore.App) is installed in the host container — cannot run the patcher there." };
    }
    if (hostMajor < MIN_HOST_DOTNET_MAJOR) {
      return { ok: false, reason: `The host runs .NET ${hostMajor}, but the patcher needs .NET ${MIN_HOST_DOTNET_MAJOR}+ (MES 10 and later).` };
    }
    log?.(`[patch] host .NET major detected: ${hostMajor}`);
    return { ok: true, hostMajor };
  } catch (error) {
    log?.(`[patch] preflight failed: ${error instanceof Error ? error.message : error}`);
    return { ok: false, reason: `Could not reach the MES host to check prerequisites: ${error instanceof Error ? error.message : error}` };
  }
}

/** POSIX single-quote for embedding a path in `sh -c`. */
function q(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/**
 * Stream the patcher runtime files into the container. The runtimeconfig is adapted to the
 * host's detected .NET major (when known) so the patcher requests exactly that runtime.
 */
async function streamPatcher(
  target: HostTarget,
  extensionPath: string,
  paths: ReturnType<typeof hostPatchPaths>,
  hostMajor: number | undefined,
  log?: (m: string) => void,
): Promise<void> {
  const localDir = path.join(extensionPath, "resources", "host-pdb-patcher");
  log?.(`[patch] streaming patcher into ${paths.patcherDir}${hostMajor ? ` (targeting .NET ${hostMajor})` : ""}`);
  for (const name of PATCHER_FILES) {
    let bytes = await fs.readFile(path.join(localDir, name));
    if (name === RUNTIMECONFIG_FILE && hostMajor !== undefined) {
      bytes = Buffer.from(adaptRuntimeConfig(bytes.toString("utf8"), hostMajor), "utf8");
    }
    await runCli(
      execInHostArgs(target, shTest(`mkdir -p ${q(paths.patcherDir)} && cat > ${q(`${paths.patcherDir}/${name}`)}`), true),
      bytes,
      VSDBG_TIMEOUT_MS,
    );
  }
}

/**
 * Read-only probe: is the host DLL already emitting PortablePdb? Runs the bundled patcher
 * WITHOUT `--patch` (it only reports what it finds) and cleans up after itself. Never throws —
 * an unreachable host or an unexpected layout yields "unknown", and callers treat that as
 * "don't nag" (the compile-error path still offers the patch when it does fail).
 */
export async function checkHostPatchState(
  target: HostTarget,
  extensionPath: string,
  appDir: string,
  log?: (m: string) => void,
): Promise<HostPatchState> {
  const paths = hostPatchPaths(appDir);
  try {
    const pre = await checkHostPatchPrereqs(target, appDir, log);
    if (!pre.ok) {
      log?.(`[patch] state check skipped: ${pre.reason}`);
      return "unknown";
    }
    await streamPatcher(target, extensionPath, paths, pre.hostMajor, log);
    let stdout = "";
    try {
      ({ stdout } = await runCli(execInHostArgs(target, patcherCheckInvocation(paths)), undefined, VSDBG_TIMEOUT_MS));
    } catch (error) {
      stdout = error instanceof Error ? error.message : String(error);
    }
    await cleanup(target, paths, log);
    const state = interpretPatchCheckOutput(stdout);
    log?.(`[patch] host PDB format check: ${state}`);
    return state;
  } catch (error) {
    log?.(`[patch] state check failed: ${error instanceof Error ? error.message : error}`);
    return "unknown";
  }
}

export async function applyHostPatch(
  target: HostTarget,
  extensionPath: string,
  appDir: string,
  hostMajor?: number,
  log?: (m: string) => void,
): Promise<HostPatchResult> {
  const paths = hostPatchPaths(appDir);

  // 1. Stream the patcher runtime files into the container.
  await streamPatcher(target, extensionPath, paths, hostMajor, log);

  // 2. Run the patcher against the deployed DLL.
  log?.(`[patch] running patcher on ${paths.targetDll}`);
  let stdout = "";
  let exitOk = true;
  try {
    ({ stdout } = await runCli(execInHostArgs(target, patcherInvocation(paths)), undefined, VSDBG_TIMEOUT_MS));
  } catch (error) {
    // The patcher exits non-zero when `--patch` finds nothing to flip; capture its output to
    // distinguish "already patched" from a real failure.
    exitOk = false;
    stdout = error instanceof Error ? error.message : String(error);
  }
  log?.(`[patch] patcher output: ${stdout.trim().replace(/\s+/g, " ").slice(0, 300)}`);
  const outcome = interpretPatcherOutput(stdout, exitOk);

  if (outcome === "already-patched") {
    await cleanup(target, paths, log);
    return { outcome, detail: "The host DLL is already PortablePdb-patched — nothing to do.", backedUp: false };
  }
  if (outcome === "failed") {
    await cleanup(target, paths, log);
    return { outcome, detail: `The patcher did not modify the DLL. Output: ${stdout.trim().slice(0, 400)}`, backedUp: false };
  }

  // 3. Back up the original (only if no backup exists yet — preserve the true original), then
  //    install the patched DLL in place.
  const { stdout: bkOut } = await runCli(
    execInHostArgs(
      target,
      shTest(`test -f ${q(paths.backupDll)} && echo HAVE_BACKUP || (cp ${q(paths.targetDll)} ${q(paths.backupDll)} && echo BACKED_UP)`),
    ),
  );
  const backedUp = bkOut.includes("BACKED_UP");
  log?.(`[patch] ${backedUp ? "backed up original to " + paths.backupDll : "existing backup kept"}`);
  await runCli(execInHostArgs(target, shTest(`cp ${q(paths.patchedOut)} ${q(paths.targetDll)}`)));
  await cleanup(target, paths, log);
  return { outcome: "patched", detail: "Patched Cmf.Foundation.Common.dll to emit PortablePdb.", backedUp };
}

/** Restore the original DLL from the backup created during patching. */
export async function restoreHostDll(
  target: HostTarget,
  appDir: string,
): Promise<{ restored: boolean; detail: string }> {
  const paths = hostPatchPaths(appDir);
  const { stdout } = await runCli(
    execInHostArgs(
      target,
      shTest(`test -f ${q(paths.backupDll)} && cp ${q(paths.backupDll)} ${q(paths.targetDll)} && echo RESTORED || echo NO_BACKUP`),
    ),
  );
  return stdout.includes("RESTORED")
    ? { restored: true, detail: "Restored the original Cmf.Foundation.Common.dll from backup." }
    : { restored: false, detail: `No backup found at ${paths.backupDll} — nothing to restore.` };
}

/** Restart the host container (docker/dind). Returns false for topologies we don't auto-restart. */
export async function restartHost(target: HostTarget, log?: (m: string) => void): Promise<boolean> {
  const argv = restartHostArgs(target);
  if (!argv) return false;
  log?.(`[patch] restarting host container`);
  await runCli(argv, undefined, VSDBG_TIMEOUT_MS);
  return true;
}

async function cleanup(target: HostTarget, paths: ReturnType<typeof hostPatchPaths>, log?: (m: string) => void): Promise<void> {
  try {
    await runCli(execInHostArgs(target, shTest(`rm -rf ${q(paths.patcherDir)} ${q(paths.patchedOut)}`)));
  } catch (error) {
    log?.(`[patch] cleanup skipped: ${error instanceof Error ? error.message : error}`);
  }
}
