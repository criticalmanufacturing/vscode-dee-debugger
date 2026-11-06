/**
 * Usability pass: the "attach now?" decision is part of enabling debug mode (one modal with the
 * semantics as detail), governed by deeDebugger.attachAfterEnablingDebug, and skipped when our
 * debugger is already attached.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscodeMock from "./mocks/vscode";
import { __getCommand, __queueInfoResponse, __reset, __resetCommands, __setConfig, __setWorkspaceFolders, messages } from "./mocks/vscode";

vi.mock("../src/vscode/discovery", () => ({ discoverEnvironments: vi.fn() }));
vi.mock("../src/vscode/debugAttach", () => ({ attachDebugger: vi.fn(async () => true), installVsdbg: vi.fn() }));
vi.mock("../src/vscode/fileBridge", () => ({
  runCli: vi.fn(async () => ({ stdout: "", stderr: "" })),
  md5Hex: () => "md5",
  createFileBridge: () => ({ publish: async () => "/tmp/CriticalManufacturing/dee-debug/act.cs", description: "test bridge" }),
}));
vi.mock("../src/vscode/hostPatch", () => ({
  checkHostPatchState: vi.fn(async () => "patched"),
  checkHostPatchPrereqs: vi.fn(),
  applyHostPatch: vi.fn(),
  restartHost: vi.fn(),
  restoreHostDll: vi.fn(),
}));

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

const node = { action: { Id: "1", Name: "act" } };
const localEnv = { environments: [{ name: "local", hostAddress: "http://localhost" }], activeEnvironment: "local" };
let attachCalls = 0;

async function setup(extraConfig: Record<string, unknown> = {}): Promise<void> {
  __reset();
  __resetCommands();
  attachCalls = 0;
  vscodeMock.debug.activeDebugSession = undefined;
  const folder = await mkdtemp(path.join(tmpdir(), "dee-attach-after-"));
  const localPath = path.join(folder, "act.cs");
  await writeFile(localPath, [GENERATED_MARKERS.actionStart, GENERATED_MARKERS.actionEnd, GENERATED_MARKERS.validationStart, GENERATED_MARKERS.validationEnd].join("\n"));
  __setWorkspaceFolders([{ uri: { fsPath: folder } }]);
  __setConfig({ ...localEnv, deesFolder: folder, ...extraConfig });
  const sessions = new SessionStore();
  sessions.upsert({ action: node.action, localPath, debugOn: false, pendingUpload: false });
  registerCommands({ subscriptions: [], extensionPath: "/ext", globalState: { get: () => true, update: async () => undefined } } as never, {
    getClient: () => ({ activateDebugMode: vi.fn(async (a: unknown) => a) }) as never,
    explorer: { refresh: vi.fn(async () => undefined), allActions: () => [], isLoaded: true, rawActions: () => [] } as never,
    sessions,
    diagnostics: {} as never,
    credentials: new CredentialStore(new FakeSecrets() as never),
    output: { appendLine: () => undefined, show: () => undefined } as never,
    serverContent: {} as never,
  });
  // Stand in for the real attach command so the test observes the decision, not the attach flow.
  vscodeMock.commands.registerCommand("deeDebugger.attach", () => void attachCalls++);
}

const enable = (): Promise<void> => __getCommand("deeDebugger.enableDebugMode")!(node) as Promise<void>;

describe("attach after enabling debug mode", () => {
  beforeEach(() => undefined);

  it("asks once (modal) and attaches on 'Attach Debugger'", async () => {
    await setup();
    __queueInfoResponse("Attach Debugger");
    await enable();
    expect(messages.some((m) => m.includes("Attach the debugger now?"))).toBe(true);
    expect(attachCalls).toBe(1);
  });

  it("'Not Now' leaves debug mode on without attaching", async () => {
    await setup();
    __queueInfoResponse("Not Now");
    await enable();
    expect(attachCalls).toBe(0);
  });

  it("'always' attaches without asking; 'never' neither asks nor attaches", async () => {
    await setup({ attachAfterEnablingDebug: "always" });
    await enable();
    expect(attachCalls).toBe(1);
    expect(messages.some((m) => m.includes("Attach the debugger now?"))).toBe(false);

    await setup({ attachAfterEnablingDebug: "never" });
    await enable();
    expect(attachCalls).toBe(0);
    expect(messages.some((m) => m.includes("Attach the debugger now?"))).toBe(false);
  });

  it("does not ask when our debugger is already attached", async () => {
    await setup();
    vscodeMock.debug.activeDebugSession = { type: "coreclr", name: "Attach to MES Host" };
    await enable();
    expect(messages.some((m) => m.includes("Attach the debugger now?"))).toBe(false);
    expect(attachCalls).toBe(0);
  });
});
