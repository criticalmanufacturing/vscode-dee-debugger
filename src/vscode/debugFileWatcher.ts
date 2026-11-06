import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { md5Args } from "../core/hostExec";
import { HostTarget } from "../core/types";
import { createFileBridge, md5Hex, runCli } from "./fileBridge";
import { ActionSession, SessionStore } from "./session";
import { readSettings } from "./settings";

const POLL_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;
/**
 * After a push the host copy legitimately lags the local file until the exec lands —
 * probing inside this window would misread our own save as a host rewrite (C1).
 */
export const PUSH_DEBOUNCE_MS = 30_000;

/** Seams for unit tests: fake CLI, bridge, filesystem and clock. */
export interface DebugFileWatcherDeps {
  runCli: typeof runCli;
  createBridge: typeof createFileBridge;
  readFile: (path: string) => Promise<Buffer>;
  now: () => number;
  getHostTarget: () => HostTarget;
}

/**
 * While debug mode is on, the MES host rewrites the registered source file whenever its
 * regenerated wrapper differs from what is on disk (e.g. hand-edited using directives).
 * This watcher polls the host-side copy and pulls rewrites back over the local file so
 * the editor never silently diverges from what actually executes (requirement F3.5).
 *
 * C1 safety: a save-push in flight (or freshly landed) makes host and local md5 differ
 * without any host rewrite. The watcher therefore (a) skips sessions whose push is in
 * flight, (b) debounces for PUSH_DEBOUNCE_MS after a push, and (c) treats a remote hash
 * equal to either the local file or the last-pushed content as converged.
 */
export class DebugFileWatcher implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private readonly notifiedHashes = new Map<string, string>();
  private readonly deps: DebugFileWatcherDeps;

  constructor(
    private readonly sessions: SessionStore,
    private readonly output: { appendLine(value: string): void },
    deps?: Partial<DebugFileWatcherDeps>,
  ) {
    this.deps = {
      runCli,
      createBridge: createFileBridge,
      readFile: (path) => fs.readFile(path),
      now: Date.now,
      getHostTarget: () => readSettings().hostTarget,
      ...deps,
    };
    sessions.onDidChange(() => this.syncTimer());
    this.syncTimer();
  }

  private watchable(): ActionSession[] {
    return this.sessions.debugging().filter((s) => s.hostPath && s.hostPath !== s.localPath);
  }

  private syncTimer(): void {
    const active = this.watchable().length > 0;
    if (active && !this.timer) {
      this.timer = setInterval(() => void this.check(), POLL_INTERVAL_MS);
    } else if (!active && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.notifiedHashes.clear();
    }
  }

  /** One poll pass. Driven by the interval timer; public so tests can invoke it directly. */
  async check(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const target = this.deps.getHostTarget();
      for (const session of this.watchable()) {
        const actionName = session.action.Name;
        try {
          // C1: skip while a push is in flight and shortly after one — the md5
          // comparison is meaningless until the push has landed.
          if (session.pushInFlight) continue;
          if (session.lastPushAt !== undefined && this.deps.now() - session.lastPushAt < PUSH_DEBOUNCE_MS) {
            continue;
          }
          const { stdout } = await this.deps.runCli(md5Args(target, session.hostPath!), undefined, PROBE_TIMEOUT_MS);
          const remoteHash = stdout.trim().split(/\s+/)[0] ?? "";
          const localHash = md5Hex(await this.deps.readFile(session.localPath));
          if (!remoteHash || remoteHash === localHash || remoteHash === session.lastPushedHash) {
            // Converged: the host holds either the file on disk or the content we
            // last pushed (the disk file may already be newer — that push is coming).
            this.notifiedHashes.delete(actionName);
            continue;
          }
          if (this.notifiedHashes.get(actionName) === remoteHash) continue; // already handled
          this.notifiedHashes.set(actionName, remoteHash);

          const document = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === session.localPath);
          if (document?.isDirty) {
            // Never clobber unsaved edits — saving re-pushes and re-converges anyway.
            void vscode.window.showWarningMessage(
              `The MES host rewrote '${actionName}' (its regenerated wrapper differed), but you have unsaved local edits. Save the file to push your version, or close it without saving to pull the host's.`,
            );
            continue;
          }
          await this.deps.createBridge(target).pull(session.hostPath!, session.localPath);
          this.output.appendLine(`[watch] pulled host rewrite of '${actionName}' into ${session.localPath}`);
          void vscode.window.showInformationMessage(
            `The MES host rewrote '${actionName}' (regenerated using directives) — the local file was updated. Use UseReference(...) instead of hand-edited usings.`,
          );
        } catch (error) {
          this.output.appendLine(
            `[watch] probe failed for '${actionName}': ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
