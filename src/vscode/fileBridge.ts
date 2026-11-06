import * as path from "node:path";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { HostTarget } from "../core/types";
import { readFileArgs, writeFileArgs } from "../core/hostExec";
import { hostDebugPath, posixDirname } from "../core/localDees";

/**
 * Delivers debug-mode source files to the filesystem the MES host process can read
 * (ADR 0004). For 'process' kind the local path is used as-is; with a bind mount no
 * transfer is needed; for container kinds the file is streamed over stdin through the
 * configured engine command — which nests through docker-in-docker devcontainers,
 * where the local path would not exist for a `docker cp`.
 */
export interface FileBridge {
  /** Push the local file; returns the path to register with ActivateDebugMode. */
  publish(localPath: string): Promise<string>;
  /** Pull the host copy back over the local file (host may rewrite it). */
  pull(hostPath: string, localPath: string): Promise<void>;
  readonly description: string;
}

/**
 * Default cap for engine-CLI invocations (M6): without it, a wedged docker/ssh wrapper
 * leaves interactive commands hanging forever. Callers with legitimately long operations
 * (vsdbg installs, tar streams) override upward. Note the SIGKILL on timeout kills the
 * local engine CLI only — an in-container command survives until stdin EOF propagates.
 */
export const DEFAULT_CLI_TIMEOUT_MS = 30_000;

export function runCli(
  argv: string[],
  stdin?: Buffer,
  timeoutMs: number = DEFAULT_CLI_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  const [command, ...args] = argv;
  if (!command) return Promise.reject(new Error("Empty command."));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    // Accumulate Buffers and decode once on close (M2): concatenating chunks as strings
    // corrupts multibyte UTF-8 sequences split across chunk boundaries.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${argv.join(" ")} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : undefined;
    child.stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr.on("data", (d: Buffer) => stderrChunks.push(d));
    // M1: when the child exits before consuming stdin (wrong container name, dead daemon,
    // usage error), the write gets EPIPE emitted on this stream — without a listener that
    // is an uncaught extension-host exception. The close handler below already produces
    // the meaningful rejection from exit code + stderr.
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${argv.join(" ")} exited with ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    child.stdin.end(stdin);
  });
}

/** md5 hex digest of file content — the hash dialect the debug watcher compares (C1). */
export function md5Hex(content: Buffer | string): string {
  return createHash("md5").update(content).digest("hex");
}

/**
 * Host path for a local debug file: its path relative to `localRoot` mirrored under
 * `sourcePathInHost` (ADR 0012), so DEE files in subfolders and working copies keep distinct
 * host paths and one `sourceFileMap` entry `{ sourcePathInHost: localRoot }` maps them all
 * back. Without a root (legacy callers) the flat `<sourcePathInHost>/<file name>` is used.
 */
function hostFilePath(target: HostTarget, localPath: string, localRoot?: string): string {
  if (!localRoot) return path.posix.join(target.sourcePathInHost, path.basename(localPath));
  const mapped = hostDebugPath(target.sourcePathInHost, localRoot, localPath);
  if (!mapped) {
    throw new Error(
      `${localPath} is outside ${localRoot}, which the debugger maps to ${target.sourcePathInHost} — ` +
        "keep DEE files inside the workspace (and, with useMount, inside the mounted DEEs folder).",
    );
  }
  return mapped;
}

class ProcessBridge implements FileBridge {
  readonly description = "local process (paths shared)";
  async publish(localPath: string): Promise<string> {
    return localPath;
  }
  async pull(): Promise<void> {
    // Same file — nothing to do.
  }
}

class MountBridge implements FileBridge {
  readonly description: string;
  constructor(
    private readonly target: HostTarget,
    private readonly localRoot?: string,
  ) {
    this.description = `bind mount at ${target.sourcePathInHost}`;
  }
  async publish(localPath: string): Promise<string> {
    return hostFilePath(this.target, localPath, this.localRoot);
  }
  async pull(): Promise<void> {
    // Same file through the mount — nothing to do.
  }
}

/** Streams files in/out of the host container/pod via the engine command (stdin/stdout). */
class ExecStreamBridge implements FileBridge {
  readonly description: string;
  constructor(
    private readonly target: HostTarget,
    private readonly localRoot?: string,
  ) {
    const where =
      target.kind === "docker" ? `container '${target.containerName || "custom_host"}'` : `'${target.k8sTarget}'`;
    this.description = `exec-stream to ${where}`;
  }
  async publish(localPath: string): Promise<string> {
    const remote = hostFilePath(this.target, localPath, this.localRoot);
    const content = await fs.readFile(localPath);
    await runCli(writeFileArgs(this.target, posixDirname(remote), remote), content);
    return remote;
  }
  async pull(hostPath: string, localPath: string): Promise<void> {
    const { stdout } = await runCli(readFileArgs(this.target, hostPath));
    await fs.writeFile(localPath, stdout);
  }
}

/**
 * `localRoot` is the local folder that `sourcePathInHost` stands for in the attach map:
 * the workspace root for exec streaming, the mounted DEEs folder with `useMount`.
 */
export function createFileBridge(target: HostTarget, localRoot?: string): FileBridge {
  if (target.kind === "process") return new ProcessBridge();
  if (target.useMount) return new MountBridge(target, localRoot);
  return new ExecStreamBridge(target, localRoot);
}
