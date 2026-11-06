/**
 * Pure builders for every command that must run inside the MES host container/pod:
 * file delivery, vsdbg checks and the coreclr attach pipe transport.
 *
 * All of them honor HostTarget.engineCommand, a command prefix reaching the container
 * engine that actually runs the host. This is what makes docker-in-docker devcontainer
 * setups work: with engineCommand = ["docker","exec","-i","<devcontainer>","docker"],
 * every produced argv nests transparently. Because the local filesystem is not visible
 * to a nested engine, files are streamed over stdin/stdout (never `docker cp`).
 */

import { HostTarget } from "./types";

export function engineCommand(target: HostTarget): string[] {
  if (target.engineCommand && target.engineCommand.length > 0) return target.engineCommand;
  return target.kind === "kubernetes" ? ["kubectl"] : ["docker"];
}

/**
 * argv that runs `command` inside the host container/pod. interactive adds -i (stdin
 * piping); privileged (docker only) adds `--privileged -u 0` — required for vsdbg to ptrace
 * the host process when the container lacks CAP_SYS_PTRACE (cmf-dev's MES 12 stack template
 * grants none; its 10.x–11.x templates add SYS_PTRACE). The explicit `-u 0` matters: the product host image runs as a
 * non-root user (`USER $NON_ROOT_USER`, uid 1001) and `docker exec --privileged` as a
 * non-root user yields an EMPTY effective capability set (verified on Docker 28.5:
 * `CapEff: 0000000000000000`), so vsdbg would still be refused by Yama. Only local stacks
 * that override `user: root` happened to work without it. Kubernetes has no exec-level
 * equivalent: there the pod spec itself must grant SYS_PTRACE (see decideAttachPrivilege).
 */
export function execInHostArgs(
  target: HostTarget,
  command: string[],
  interactive = false,
  privileged = false,
): string[] {
  const engine = engineCommand(target);
  const flag = interactive ? ["-i"] : [];
  if (target.kind === "kubernetes") {
    const k8s = (target.k8sTarget ?? "").split(/\s+/).filter(Boolean);
    if (k8s.length === 0) {
      throw new Error("This environment has no k8sTarget (the pod or deployment to exec into) — set it with Manage Environments… → Edit.");
    }
    return [...engine, "exec", ...flag, ...k8s, "--", ...command];
  }
  const priv = privileged ? ["--privileged", "-u", "0"] : [];
  return [...engine, "exec", ...priv, ...flag, target.containerName || "custom_host", ...command];
}

/** Shell-quote a path for use inside sh -c (paths come from our own settings). */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** argv that writes stdin to `remotePath` in the host, creating its directory. */
export function writeFileArgs(target: HostTarget, remoteDir: string, remotePath: string): string[] {
  return execInHostArgs(target, ["sh", "-c", `mkdir -p ${shq(remoteDir)} && cat > ${shq(remotePath)}`], true);
}

/** argv that prints `remotePath` from the host to stdout. */
export function readFileArgs(target: HostTarget, remotePath: string): string[] {
  return execInHostArgs(target, ["cat", remotePath]);
}

/** argv that lists the host container's installed .NET runtimes (for runtime-major detection). */
export function listHostRuntimesArgs(target: HostTarget): string[] {
  return execInHostArgs(target, ["dotnet", "--list-runtimes"]);
}

/**
 * Probe for vsdbg that separates "vsdbg missing" from "engine command failed": the
 * sh -c exits 0 whenever the exec actually reached the container and prints
 * present/missing, so any non-zero exit (or spawn error) means the engine itself
 * failed — regardless of how docker/kubectl/oc encode exec failures (SUP-2).
 */
export function vsdbgProbeArgs(target: HostTarget): string[] {
  return execInHostArgs(target, ["sh", "-c", `test -x ${shq(target.vsdbgPath)} && echo present || echo missing`]);
}

export function vsdbgDir(target: HostTarget): string {
  return target.vsdbgPath.replace(/\/[^/]*$/, "") || "/vsdbg";
}

/** Detects an in-container downloader; prints its path (curl preferred) or fails. */
export function downloaderProbeArgs(target: HostTarget): string[] {
  return execInHostArgs(target, ["sh", "-c", "command -v curl || command -v wget"]);
}

