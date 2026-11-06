/**
 * GitHub #7 / #8 — action lifecycle in the VS Code layer: creating an action, making a
 * version effective, what the tree shows for drafts, and what sync upload sends/offers
 * for new local DEEs.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  __addTextDocument,
  __getCommand,
  __queueInfoResponse,
  __queueInputBox,
  __queueQuickPick,
  __reset,
  __resetCommands,
  __setConfig,
  __setFindFiles,
  __setWorkspaceFolders,
  messages,
} from "./mocks/vscode";
import { registerCommands } from "../src/vscode/commands";
import { SessionStore } from "../src/vscode/session";
import { CredentialStore } from "../src/vscode/settings";
import { DeeExplorerProvider } from "../src/vscode/explorer";
import { syncUpload } from "../src/vscode/sync";
import { GENERATED_MARKERS, NEW_ACTION_CODE_TEMPLATE } from "./helpers/markers";
import { DeeAction, UniversalState } from "../src/core/types";
import { MesClient } from "../src/core/mesClient";

const wrapper = (body: string): string =>
  [
    "using System;",
    GENERATED_MARKERS.actionStart,
    body,
    GENERATED_MARKERS.actionEnd,
    GENERATED_MARKERS.validationStart,
    "return true;",
    GENERATED_MARKERS.validationEnd,
  ].join("\n");

class FakeSecrets {
  async get(): Promise<string | undefined> {
    return undefined;
  }
  async store(): Promise<void> {}
  async delete(): Promise<void> {}
}

interface Harness {
  client: {
    createAction: ReturnType<typeof vi.fn>;
    makeActionVersionEffective: ReturnType<typeof vi.fn>;
    getActionById: ReturnType<typeof vi.fn>;
    getActionByName: ReturnType<typeof vi.fn>;
    getActionFullCode: ReturnType<typeof vi.fn>;
    compileAndSave: ReturnType<typeof vi.fn>;
  };
  sessions: SessionStore;
  output: string[];
  folder: string;
}

async function harness(rawActions: DeeAction[] = [], treeRow?: DeeAction): Promise<Harness> {
  __reset();
  __resetCommands();
  const folder = await mkdtemp(path.join(tmpdir(), "dee-lifecycle-"));
  __setWorkspaceFolders([{ uri: { fsPath: folder } }]);
  __setConfig({ deesFolder: folder });
  const sessions = new SessionStore();
  const output: string[] = [];
  const client = {
    createAction: vi.fn(async (a: DeeAction) => ({ ...a, Id: "900", Version: 1, UniversalState: UniversalState.Active })),
    makeActionVersionEffective: vi.fn(async (a: DeeAction) => ({ ...a, UniversalState: UniversalState.Effective })),
    getActionById: vi.fn(async () => ({ Name: "x" })),
    getActionByName: vi.fn(async () => ({ Name: "x" })),
    getActionFullCode: vi.fn(async (a: DeeAction) => wrapper(a.ActionCode ?? "")),
    compileAndSave: vi.fn(),
  };
  registerCommands({ subscriptions: [] } as never, {
    getClient: () => client as never,
    explorer: {
      refresh: vi.fn(async () => undefined),
      allActions: () => [],
      isLoaded: true,
      rawActions: () => rawActions,
      findAction: (name: string) => (treeRow && treeRow.Name === name ? { action: treeRow } : undefined),
      setFilter: () => undefined,
      currentFilter: undefined,
    } as never,
    sessions,
    diagnostics: { clear: () => undefined, publishServerErrors: () => 0, dispose: () => undefined } as never,
    credentials: new CredentialStore(new FakeSecrets() as never),
    output: { appendLine: (line: string) => output.push(line) } as never,
    serverContent: {} as never,
  });
  return { client, sessions, output, folder };
}

describe("New DEE Action… (GitHub #8)", () => {
  it("creates an enabled action with the MES UI template, makes v1 effective, and opens it locally", async () => {
    const h = await harness([{ Name: "Existing", Classification: "Tenant" }]);
    __queueInputBox("Fresh"); // name
    __queueInputBox("A new rule"); // description
    __queueQuickPick((items) => (items as { value?: string }[]).find((i) => i.value === "Tenant")); // classification
    __queueQuickPick((items) => (items as { makeEffective: boolean }[]).find((i) => i.makeEffective)); // effective

    await __getCommand("deeDebugger.createAction")!();

    expect(h.client.createAction).toHaveBeenCalledTimes(1);
    const payload = h.client.createAction.mock.calls[0]![0] as DeeAction;
    expect(payload).toMatchObject({
      Name: "Fresh",
      Description: "A new rule",
      Classification: "Tenant",
      IsEnabled: true,
      ActionCode: NEW_ACTION_CODE_TEMPLATE,
      ValidationCode: "return true;",
    });
    expect(payload.Id).toBeUndefined();
    // Promotion uses the entity the host just returned (fresh concurrency token), no re-fetch.
    expect(h.client.makeActionVersionEffective).toHaveBeenCalledTimes(1);
    expect((h.client.makeActionVersionEffective.mock.calls[0]![0] as DeeAction).Id).toBe("900");
    expect(h.client.getActionById).not.toHaveBeenCalled();
    // Materialized locally as <Name>.cs and tracked as a session.
    expect(await readFile(path.join(h.folder, "Fresh.cs"), "utf8")).toContain(GENERATED_MARKERS.actionStart);
    expect(h.sessions.get("Fresh")?.action.UniversalState).toBe(UniversalState.Effective);
    expect(messages.some((m) => m.includes("created and effective"))).toBe(true);
  });

  it("can create a draft (no promotion) and says so", async () => {
    const h = await harness();
    __queueInputBox("Draft1");
    __queueInputBox("");
    __queueQuickPick((items) => (items as { value?: string }[])[0]); // no classification
    __queueQuickPick((items) => (items as { makeEffective: boolean }[]).find((i) => !i.makeEffective));

    await __getCommand("deeDebugger.createAction")!();

    expect(h.client.createAction).toHaveBeenCalledTimes(1);
    expect(h.client.makeActionVersionEffective).not.toHaveBeenCalled();
    expect(messages.some((m) => m.includes("created as a draft"))).toBe(true);
  });

  it("refuses a name the host would reject or that already exists (no server call)", async () => {
    const h = await harness([{ Name: "Taken" }]);
    __queueInputBox("taken"); // duplicate, case-insensitive → validation blocks → cancel
    await __getCommand("deeDebugger.createAction")!();
    __queueInputBox("1bad"); // not an identifier
    await __getCommand("deeDebugger.createAction")!();
    expect(h.client.createAction).not.toHaveBeenCalled();
  });

  it("supports a free-text classification via 'Other…'", async () => {
    const h = await harness();
    __queueInputBox("WithOther");
    __queueInputBox("");
    __queueQuickPick((items) => (items as { value?: string }[]).find((i) => i.value === undefined)); // Other…
    __queueInputBox("Custom.Class");
    __queueQuickPick((items) => (items as { makeEffective: boolean }[])[1]);
    await __getCommand("deeDebugger.createAction")!();
    expect((h.client.createAction.mock.calls[0]![0] as DeeAction).Classification).toBe("Custom.Class");
  });
});

describe("Make Version Effective (GitHub #7)", () => {
  it("re-fetches by Id and promotes an Active version", async () => {
    const h = await harness();
    h.client.getActionById.mockResolvedValue({ Id: "5", Name: "Act", Version: 1, UniversalState: UniversalState.Active });
    await __getCommand("deeDebugger.makeVersionEffective")!({ action: { Id: "5", Name: "Act" } });
    expect(h.client.makeActionVersionEffective).toHaveBeenCalledTimes(1);
    expect(messages.some((m) => m.includes("is now effective"))).toBe(true);
  });

  it("does nothing for an already-effective version and refuses non-Active drafts (host rule)", async () => {
    const h = await harness();
    h.client.getActionByName.mockResolvedValue({ Name: "Eff", Version: 2, UniversalState: "Effective" });
    await __getCommand("deeDebugger.makeVersionEffective")!({ action: { Name: "Eff" } });
    h.client.getActionByName.mockResolvedValue({ Name: "Frozen", Version: 1, UniversalState: UniversalState.Frozen });
    await __getCommand("deeDebugger.makeVersionEffective")!({ action: { Name: "Frozen" } });
    expect(h.client.makeActionVersionEffective).not.toHaveBeenCalled();
    expect(messages.some((m) => m.includes("already effective"))).toBe(true);
    expect(messages.some((m) => m.includes("only Active versions"))).toBe(true);
  });
});

describe("Save Action to MES into a draft version (GitHub #7)", () => {
  it("tells the user the saved version is not effective and offers to promote it", async () => {
    const h = await harness();
    const localPath = path.join(h.folder, "Draft.cs");
    await writeFile(localPath, wrapper("x = 1;"), "utf8");
    __addTextDocument(localPath, wrapper("x = 1;"));
    h.sessions.upsert({ action: { Id: "9", Name: "Draft" }, localPath, debugOn: false, pendingUpload: true });
    h.client.compileAndSave.mockResolvedValue({ Id: "9", Name: "Draft", Version: 1, UniversalState: UniversalState.Active });
    __queueInfoResponse("Make Effective");

    await __getCommand("deeDebugger.uploadAction")!({ action: { Id: "9", Name: "Draft" } });

    expect(messages.some((m) => m.includes("a draft (Active, not effective)") && m.includes("already runs its highest version (v1)"))).toBe(true);
    expect(h.client.makeActionVersionEffective).toHaveBeenCalledTimes(1);
    expect(h.sessions.get("Draft")?.action.UniversalState).toBe(UniversalState.Effective);
  });

  it("for a staged version beside an effective one, says the effective version keeps running", async () => {
    const h = await harness([], { Id: "1", Name: "Staged", Version: 2, UniversalState: UniversalState.Effective });
    const localPath = path.join(h.folder, "Staged.cs");
    await writeFile(localPath, wrapper("x = 3;"), "utf8");
    __addTextDocument(localPath, wrapper("x = 3;"));
    h.sessions.upsert({ action: { Id: "9", Name: "Staged" }, localPath, debugOn: false, pendingUpload: true });
    h.client.compileAndSave.mockResolvedValue({ Id: "9", Name: "Staged", Version: 3, UniversalState: UniversalState.Active });

    await __getCommand("deeDebugger.uploadAction")!({ action: { Id: "9", Name: "Staged" } });

    expect(messages.some((m) => m.includes("The MES keeps running v2 (effective) until v3 is made effective."))).toBe(true);
    expect(messages.some((m) => m.includes("already runs"))).toBe(false);
  });

  it("stays quiet when the saved version is effective", async () => {
    const h = await harness();
    const localPath = path.join(h.folder, "Eff.cs");
    await writeFile(localPath, wrapper("x = 1;"), "utf8");
    __addTextDocument(localPath, wrapper("x = 1;"));
    h.sessions.upsert({ action: { Id: "1", Name: "Eff" }, localPath, debugOn: false, pendingUpload: true });
    h.client.compileAndSave.mockResolvedValue({ Id: "1", Name: "Eff", Version: 3, UniversalState: 3 });
    await __getCommand("deeDebugger.uploadAction")!({ action: { Id: "1", Name: "Eff" } });
    // Routine success is a status-bar message now (usability pass) — no toast at all.
    expect(messages).toEqual([]);
  });
});

describe("DEE Explorer rows for drafts and hidden disabled actions (GitHub #7)", () => {
  it("shows a draft action with a 'not effective' badge and a draft context value; counts hidden disabled ones", async () => {
    __reset();
    const client = {
      getAllActionGroups: async () => [],
      getAllActions: async () => [
        { Name: "Draft", IsEnabled: true, Version: 1, UniversalState: UniversalState.Active },
        { Name: "Live", IsEnabled: true, Version: 2, UniversalState: UniversalState.Effective },
        { Name: "Off", IsEnabled: false, Version: 1, UniversalState: UniversalState.Effective },
      ],
    } as unknown as MesClient;
    const provider = new DeeExplorerProvider(() => client, () => false, new SessionStore());
    await provider.refresh();
    const names = provider.allActions().map((r) => r.action.Name);
    expect(names).toEqual(["Draft", "Live"]);

    const draftItem = provider.getTreeItem(provider.findAction("Draft")!);
    expect(draftItem.contextValue).toBe("deeAction-draft");
    expect(String(draftItem.description)).toContain("not effective (Active)");
    const liveItem = provider.getTreeItem(provider.findAction("Live")!);
    expect(liveItem.contextValue).toBe("deeAction");
    expect(String(liveItem.description)).not.toContain("not effective");

    const rootRows = provider.getChildren() as { info?: string; command?: string }[];
    const hiddenRow = rootRows.find((r) => r.info?.includes("disabled action"));
    expect(hiddenRow?.info).toBe("1 disabled action hidden — click to show");
    expect(hiddenRow?.command).toBe("deeDebugger.toggleShowDisabledActions");
  });
});

describe("Sync: Upload of a new local DEE (GitHub #8)", () => {
  it("creates it ENABLED with the local bodies, then offers to make the new v1 effective", async () => {
    __reset();
    const folder = await mkdtemp(path.join(tmpdir(), "dee-sync-up-"));
    const filePath = path.join(folder, "Brand.cs");
    await writeFile(filePath, wrapper("Input[\"n\"] = 1;"), "utf8");
    __setWorkspaceFolders([{ uri: { fsPath: folder } }]);
    __setConfig({ deesFolder: folder });
    __setFindFiles(async () => [{ fsPath: filePath }]);
    const compileAndSave = vi.fn(async (a: DeeAction) => ({ ...a, Id: "77", Version: 1, UniversalState: UniversalState.Active }));
    const makeActionVersionEffective = vi.fn(async (a: DeeAction) => ({ ...a, UniversalState: UniversalState.Effective }));
    const output: string[] = [];
    __queueQuickPick((items) => items); // upload everything offered (local-only is unchecked by default, but selectable)
    __queueInfoResponse("Make Effective");

    await syncUpload({
      getClient: () => ({ getAllActions: async () => [], compileAndSave, makeActionVersionEffective }) as never,
      diagnostics: { clear: () => undefined, publishServerErrors: () => 0, dispose: () => undefined } as never,
      serverContent: {} as never,
      output: { appendLine: (line: string) => output.push(line) } as never,
    });

    expect(compileAndSave).toHaveBeenCalledTimes(1);
    const payload = compileAndSave.mock.calls[0]![0] as DeeAction;
    expect(payload).toMatchObject({ Name: "Brand", IsEnabled: true, ActionCode: 'Input["n"] = 1;', ValidationCode: "return true;" });
    expect(payload.Id).toBeUndefined();
    expect(messages.some((m) => m.includes("new action(s) created on the MES as version 1"))).toBe(true);
    expect(makeActionVersionEffective).toHaveBeenCalledTimes(1);
    expect((makeActionVersionEffective.mock.calls[0]![0] as DeeAction).Id).toBe("77");
    expect(messages.some((m) => m.includes("are now effective"))).toBe(true);
  });

  it("does not offer promotion when only existing actions were updated", async () => {
    __reset();
    const folder = await mkdtemp(path.join(tmpdir(), "dee-sync-up2-"));
    const filePath = path.join(folder, "Known.cs");
    await writeFile(filePath, wrapper("changed;"), "utf8");
    __setWorkspaceFolders([{ uri: { fsPath: folder } }]);
    __setConfig({ deesFolder: folder });
    __setFindFiles(async () => [{ fsPath: filePath }]);
    const existing = { Id: "1", Name: "Known", IsEnabled: true, UniversalState: 3, Version: 2, ActionCode: "old;", ValidationCode: "return true;" };
    const compileAndSave = vi.fn(async (a: DeeAction) => a);
    const makeActionVersionEffective = vi.fn();
    __queueQuickPick((items) => items);

    await syncUpload({
      getClient: () => ({ getAllActions: async () => [existing], compileAndSave, makeActionVersionEffective }) as never,
      diagnostics: { clear: () => undefined, publishServerErrors: () => 0, dispose: () => undefined } as never,
      serverContent: {} as never,
      output: { appendLine: () => undefined } as never,
    });

    expect((compileAndSave.mock.calls[0]![0] as DeeAction).Id).toBe("1"); // echoed entity, not a create
    expect(makeActionVersionEffective).not.toHaveBeenCalled();
    expect(messages.some((m) => m.includes("created on the MES"))).toBe(false);
  });
});
