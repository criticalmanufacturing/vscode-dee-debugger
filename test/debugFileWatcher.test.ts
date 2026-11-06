import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { __addTextDocument, __reset, messages } from "./mocks/vscode";
import { DebugFileWatcher, PUSH_DEBOUNCE_MS } from "../src/vscode/debugFileWatcher";
import { ActionSession, SessionStore } from "../src/vscode/session";
import { HostTarget } from "../src/core/types";

const md5 = (s: string): string => createHash("md5").update(s).digest("hex");

const target: HostTarget = {
  kind: "docker",
  containerName: "host",
  sourcePathInHost: "/tmp/dee-debug",
  vsdbgPath: "/vsdbg/vsdbg",
};

const LOCAL_PATH = "/dees/act.cs";
const HOST_PATH = "/tmp/dee-debug/act.cs";
const NOW = 1_000_000_000;

interface Fixture {
  watcher: DebugFileWatcher;
  sessions: SessionStore;
  runCli: ReturnType<typeof vi.fn>;
  pull: ReturnType<typeof vi.fn>;
  lines: string[];
}

let disposables: DebugFileWatcher[] = [];
afterEach(() => {
  for (const w of disposables) w.dispose();
  disposables = [];
});

function setup(options: {
  remoteContent: string;
  localContent: string;
  session?: Partial<ActionSession>;
  now?: () => number;
}): Fixture {
  __reset();
  const sessions = new SessionStore();
  sessions.upsert({
    action: { Name: "act" },
    localPath: LOCAL_PATH,
    hostPath: HOST_PATH,
    debugOn: true,
    pendingUpload: false,
    ...options.session,
  });
  const runCli = vi.fn(async () => ({ stdout: `${md5(options.remoteContent)}  ${HOST_PATH}\n`, stderr: "" }));
  const pull = vi.fn(async () => undefined);
  const lines: string[] = [];
  const watcher = new DebugFileWatcher(
    sessions,
    { appendLine: (line: string) => lines.push(line) } as never,
    {
      runCli: runCli as never,
      createBridge: () => ({ pull, publish: async () => HOST_PATH, description: "fake" }) as never,
      readFile: async () => Buffer.from(options.localContent),
      now: options.now ?? ((): number => NOW),
      getHostTarget: () => target,
    },
  );
  disposables.push(watcher);
  return { watcher, sessions, runCli, pull, lines };
}

describe("DebugFileWatcher (C1 — save-push race must not revert a just-saved file)", () => {
  it("treats a remote hash matching the last-pushed content as converged — no pull", async () => {
    // The user saved: local file holds new content, the host still holds the previous
    // push. Before the fix this md5 mismatch was read as a host rewrite and the stale
    // host copy was pulled over the fresh save.
    const fx = setup({
      remoteContent: "previously pushed code",
      localContent: "freshly saved new code",
      session: { lastPushedHash: md5("previously pushed code"), lastPushAt: NOW - PUSH_DEBOUNCE_MS - 1 },
    });
    await fx.watcher.check();
    expect(fx.pull).not.toHaveBeenCalled();
    expect(fx.lines.some((l) => l.includes("pulled host rewrite"))).toBe(false);
    expect(messages).toHaveLength(0);
  });

  it("skips the probe entirely while a push is in flight", async () => {
    const fx = setup({
      remoteContent: "old",
      localContent: "new",
      session: { pushInFlight: true },
    });
    await fx.watcher.check();
    expect(fx.runCli).not.toHaveBeenCalled();
    expect(fx.pull).not.toHaveBeenCalled();
  });

  it("debounces probes for 30 s after a push, then resumes", async () => {
    let t = NOW;
    const fx = setup({
      remoteContent: "same",
      localContent: "same",
      session: { lastPushAt: NOW - 10_000 },
      now: () => t,
    });
    await fx.watcher.check();
    expect(fx.runCli).not.toHaveBeenCalled(); // 10 s after the push — inside the window
    t = NOW + PUSH_DEBOUNCE_MS; // 40 s after the push — window over
    await fx.watcher.check();
    expect(fx.runCli).toHaveBeenCalledTimes(1);
  });

  it("still pulls a genuine host rewrite (hash matches neither local nor last-pushed)", async () => {
    const fx = setup({
      remoteContent: "host regenerated wrapper",
      localContent: "local content",
      session: { lastPushedHash: md5("local content"), lastPushAt: NOW - PUSH_DEBOUNCE_MS - 1 },
    });
    await fx.watcher.check();
    expect(fx.pull).toHaveBeenCalledWith(HOST_PATH, LOCAL_PATH);
    expect(fx.lines.some((l) => l.includes("pulled host rewrite of 'act'"))).toBe(true);
  });

  it("never clobbers a dirty editor even for a genuine rewrite", async () => {
    const fx = setup({
      remoteContent: "host regenerated wrapper",
      localContent: "local content",
    });
    __addTextDocument(LOCAL_PATH, "unsaved edits", true);
    await fx.watcher.check();
    expect(fx.pull).not.toHaveBeenCalled();
    expect(messages.some((m) => m.includes("unsaved local edits"))).toBe(true);
  });
});
