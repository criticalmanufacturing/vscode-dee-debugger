import * as vscode from "vscode";
import { redactSecrets } from "../core/redact";

/** Minimal logging surface the rest of the vscode layer depends on. */
export interface Logger {
  appendLine(value: string): void;
  show?(): void;
}

const RING_SIZE = 500;

/**
 * Support-grade logger (supportability review L2/L3): timestamps + secret redaction on
 * every line, and a ring buffer of recent lines for the support bundle. Wraps a plain
 * OutputChannel so existing `output.appendLine` call sites keep working.
 */
export class SupportLogger implements Logger, vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private readonly ring: string[] = [];

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name);
  }

  appendLine(value: string): void {
    const line = `${new Date().toISOString()} ${redactSecrets(value)}`;
    this.ring.push(line);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.channel.appendLine(line);
  }

  /** Recent (already-redacted) log lines, oldest first. */
  recentLines(): string[] {
    return [...this.ring];
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
