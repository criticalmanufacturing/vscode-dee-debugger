import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream";
import { HostTarget } from "../core/types";
import {
  buildAttachConfig,
  decideAttachPrivilege,
  downloaderProbeArgs,
  extractVsdbgTarArgs,
  findHostPidArgs,
  parsePtraceProbe,
  PtraceProbe,
  ptraceProbeArgs,
  runtimeIdFromArch,
  unameArgs,
  vsdbgInstallArgs,
  vsdbgProbeArgs,
} from "../core/hostExec";
import { runCli } from "./fileBridge";
import { redactSecrets } from "../core/redact";

/** vsdbg downloads can legitimately take minutes — override the default CLI timeout. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Attach the stock coreclr debugger (Microsoft C# extension) to the MES host process
 * (ADR 0001). Config building lives in core/hostExec; this module runs the probes,
 * installs vsdbg when missing, and starts the debug session.
 */
export type VsdbgProbe = "present" | "missing";

/**
 * Probe for vsdbg in the host container/pod, distinguishing "probe ran, vsdbg missing"
 * from "the engine command itself failed" (docker not on PATH, wrong container name,
 * dead daemon, timeout). Engine failures REJECT so the caller surfaces the real error
 * instead of a misleading "vsdbg was not found … Install it now?" (SUP-2/L5): the probe
 * command exits 0 whenever the exec reached the container and prints present/missing.
 */
export async function hasVsdbg(target: HostTarget, log?: (message: string) => void): Promise<VsdbgProbe> {
  if (target.kind === "process") return "present";
  const { stdout } = await runCli(vsdbgProbeArgs(target));
  if (stdout.includes("present")) return "present";
  log?.(`[attach] vsdbg probe ran in the host but found nothing executable at ${target.vsdbgPath}.`);
  return "missing";
}

/**
 * Install vsdbg into the host container/pod. Preferred: download inside the container
 * (needs curl/wget there; MES 12 host images have curl). MES 11.x images ship neither, so the fallback downloads
 * vsdbg locally (getvsdbg.sh needs local bash+tar — Linux/WSL/macOS) and streams the
 * tarball through the engine exec pipe, which also works nested (docker-in-docker).
 */
export async function installVsdbg(target: HostTarget, log?: (message: string) => void): Promise<void> {
  if (target.kind === "process") return;
  try {
    const { stdout } = await runCli(downloaderProbeArgs(target));
    const downloader = stdout.includes("curl") ? "curl" : stdout.includes("wget") ? "wget" : undefined;
    if (downloader) {
      await runCli(vsdbgInstallArgs(target, downloader), undefined, INSTALL_TIMEOUT_MS);
      return;
    }
    log?.("[attach] downloader probe found neither curl nor wget — falling back to local download + exec stream.");
  } catch (error) {
    // SUP-2: never reroute silently — record why the in-container path was abandoned.
    // (An engine-level failure will resurface from the local-download path's exec.)
    log?.(
      `[attach] in-container downloader probe failed (${error instanceof Error ? error.message : error}) — falling back to local download + exec stream.`,
    );
  }
  await installVsdbgViaLocalDownload(target);
}

async function installVsdbgViaLocalDownload(target: HostTarget): Promise<void> {
  const arch = (await runCli(unameArgs(target))).stdout.trim();
  const runtimeId = runtimeIdFromArch(arch);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dee-vsdbg-"));
  try {
    const script = path.join(tmp, "getvsdbg.sh");
    const response = await fetch("https://aka.ms/getvsdbgsh");
    if (!response.ok) throw new Error(`Failed to download getvsdbg.sh (HTTP ${response.status}).`);
    await fs.writeFile(script, Buffer.from(await response.arrayBuffer()));
    const localDir = path.join(tmp, "vsdbg");
    await runCli(["bash", script, "-v", "latest", "-l", localDir, "-r", runtimeId], undefined, INSTALL_TIMEOUT_MS);
    await streamDirAsTarToHost(localDir, target);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** tar-gz a local directory and pipe it into the host-side extraction command. */
function streamDirAsTarToHost(dir: string, target: HostTarget): Promise<void> {
  const [command, ...args] = extractVsdbgTarArgs(target);
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-C", dir, "-czf", "-", "."], { stdio: ["ignore", "pipe", "pipe"] });
    const push = spawn(command!, args, { stdio: ["pipe", "ignore", "pipe"] });
    let tarStderr = "";
    let pushStderr = "";
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      // Kill both sides: a failed tar must not leave push extracting a truncated
      // stream, and vice versa (M1).
      tar.kill();
      push.kill();
      reject(error);
    };
    tar.stderr.on("data", (d) => (tarStderr += d));
    push.stderr.on("data", (d) => (pushStderr += d));
    // pipeline (unlike .pipe) handles destination errors: an early push exit surfaces
    // here as a stream error instead of an uncaught EPIPE on push.stdin (M1). The
    // meaningful rejection comes from the close handlers below.
    pipeline(tar.stdout, push.stdin, () => undefined);
    tar.on("error", fail);
    push.on("error", fail);
    tar.on("close", (code) => {
      if (code !== 0) fail(new Error(`Local tar failed with exit code ${code}: ${tarStderr.trim()}`));
    });
    push.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        resolve();
      } else {
        fail(new Error(`vsdbg extraction in the host failed: ${pushStderr.trim() || tarStderr.trim()}`));
      }
    });
  });
}

