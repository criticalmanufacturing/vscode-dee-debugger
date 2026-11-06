/**
 * Usability pass (2026-10-18): group counts, badge priority, state-specific debug commands,
 * MES UI deep link, and low-stakes confirmations moving off toasts.
 */
import { describe, expect, it, vi } from "vitest";
import * as vscodeMock from "./mocks/vscode";
import { __getCommand, __reset, __resetCommands, __setConfig, messages, openedExternalUris } from "./mocks/vscode";
import { DeeExplorerProvider, countActions } from "../src/vscode/explorer";
import { SessionStore } from "../src/vscode/session";
import { MesClient } from "../src/core/mesClient";
import { UniversalState } from "../src/core/types";
import { mesUiEntityUrl } from "../src/core/env";
import { registerCommands } from "../src/vscode/commands";
import { CredentialStore } from "../src/vscode/settings";

class FakeSecrets {
  async get(): Promise<string | undefined> {
    return undefined;
  }
  async store(): Promise<void> {}
  async delete(): Promise<void> {}
}

describe("DEE Explorer group rows show how many actions they hold", () => {
  it("counts actions recursively and puts the number in the row description", async () => {
    __reset();
    const client = {
      getAllActionGroups: async () => [{ Name: "A.B" }, { Name: "A.C" }, { Name: "Empty" }],
      getAllActions: async () => [
        { Name: "one", IsEnabled: true, UniversalState: 3, ActionGroupActions: [{ ActionGroup: { Name: "A.B" } }] },
        { Name: "two", IsEnabled: true, UniversalState: 3, ActionGroupActions: [{ ActionGroup: { Name: "A.B" } }, { ActionGroup: { Name: "A.C" } }] },
      ],
    } as unknown as MesClient;
    const provider = new DeeExplorerProvider(() => client, () => false, new SessionStore());
    await provider.refresh();
    const groups = (provider.getChildren() as { fullName?: string }[]).filter((n) => n.fullName !== undefined);
    const a = groups.find((g) => g.fullName === "A")!;
    const empty = groups.find((g) => g.fullName === "Empty")!;
    expect(countActions(a as never)).toBe(3); // one + two (A.B) + two (A.C)
    expect(provider.getTreeItem(a as never).description).toBe("3");
    expect(provider.getTreeItem(empty as never).description).toBeUndefined();
    expect(String(provider.getTreeItem(a as never).tooltip)).toContain("3 actions");
  });
});

describe("Action row badges are ordered by what needs attention", () => {
  it("DEBUG and pending upload come before lifecycle badges and the version", async () => {
    __reset();
    const sessions = new SessionStore();
    const client = {
      getAllActionGroups: async () => [],
      getAllActions: async () => [{ Name: "act", IsEnabled: false, Version: 4, UniversalState: UniversalState.Active }],
    } as unknown as MesClient;
    const provider = new DeeExplorerProvider(() => client, () => true, sessions);
    await provider.refresh();
    sessions.upsert({ action: { Name: "act" }, localPath: "/x/act.cs", debugOn: true, pendingUpload: true });
    const item = provider.getTreeItem(provider.findAction("act")!);
    expect(item.description).toBe("DEBUG · pending upload · not effective (Active) · disabled · v4");
    expect(item.contextValue).toBe("deeAction-debug-draft");
  });
});

describe("mesUiEntityUrl", () => {
  it("builds the MES UI entity deep link and tolerates trailing slashes", () => {
    expect(mesUiEntityUrl("http://localhost/", "Action", "2610100000010000001")).toBe("http://localhost/Entity/Action/2610100000010000001");
    expect(mesUiEntityUrl("http://localhost", "Action", undefined)).toBeUndefined();
    expect(mesUiEntityUrl("", "Action", "1")).toBeUndefined();
  });
});

describe("Getting Started command", () => {
  it("opens this extension's walkthrough", async () => {
    __reset();
    __resetCommands();
    const opened: unknown[][] = [];
    vscodeMock.commands.registerCommand("workbench.action.openWalkthrough", (...args: unknown[]) => void opened.push(args));
    registerCommands({ subscriptions: [], extension: { id: "CriticalManufacturing.dee-debugger" }, globalState: { get: () => undefined, update: async () => undefined } } as never, {
      getClient: () => ({}) as never,
      explorer: {} as never,
      sessions: new SessionStore(),
      diagnostics: {} as never,
      credentials: new CredentialStore(new FakeSecrets() as never),
      output: { appendLine: () => undefined } as never,
      serverContent: {} as never,
    });
    await __getCommand("deeDebugger.openGettingStarted")!();
    expect(opened).toEqual([["CriticalManufacturing.dee-debugger#deeDebugger.gettingStarted", false]]);
  });
});

describe("commands added by the usability pass", () => {
  function setup(): { sessions: SessionStore; output: { lines: string[]; shown: number } } {
    __reset();
    __resetCommands();
    __setConfig({ environments: [{ name: "local", hostAddress: "http://localhost" }], activeEnvironment: "local" });
    const sessions = new SessionStore();
    const output = { lines: [] as string[], shown: 0 };
    registerCommands({ subscriptions: [], extensionPath: "/ext", globalState: { get: () => undefined, update: async () => undefined } } as never, {
      getClient: () => ({}) as never,
      explorer: { refresh: vi.fn(async () => undefined), allActions: () => [], isLoaded: true, rawActions: () => [] } as never,
      sessions,
      diagnostics: {} as never,
      credentials: new CredentialStore(new FakeSecrets() as never),
      output: { appendLine: (l: string) => output.lines.push(l), show: () => output.shown++ } as never,
      serverContent: {} as never,
    });
    return { sessions, output };
  }

  it("Enable/Disable DEE Debug Mode are registered as aliases of the toggle", () => {
    setup();
    expect(__getCommand("deeDebugger.enableDebugMode")).toBeDefined();
    expect(__getCommand("deeDebugger.disableDebugMode")).toBeDefined();
    expect(__getCommand("deeDebugger.toggleDebugMode")).toBeDefined();
  });

  it("Open in MES UI opens the entity page for the action, and explains when there is no Id", async () => {
    setup();
    await __getCommand("deeDebugger.openInMesUi")!({ action: { Id: "42", Name: "act" } });
    expect(openedExternalUris).toEqual(["http://localhost/Entity/Action/42"]);
    await __getCommand("deeDebugger.openInMesUi")!({ action: { Name: "noid" } });
    expect(messages.some((m) => m.includes("has no Id yet"))).toBe(true);
  });

  it("Show Output Log reveals the channel", async () => {
    const { output } = setup();
    await __getCommand("deeDebugger.showOutput")!();
    expect(output.shown).toBe(1);
  });
});
