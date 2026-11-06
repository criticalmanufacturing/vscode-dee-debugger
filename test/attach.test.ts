import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getCommand,
  __queueInfoResponse,
  __reset,
  __resetCommands,
  __setBreakpoints,
  __setConfig,
  __setInstalledExtensions,
  __setWorkspaceFolders,
  messages,
  openedExternalUris,
} from "./mocks/vscode";

vi.mock("../src/vscode/discovery", () => ({ discoverEnvironments: vi.fn() }));

const { attachDebuggerMock } = vi.hoisted(() => ({ attachDebuggerMock: vi.fn() }));
vi.mock("../src/vscode/debugAttach", () => ({
  attachDebugger: attachDebuggerMock,
  installVsdbg: vi.fn(),
}));

import { registerCommands } from "../src/vscode/commands";
import { CredentialStore } from "../src/vscode/settings";
import { SessionStore } from "../src/vscode/session";

interface FakeMemento {
  get: (k: string, d?: unknown) => unknown;
  update: (k: string, v: unknown) => Promise<void>;
}
function memento(): FakeMemento {
  const store = new Map<string, unknown>();
  return {
    get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
    update: async (k: string, v: unknown) => {
      store.set(k, v);
    },
  };
}
function makeContext(): { subscriptions: unknown[]; globalState: FakeMemento; workspaceState: FakeMemento } {
  return { subscriptions: [], globalState: memento(), workspaceState: memento() };
}

class FakeSecrets {
  readonly store_ = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.store_.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.store_.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store_.delete(key);
  }
}

function setup(): void {
  __reset();
  __resetCommands();
  registerCommands(makeContext() as never, {
    getClient: () => ({}) as never,
    explorer: { refresh: vi.fn(async () => undefined) } as never,
    sessions: new SessionStore(),
    diagnostics: {} as never,
    credentials: new CredentialStore(new FakeSecrets() as never),
    output: { appendLine: () => undefined, show: () => undefined } as never,
    serverContent: {} as never,
  });
}

const localEnv = { environments: [{ name: "local", hostAddress: "http://localhost" }], activeEnvironment: "local" };

beforeEach(() => {
  setup();
  attachDebuggerMock.mockReset();
  attachDebuggerMock.mockResolvedValue(true);
  __setConfig(localEnv);
});

const run = (): Promise<void> => __getCommand("deeDebugger.attach")!() as Promise<void>;

describe("deeDebugger.attach (unified) — prerequisites (UX-4/UX-5)", () => {
  it("stops with an install offer when the C# extension is absent (UX-5)", async () => {
    __setInstalledExtensions([]); // no ms-dotnettools.csharp
    await run();
    expect(messages.some((m) => /C# extension.*is required/i.test(m))).toBe(true);
    expect(attachDebuggerMock).not.toHaveBeenCalled();
  });

  it("offers a Switch Environment button when no environment is selected (UX-4)", async () => {
    __setConfig({ environments: [], activeEnvironment: "" });
    await run();
    expect(messages.some((m) => /No MES environment is selected/i.test(m))).toBe(true);
    expect(attachDebuggerMock).not.toHaveBeenCalled();
  });
});

describe("deeDebugger.attach (unified) — merged source map (ADR 0009 / AC2)", () => {
  it("includes the load-bearing default /src → workspace business map and the unified session name", async () => {
    __setWorkspaceFolders(undefined); // no workspace → DEE folder skipped; business map remains
    __queueInfoResponse("Attach"); // one-time primer
    await run();
    expect(attachDebuggerMock).toHaveBeenCalledTimes(1);
    const [, sourceFileMap, , name] = attachDebuggerMock.mock.calls[0]!;
    // Merged map: the business entry is always present (DEE temp-folder entry is added too
    // when a workspace resolves — a harmless no-op otherwise).
    expect(sourceFileMap).toMatchObject({ "/src": "${workspaceFolder}" });
    expect(name).toBe("Attach to MES Host");
  });

  it("passes a custom hostSourceMap through unchanged", async () => {
    __setConfig({ ...localEnv, hostSourceMap: { "/src": "${workspaceFolder}/.." } });
    __setWorkspaceFolders([{ uri: { fsPath: "/does/not/matter" } }]);
    __queueInfoResponse("Attach");
    await run();
    const [, sourceFileMap] = attachDebuggerMock.mock.calls[0]!;
    expect(sourceFileMap).toMatchObject({ "/src": "${workspaceFolder}/.." });
  });
});

describe("deeDebugger.attach (unified) — one-time primer (UX-2)", () => {
  it("shows the primer before the first attach and not again after acknowledgement", async () => {
    __setWorkspaceFolders(undefined);
    __queueInfoResponse("Attach");
    await run();
    expect(messages.some((m) => /PORTABLE PDBs|#158143/i.test(m))).toBe(true);
    const firstCalls = attachDebuggerMock.mock.calls.length;
    expect(firstCalls).toBe(1);

    // Second run: no primer response queued; must not block the attach (flag persisted).
    messages.length = 0;
    await run();
    expect(messages.some((m) => /PORTABLE PDBs|#158143/i.test(m))).toBe(false);
    expect(attachDebuggerMock).toHaveBeenCalledTimes(2);
  });

  it("aborts the attach if the user opens the guide from the primer", async () => {
    __setWorkspaceFolders(undefined);
    __queueInfoResponse("Open guide");
    await run();
    expect(attachDebuggerMock).not.toHaveBeenCalled();
    expect(openedExternalUris.some((u) => /dee-vs-business-debugging/.test(u))).toBe(true);
  });
});

describe("deeDebugger.attach (unified) — success toast (UX-4)", () => {
  it("notes no MES sign-in and no hot-reload after a successful attach", async () => {
    __setWorkspaceFolders(undefined);
    __setBreakpoints([]);
    __queueInfoResponse("Attach");
    await run();
    expect(messages.some((m) => /no MES sign-in/i.test(m) && /hot-reload/i.test(m))).toBe(true);
  });
});

describe("deeDebugger.attach (unified) — no workspace-shape warning", () => {
  it("attaches from a folder without Cmf.Custom.* at the root without any sub-folder warning", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(`${tmpdir()}/dee-shape-`); // empty: a DEE-only workspace
    __setWorkspaceFolders([{ uri: { fsPath: dir } }]);
    __queueInfoResponse("Attach"); // one-time primer only
    await run();
    expect(attachDebuggerMock).toHaveBeenCalledTimes(1);
    expect(messages.some((m) => /No Cmf\.Custom\.\* folder|sub-folder/.test(m))).toBe(false);
  });
});

describe("deeDebugger.attach (unified) — DEE map root (ADR 0012)", () => {
  it("maps the host debug folder to the workspace root, so DEE files in subfolders resolve", async () => {
    __setWorkspaceFolders([{ uri: { fsPath: "/ws/proj" } }]);
    __queueInfoResponse("Attach");
    await run();
    const [, sourceFileMap] = attachDebuggerMock.mock.calls[0]!;
    expect(sourceFileMap["/tmp/CriticalManufacturing/dee-debug"]).toBe("/ws/proj");
  });
});