/**
 * Resolve the managed host PID inside the container, so the user never has to pick a
 * process (the CmfEntrypoint wrapper's command line looks almost identical to the real
 * dotnet process and attaching to it fails). Returns undefined when not exactly
 * identifiable — the caller falls back to the interactive picker.
 */
export async function findHostProcessId(
  target: HostTarget,
  log?: (message: string) => void,
): Promise<number | undefined> {
  if (target.kind === "process") return undefined;
  try {
    const { stdout } = await runCli(findHostPidArgs(target));
    const candidates = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ pid: Number(line.split(" ")[0]), cmdline: line }))
      .filter((c) => Number.isInteger(c.pid) && c.pid > 0);
    log?.(`[attach] host process candidates: ${candidates.map((c) => c.cmdline).join(" | ") || "none"}`);
    return candidates.length === 1 ? candidates[0]!.pid : undefined;
  } catch (error) {
    log?.(`[attach] host PID resolution failed: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

export async function attachDebugger(
  target: HostTarget,
  sourceFileMap: Record<string, string>,
  log?: (message: string) => void,
  name = "Attach to MES Host",
): Promise<boolean> {
  const where = target.kind === "docker" ? "container" : "pod";
  let vsdbg: VsdbgProbe;
  try {
    vsdbg = await hasVsdbg(target, log);
  } catch (error) {
    // SUP-2: the engine command itself failed — surface THAT instead of offering to
    // install vsdbg into a container we cannot even reach.
    const message = error instanceof Error ? error.message : String(error);
    log?.(`[attach] vsdbg probe could not run — the engine command failed: ${message}`);
    throw new Error(
      `Could not reach the MES host ${where} to check for vsdbg — verify the engine command / container name. Underlying error: ${message}`,
    );
  }
  if (vsdbg === "missing") {
    const install = await vscode.window.showWarningMessage(
      `vsdbg was not found at ${target.vsdbgPath} in the MES host ${where}. Install it now?`,
      "Install vsdbg",
      "Cancel",
    );
    if (install !== "Install vsdbg") return false;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Installing vsdbg in the MES host container…" },
      () => installVsdbg(target, log),
    );
  }
  const processId = await findHostProcessId(target, log);
  if (processId === undefined && target.kind !== "process") {
    void vscode.window.showWarningMessage(
      "Could not uniquely identify the MES host process — pick the 'dotnet … Cmf.Foundation.Services.HostService.dll' entry (NOT the CmfEntrypoint wrapper).",
    );
  }
  // R7: privilege only when needed. The probe runs exactly as an unprivileged vsdbg would
  // (same exec user) and also reads the kernel's Yama scope; the decision is pure core
  // logic. Docker escalates with `--privileged -u 0`; Kubernetes cannot escalate, so a
  // missing capability is explained up front instead of failing inside vsdbg.
  let privileged = false;
  if (target.kind !== "process") {
    let probe: PtraceProbe | undefined;
    try {
      const { stdout } = await runCli(ptraceProbeArgs(target), undefined, 5_000);
      probe = parsePtraceProbe(stdout);
      log?.(`[attach] ptrace probe: CAP_SYS_PTRACE=${probe.hasCap} uid=${probe.uid ?? "?"} yama=${probe.yamaScope ?? "?"}`);
    } catch (error) {
      log?.(`[attach] ptrace probe failed (${error instanceof Error ? error.message : error}) — using the safe default for ${target.kind}.`);
    }
    const decision = decideAttachPrivilege(target.kind, probe);
    privileged = decision.privileged;
    if (decision.warning) {
      log?.(`[attach] ${decision.warning}`);
      if (decision.blocking) {
        void vscode.window.showErrorMessage(decision.warning);
        return false;
      }
      const choice = await vscode.window.showWarningMessage(decision.warning, { modal: true }, "Attach Anyway");
      if (choice !== "Attach Anyway") return false;
    }
  }
  const config = buildAttachConfig(target, sourceFileMap, processId, privileged, name);
  // L7: the sanitized attach config is the single most useful line in attach tickets.
  log?.(`[attach] pid=${processId ?? "(picker)"} privileged=${privileged} config=${redactSecrets(JSON.stringify(config))}`);
  const folder = vscode.workspace.workspaceFolders?.[0];
  const started = await vscode.debug.startDebugging(folder, config as unknown as vscode.DebugConfiguration);
  if (!started) {
    log?.("[attach] startDebugging returned false — the C# debugger rejected the session.");
    void vscode.window.showWarningMessage(
      "The debugger session did not start (the C# extension rejected it). Check that 'ms-dotnettools.csharp' is enabled, then see the DEE Debugger output for the generated configuration.",
    );
  }
  return started;
}
