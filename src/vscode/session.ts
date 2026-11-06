import * as vscode from "vscode";
import { DeeAction } from "../core/types";

/** Per-action working state for actions the user has opened locally. */
export interface ActionSession {
  action: DeeAction;
  /** Absolute local path of the .cs file that is opened, uploaded and debugged. */
  localPath: string;
  /**
   * When `localPath` is a working copy (ADR 0012): the repository file in `DeeDevBase` format it
   * was made from. That file is never rewritten except by "Write Code Back to Source File".
   */
  sourcePath?: string;
  /** Path registered with the host via ActivateDebugMode, when debug is on. */
  hostPath?: string;
  debugOn: boolean;
  /** Local file saved but not yet uploaded with CompileAndSave. */
  pendingUpload: boolean;
  /**
   * md5 of the content most recently pushed to the host (C1): while the remote copy
   * still matches it, an md5 mismatch against a newer local file is our own push
   * landing, not a host rewrite — the watcher must not pull it back.
   */
  lastPushedHash?: string;
  /** Timestamp (ms) of the last push — the watcher debounces probes shortly after. */
  lastPushAt?: number;
  /** True while a push is in flight — the watcher skips probing entirely (C1). */
  pushInFlight?: boolean;
  /**
   * Environment that owns this session (R2): entities and debug registrations belong
   * to one MES — never reuse them against another environment after a switch.
   */
  envName?: string;
}

export class SessionStore implements vscode.Disposable {
  private readonly byName = new Map<string, ActionSession>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  get(actionName: string): ActionSession | undefined {
    return this.byName.get(actionName);
  }

  getByPath(fsPath: string): ActionSession | undefined {
    for (const session of this.byName.values()) {
      if (session.localPath === fsPath) return session;
    }
    return undefined;
  }

  /** The session whose working copy was made from this repository file (ADR 0012). */
  getBySourcePath(fsPath: string): ActionSession | undefined {
    for (const session of this.byName.values()) {
      if (session.sourcePath === fsPath) return session;
    }
    return undefined;
  }

  upsert(session: ActionSession): ActionSession {
    this.byName.set(session.action.Name, session);
    this.emitter.fire();
    return session;
  }

  update(actionName: string, patch: Partial<ActionSession>): void {
    const session = this.byName.get(actionName);
    if (!session) return;
    Object.assign(session, patch);
    this.emitter.fire();
  }

  all(): ActionSession[] {
    return [...this.byName.values()];
  }

  debugging(): ActionSession[] {
    return this.all().filter((s) => s.debugOn);
  }

  /** Drop all sessions (environment switch — R2). Returns the dropped sessions. */
  clear(): ActionSession[] {
    const dropped = this.all();
    this.byName.clear();
    if (dropped.length > 0) this.emitter.fire();
    return dropped;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