/** In-container install, when the image has curl or wget (MES 12 host images have curl; 11.x have neither). */
export function vsdbgInstallArgs(target: HostTarget, downloader: "curl" | "wget"): string[] {
  const fetchCmd = downloader === "curl" ? "curl -sSL" : "wget -qO-";
  return execInHostArgs(target, [
    "sh",
    "-c",
    `${fetchCmd} https://aka.ms/getvsdbgsh | bash /dev/stdin -v latest -l ${shq(vsdbgDir(target))}`,
  ]);
}

export function unameArgs(target: HostTarget): string[] {
  return execInHostArgs(target, ["uname", "-m"]);
}

/** Unprivileged probe of the container's effective capabilities (R7). */
export function capabilityProbeArgs(target: HostTarget): string[] {
  return execInHostArgs(target, ["grep", "CapEff", "/proc/self/status"]);
}

const CAP_SYS_PTRACE_BIT = 19n;

/** Whether a `CapEff: <hex>` line grants CAP_SYS_PTRACE (then --privileged is unnecessary). */
export function hasPtraceCapability(capEffOutput: string): boolean {
  const match = /CapEff:\s*([0-9a-fA-F]+)/.exec(capEffOutput);
  if (!match) return false;
  try {
    return (BigInt(`0x${match[1]}`) & (1n << CAP_SYS_PTRACE_BIT)) !== 0n;
  } catch {
    return false;
  }
}

/**
 * One-shot ptrace preflight run exactly as vsdbg would run WITHOUT privilege: the exec
 * user's effective capabilities, its uid, and the kernel's Yama ptrace scope (a host-wide
 * sysctl that containers inherit). Works for docker and kubectl/oc exec alike.
 */
export function ptraceProbeArgs(target: HostTarget): string[] {
  return execInHostArgs(target, [
    "sh",
    "-c",
    'grep CapEff /proc/self/status; echo "uid=$(id -u)"; echo "yama=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo -)"',
  ]);
}

export interface PtraceProbe {
  /** The exec user already holds CAP_SYS_PTRACE (no escalation needed). */
  hasCap: boolean;
  uid?: number;
  /** kernel.yama.ptrace_scope: 0 classic, 1 descendants-only (default), 2 admin-only, 3 none. */
  yamaScope?: number;
}

export function parsePtraceProbe(stdout: string): PtraceProbe {
  const uid = /uid=(\d+)/.exec(stdout);
  const yama = /yama=(\d)/.exec(stdout);
  return {
    hasCap: hasPtraceCapability(stdout),
    uid: uid ? Number(uid[1]) : undefined,
    yamaScope: yama ? Number(yama[1]) : undefined,
  };
}

export interface AttachPrivilege {
  /** Use the privileged exec form (`--privileged -u 0`; docker only). */
  privileged: boolean;
  /** Something the user must know before attaching; `blocking` means attach cannot work. */
  warning?: string;
  blocking: boolean;
}

/**
 * Decide how vsdbg gets ptrace rights, from the probe (undefined = probe failed → safe default).
 * Docker: unprivileged when the exec user already has CAP_SYS_PTRACE, else `--privileged -u 0`.
 * Kubernetes: nothing can be escalated at exec time, so a missing capability becomes a precise
 * warning (the pod spec fix) instead of an opaque vsdbg failure. Yama scope 3 blocks everything.
 */
export function decideAttachPrivilege(kind: HostTarget["kind"], probe: PtraceProbe | undefined): AttachPrivilege {
  if (kind === "process") return { privileged: false, blocking: false };
  if (probe?.yamaScope === 3) {
    return {
      privileged: false,
      blocking: true,
      warning:
        "kernel.yama.ptrace_scope is 3 on this Docker host / node: no process may be ptraced, so no debugger can attach. Set it to 1 (sysctl -w kernel.yama.ptrace_scope=1) on the host kernel and retry.",
    };
  }
  if (kind === "docker") {
    return { privileged: !probe?.hasCap, blocking: false };
  }
  if (!probe || probe.hasCap) return { privileged: false, blocking: false };
  const nonRoot = probe.uid !== undefined && probe.uid !== 0;
  return {
    privileged: false,
    blocking: false,
    warning:
      `The host pod grants no CAP_SYS_PTRACE to the container user${probe.uid !== undefined ? ` (uid ${probe.uid})` : ""}, and kubectl exec has no --privileged, so vsdbg will not be able to attach. ` +
      'Add securityContext.capabilities.add: ["SYS_PTRACE"] to the host container' +
      (nonRoot
        ? " and — because it runs as non-root, which drops added capabilities on exec — either runAsUser: 0 or kernel.yama.ptrace_scope=0 on the node"
        : "") +
      ", then redeploy.",
  };
}

