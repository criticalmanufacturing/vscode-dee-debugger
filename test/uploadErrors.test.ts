import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __addTextDocument,
  __getCommand,
  __queueQuickPick,
  __reset,
  __resetCommands,
  messages,
} from "./mocks/vscode";
import { registerCommands } from "../src/vscode/commands";
import { CredentialStore } from "../src/vscode/settings";
import { SessionStore } from "../src/vscode/session";
import { MesApiError } from "../src/core/mesClient";
import { GENERATED_MARKERS } from "../src/core/deeFile";

const LOCAL_PATH = "/dees/act.cs";

const DEE_TEXT = [
  "using System;",
  GENERATED_MARKERS.actionStart,
  "var x = 1;",
  GENERATED_MARKERS.actionEnd,
  GENERATED_MARKERS.validationStart,
  GENERATED_MARKERS.validationEnd,
].join("\n");

class FakeSecrets {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

interface Fixture {
  output: string[];
  publish: ReturnType<typeof vi.fn>;
}

function setup(compileError: unknown): Fixture {
  __reset();
  __resetCommands();
  const sessions = new SessionStore();
  sessions.upsert({ action: { Name: "act" }, localPath: LOCAL_PATH, debugOn: false, pendingUpload: false });
  __addTextDocument(LOCAL_PATH, DEE_TEXT);
  const publish = vi.fn(() => 1);
  const output: string[] = [];
  const client = {
    compileAndSave: () => Promise.reject(compileError),
    compileAndSaveWithNewVersion: () => Promise.reject(compileError),
  };
  registerCommands({ subscriptions: [] } as never, {
    getClient: () => client as never,
    explorer: {
      refresh: vi.fn(async () => undefined),
      allActions: () => [],
      isLoaded: true,
      rawActions: () => [],
      findAction: () => undefined,
      setFilter: () => undefined,
      currentFilter: undefined,
    } as never,
    sessions,
    diagnostics: { clear: () => undefined, publishServerErrors: publish, dispose: () => undefined } as never,
    credentials: new CredentialStore(new FakeSecrets() as never),
    output: { appendLine: (line: string) => output.push(line) } as never,
    serverContent: {} as never,
  });
  return { output, publish };
}

const node = { action: { Name: "act" } };

describe("upload error routing (M5/SUP-1)", () => {
  beforeEach(() => undefined);

  it("routes a 401-with-body to the auth hint — NEVER to diagnostics", async () => {
    const fx = setup(
      new MesApiError(
        "MES call CompileAndSave failed with HTTP 401 Unauthorized.",
        "http://localhost/api/DynamicExecutionEngine/CompileAndSave",
        401,
        "<html>Security Portal login page</html>",
      ),
    );
    await __getCommand("deeDebugger.uploadAction")!(node);
    expect(fx.publish).not.toHaveBeenCalled();
    expect(messages.some((m) => m.includes("Compilation of"))).toBe(false);
    expect(messages.some((m) => m.includes("token may be expired"))).toBe(true);
    // showError still records the response body in the channel for diagnosis.
    expect(fx.output.some((l) => l.includes("Security Portal login page"))).toBe(true);
  });

  it("publishes diagnostics for structured compile errors AND logs the raw payload (SUP-1)", async () => {
    const details = "[Action Code][act.cs] [Line 1,5] Error: ; expected";
    const fx = setup(new MesApiError("MES call CompileAndSave failed with HTTP 400 Bad Request.", "u", 400, details));
    await __getCommand("deeDebugger.uploadAction")!(node);
    expect(fx.publish).toHaveBeenCalledTimes(1);
    expect(messages.some((m) => m.includes("Compilation of 'act' failed — 1 problem(s)"))).toBe(true);
    // smoke-test.md Phase 4.4: the raw payload must be copyable from the Output channel.
    expect(fx.output.some((l) => l.includes("raw host payload"))).toBe(true);
    expect(fx.output.some((l) => l.includes("[Line 1,5]"))).toBe(true);
  });

  it("falls through to showError for non-auth errors without structured rows", async () => {
    const fx = setup(
      new MesApiError("MES call CompileAndSave failed with HTTP 500 Internal Server Error.", "u", 500, "<html>proxy error</html>"),
    );
    await __getCommand("deeDebugger.uploadAction")!(node);
    expect(fx.publish).not.toHaveBeenCalled();
    expect(messages.some((m) => m.startsWith("Failed to save action 'act'"))).toBe(true);
    expect(fx.output.some((l) => l.includes("proxy error"))).toBe(true);
  });

  it("truncates oversized raw payloads in the channel", async () => {
    const details = `[Action Code][act.cs] [Line 1,5] Error: boom\n${"x".repeat(10_000)}`;
    const fx = setup(new MesApiError("HTTP 400", "u", 400, details));
    await __getCommand("deeDebugger.uploadAction")!(node);
    expect(fx.output.some((l) => l.includes("payload truncated"))).toBe(true);
  });

  it("gates the new-version upload path identically", async () => {
    const fx = setup(new MesApiError("MES call CompileAndSaveWithNewVersion failed with HTTP 401 Unauthorized.", "u", 401, "body"));
    __queueQuickPick((items) => (items as unknown[])[0]); // "make effective" choice
    await __getCommand("deeDebugger.uploadActionNewVersion")!(node);
    expect(fx.publish).not.toHaveBeenCalled();
    expect(messages.some((m) => m.includes("token may be expired"))).toBe(true);
    expect(messages.some((m) => m.includes("Compilation of"))).toBe(false);
  });
});
