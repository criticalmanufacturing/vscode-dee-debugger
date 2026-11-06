/**
 * Test-user report (2026-10-18): "when attaching, sometimes it fails and the system needs to be
 * patched, but nothing is prompted". The host is now probed for the #158143 patch before
 * enabling debug mode and before attaching, and the prompt leads into the patch flow.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  __getCommand,
  __queueInfoResponse,
  __reset,
  __resetCommands,
  __setBreakpoints,
  __setConfig,
  __setWorkspaceFolders,
  messages,
} from "./mocks/vscode";

vi.mock("../src/vscode/discovery", () => ({ discoverEnvironments: vi.fn() }));
const { attachDebuggerMock } = vi.hoisted(() => ({ attachDebuggerMock: vi.fn() }));
vi.mock("../src/vscode/debugAttach", () => ({ attachDebugger: attachDebuggerMock, installVsdbg: vi.fn() }));
vi.mock("../src/vscode/fileBridge", () => ({
  runCli: vi.fn(async () => ({ stdout: "", stderr: "" })),
  md5Hex: () => "md5",
  createFileBridge: () => ({ publish: async () => "/tmp/CriticalManufacturing/dee-debug/act.cs", description: "test bridge" }),
}));
const patch = vi.hoisted(() => ({
  checkHostPatchState: vi.fn(),
  checkHostPatchPrereqs: vi.fn(async () => ({ ok: true, hostMajor: 10 })),
  applyHostPatch: vi.fn(async () => ({ outcome: "patched", detail: "ok", backedUp: true })),
  restartHost: vi.fn(async () => true),
  restoreHostDll: vi.fn(async () => ({ restored: true, detail: "restored" })),
}));
vi.mock("../src/vscode/hostPatch", () => patch);

import { registerCommands } from "../src/vscode/commands";
import { CredentialStore } from "../src/vscode/settings";
import { SessionStore } from "../src/vscode/session";
import { GENERATED_MARKERS } from "../src/core/deeFile";

class FakeSecrets {
  async get(): Promise<string | undefined> {
    return undefined;
  }
  async store(): Promise<void> {}
  async delete(): Promise<void> {}
}

const localEnv = { environments: [{ name: "local", hostAddress: "http://localhost" }], activeEnvironment: "local" };
const node = { action: { Id: "1", Name: "act" } };
const testConnection = vi.fn();

interface Harness {
  activateDebugMode: ReturnType<typeof vi.fn>;
  sessions: SessionStore;
  output: string[];
}

async function setup(config: Record<string, unknown> = localEnv): Promise<Harness> {
  __reset();
  __resetCommands();
  attachDebuggerMock.mockReset();
  attachDebuggerMock.mockResolvedValue(true);
  for (const fn of Object.values(patch)) fn.mockClear();
  const folder = await mkdtemp(path.join(tmpdir(), "dee-patch-"));
  const localPath = path.join(folder, "act.cs");
  await writeFile(localPath, ["using System;", GENERATED_MARKERS.actionStart, GENERATED_MARKERS.actionEnd, GENERATED_MARKERS.validationStart, GENERATED_MARKERS.validationEnd].join("\n"));
  __setWorkspaceFolders([{ uri: { fsPath: folder } }]);
  __setConfig({ ...config, deesFolder: folder });
  const sessions = new SessionStore();
  sessions.upsert({ action: node.action, localPath, debugOn: false, pendingUpload: false });
  const activateDebugMode = vi.fn(async (a: unknown) => a);
  testConnection.mockReset();
  testConnection.mockResolvedValue(undefined);
  const output: string[] = [];
  const store = new Map<string, unknown>([["deeDebugger.businessAttachPrimerShown", true]]);
  registerCommands(
    {
      subscriptions: [],
      extensionPath: "/ext",
      globalState: { get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d), update: async (k: string, v: unknown) => void store.set(k, v) },
    } as never,
    {
      getClient: () => ({ activateDebugMode, deactivateDebugMode: vi.fn(async (a: unknown) => a), testConnection }) as never,
      explorer: { refresh: vi.fn(async () => undefined), allActions: () => [], isLoaded: true, rawActions: () => [] } as never,
      sessions,
      diagnostics: { clear: () => undefined, publishServerErrors: () => 0, dispose: () => undefined } as never,
      credentials: new CredentialStore(new FakeSecrets() as never),
      output: { appendLine: (l: string) => output.push(l), show: () => undefined } as never,
      serverContent: {} as never,
    },
  );
  return { activateDebugMode, sessions, output };
}

const toggle = (): Promise<void> => __getCommand("deeDebugger.toggleDebugMode")!(node) as Promise<void>;
const attach = (): Promise<void> => __getCommand("deeDebugger.attach")!() as Promise<void>;

describe("Toggle DEE Debug Mode on an unpatched host (#158143) — the prompt that was missing", () => {
  beforeEach(() => patch.checkHostPatchState.mockResolvedValue("unpatched"));

  it("asks before registering; cancelling the dialog leaves debug mode OFF", async () => {
    const h = await setup();
    await toggle(); // no response queued → dialog dismissed
    expect(patch.checkHostPatchState).toHaveBeenCalledTimes(1);
    expect(messages.some((m) => m.includes("not patched for DEE debugging") && m.includes("#158143"))).toBe(true);
    expect(h.activateDebugMode).not.toHaveBeenCalled();
    expect(h.sessions.get("act")?.debugOn).toBe(false);
  });

  it("'Continue Anyway' proceeds with the registration", async () => {
    const h = await setup();
    __queueInfoResponse("Continue Anyway");
    await toggle();
    expect(h.activateDebugMode).toHaveBeenCalledTimes(1);
    expect(h.sessions.get("act")?.debugOn).toBe(true);
  });

  it("'Patch Host for Debugging' patches + restarts (no second consent dialog), then registers", async () => {
    const h = await setup();
    __queueInfoResponse("Patch Host for Debugging");
    await toggle();
    expect(patch.applyHostPatch).toHaveBeenCalledTimes(1);
    expect(patch.restartHost).toHaveBeenCalledTimes(1);
    expect(messages.some((m) => m.startsWith("Patch the MES host for DEE debugging?"))).toBe(false); // consent already given
    expect(h.activateDebugMode).toHaveBeenCalledTimes(1);
    expect(h.sessions.get("act")?.debugOn).toBe(true);
  });

  it("waits for the host API after the patch-triggered restart before registering", async () => {
    const h = await setup();
    const order: string[] = [];
    testConnection.mockImplementation(async () => void order.push("ready-check"));
    h.activateDebugMode.mockImplementation(async (a: unknown) => (order.push("activate"), a));
    __queueInfoResponse("Patch Host for Debugging");
    await toggle();
    expect(order).toEqual(["ready-check", "activate"]);
    expect(messages.some((m) => m.includes("enable Debug Mode on your action again"))).toBe(false); // no stale toast mid-flow
  });

  it("a failed patch does not enable debug mode", async () => {
    const h = await setup();
    patch.applyHostPatch.mockResolvedValueOnce({ outcome: "failed", detail: "nope", backedUp: false });
    __queueInfoResponse("Patch Host for Debugging");
    await toggle();
    expect(h.activateDebugMode).not.toHaveBeenCalled();
    expect(messages.some((m) => m.includes("Host patch did not apply"))).toBe(true);
  });
});

describe("Toggle DEE Debug Mode — probe caching and opt-out", () => {
  it("a patched host is not prompted and the probe result is cached across toggles", async () => {
    patch.checkHostPatchState.mockResolvedValue("patched");
    const h = await setup();
    await toggle(); // on
    await toggle(); // off
    await toggle(); // on again
    expect(patch.checkHostPatchState).toHaveBeenCalledTimes(1);
    expect(h.activateDebugMode).toHaveBeenCalledTimes(2);
    expect(messages.some((m) => m.includes("not patched"))).toBe(false);
  });

  it("an unreachable/unknown probe never nags", async () => {
    patch.checkHostPatchState.mockResolvedValue("unknown");
    const h = await setup();
    await toggle();
    expect(h.activateDebugMode).toHaveBeenCalledTimes(1);
    expect(messages.some((m) => m.includes("not patched"))).toBe(false);
  });

  it("deeDebugger.hostPatchCheck = off skips the probe entirely", async () => {
    patch.checkHostPatchState.mockResolvedValue("unpatched");
    const h = await setup({ ...localEnv, hostPatchCheck: "off" });
    await toggle();
    expect(patch.checkHostPatchState).not.toHaveBeenCalled();
    expect(h.activateDebugMode).toHaveBeenCalledTimes(1);
  });

  it("a local-process host (Windows) is never probed — the bug is Linux-only", async () => {
    patch.checkHostPatchState.mockResolvedValue("unpatched");
    const h = await setup({ environments: [{ name: "win", hostAddress: "http://localhost:8084", kind: "process" }], activeEnvironment: "win" });
    await toggle();
    expect(patch.checkHostPatchState).not.toHaveBeenCalled();
    expect(h.activateDebugMode).toHaveBeenCalledTimes(1);
  });
});

describe("Attach Debugger to MES Host on an unpatched host", () => {
  it("warns with a patch button but still attaches (business-DLL debugging needs no patch)", async () => {
    patch.checkHostPatchState.mockResolvedValue("unpatched");
    await setup();
    __setBreakpoints([]);
    await attach();
    expect(attachDebuggerMock).toHaveBeenCalledTimes(1);
    expect(messages.some((m) => m.includes("not patched for DEE debugging") && m.includes("custom-business DLL breakpoints are unaffected"))).toBe(true);
  });

  it("stays quiet on a patched host", async () => {
    patch.checkHostPatchState.mockResolvedValue("patched");
    await setup();
    __setBreakpoints([]);
    await attach();
    expect(attachDebuggerMock).toHaveBeenCalledTimes(1);
    expect(messages.some((m) => m.includes("not patched"))).toBe(false);
  });
});

describe("Restore Host DLL invalidates the cached state", () => {
  it("after a restore, the next toggle probes again", async () => {
    patch.checkHostPatchState.mockResolvedValue("patched");
    const h = await setup();
    await toggle(); // probe → patched (cached)
    await toggle(); // off
    await __getCommand("deeDebugger.restoreHostDll")!();
    patch.checkHostPatchState.mockResolvedValue("unpatched");
    await toggle(); // cache says unpatched now → prompt (dismissed)
    expect(messages.some((m) => m.includes("not patched for DEE debugging"))).toBe(true);
    expect(h.activateDebugMode).toHaveBeenCalledTimes(1);
  });
});