/** argv that prints "<md5>  <path>" for a host-side file (debug-source rewrite detection). */
export function md5Args(target: HostTarget, remotePath: string): string[] {
  return execInHostArgs(target, ["md5sum", remotePath]);
}

/** argv that extracts a .tar.gz from stdin into the vsdbg directory (local-download fallback). */
export function extractVsdbgTarArgs(target: HostTarget): string[] {
  const dir = vsdbgDir(target);
  return execInHostArgs(target, ["sh", "-c", `mkdir -p ${shq(dir)} && tar -xzf - -C ${shq(dir)}`], true);
}

/** Map `uname -m` output to a vsdbg runtime id. */
export function runtimeIdFromArch(arch: string): string {
  switch (arch.trim()) {
    case "aarch64":
    case "arm64":
      return "linux-arm64";
    case "armv7l":
      return "linux-arm";
    default:
      return "linux-x64";
  }
}

export const HOST_PROCESS_MARKER = "Cmf.Foundation.Services.HostService.dll";

/**
 * argv that restarts the MES host **container** (not an exec). Uses the same container-engine
 * invocation as everything else — for docker-in-docker this nests correctly
 * (`docker exec -i <devcontainer> docker restart <container>`). Returns null for kinds we do
 * not auto-restart (kubernetes/openshift → cluster rollout; process → not a container): the
 * caller shows manual guidance instead.
 */
export function restartHostArgs(target: HostTarget): string[] | null {
  if (target.kind !== "docker") return null;
  return [...engineCommand(target), "restart", target.containerName || "custom_host"];
}

/**
 * argv that prints "<pid> <cmdline>" for managed host candidates: processes whose argv0
 * is dotnet (or ends in /dotnet) and whose command line contains the marker. This
 * deliberately excludes the native CmfEntrypoint wrapper (PID 1), whose argv also
 * contains the marker — attaching to it fails with 0x80131c08 because it has no
 * managed-attachable CoreCLR.
 */
export function findHostPidArgs(target: HostTarget, marker = HOST_PROCESS_MARKER): string[] {
  // The marker is interpolated into a sh case-pattern — restrict it to filename-safe
  // characters so a configurable value can never become shell syntax.
  if (!/^[\w.-]+$/.test(marker)) throw new Error(`Invalid host process marker: ${marker}`);
  const script =
    `for d in /proc/[0-9]*; do c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null); ` +
    `case "$c" in dotnet\\ *${marker}*|*/dotnet\\ *${marker}*) echo "\${d#/proc/} $c";; esac; done`;
  return execInHostArgs(target, ["sh", "-c", script]);
}

/**
 * coreclr attach configuration (stock C# debugger — ADR 0001). For container kinds the
 * debugger runs vsdbg inside the host via the exec pipe; sourceFileMap maps the host-side
 * debug source dir back to the local DEEs folder so breakpoints land on the editable file.
 * processId: pass the resolved host PID; omitted → interactive picker fallback.
 */
/**
 * Build a stock `coreclr` attach configuration for the MES host process. The source map
 * (host path → local path) and the config name are supplied by the caller so the same
 * machinery serves both DEE debugging (map the DEE temp folder) and custom-business
 * debugging (map the host's build-source root to the local Business project) — ADR 0008.
 * An empty map is omitted so it doesn't override the debugger's own PDB-embedded paths.
 */
export function buildAttachConfig(
  target: HostTarget,
  sourceFileMap: Record<string, string>,
  processId?: number,
  privileged = true,
  name = "Attach to MES Host",
): Record<string, unknown> {
  const common = { type: "coreclr", request: "attach", name, justMyCode: false };
  const mapEntry = Object.keys(sourceFileMap).length > 0 ? { sourceFileMap } : {};
  if (target.kind === "process") {
    return { ...common, processId: processId ?? "${command:pickProcess}", ...mapEntry };
  }
  const pipeArgv = execInHostArgs(target, [], true, privileged);
  return {
    ...common,
    processId: processId ?? "${command:pickRemoteProcess}",
    pipeTransport: {
      pipeProgram: pipeArgv[0],
      pipeArgs: pipeArgv.slice(1),
      debuggerPath: target.vsdbgPath,
      pipeCwd: "${workspaceFolder}",
      quoteArgs: false,
    },
    ...mapEntry,
  };
}
