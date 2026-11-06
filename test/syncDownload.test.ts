import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  __addTextDocument,
  __getCommand,
  __queueQuickPick,
  __reset,
  __resetCommands,
  __setConfig,
  __setFindFiles,
  __setWorkspaceFolders,
  messages,
} from "./mocks/vscode";
import { syncDownload } from "../src/vscode/sync";
import { registerCommands } from "../src/vscode/commands";
import { SessionStore } from "../src/vscode/session";
import { CredentialStore } from "../src/vscode/settings";
import { GENERATED_MARKERS } from "../src/core/deeFile";

const wrapper = (body: string): string =>
  [
    "using System;",
    GENERATED_MARKERS.actionStart,
    body,
    GENERATED_MARKERS.actionEnd,
    GENERATED_MARKERS.validationStart,
    GENERATED_MARKERS.validationEnd,
  ].join("\n");

class FakeSecrets {
  async get(): Promise<string | undefined> {
    return undefined;
  }
  async store(): Promise<void> {}
  async delete(): Promise<void> {}
}

async function setupFolder(): Promise<{ folder: string; filePath: string; output: string[] }> {
  __reset();
  const folder = await mkdtemp(path.join(tmpdir(), "dee-sync-"));
  const filePath = path.join(folder, "act.cs");
  await writeFile(filePath, wrapper("local body"), "utf8");
  __setWorkspaceFolders([{ uri: { fsPath: folder } }]);
  __setConfig({ deesFolder: folder });
  __setFindFiles(async () => [{ fsPath: filePath }]);
  return { folder, filePath, output: [] };
}

function syncDeps(output: string[]): Parameters<typeof syncDownload>[0] {
  return {
    getClient: () =>
      ({
        getAllActions: async () => [
          {
            Name: "act",
            IsEnabled: true,
            UniversalState: "Effective",
            ActionCode: "server body",
            ValidationCode: "",
          },
        ],
        getActionFullCode: async () => wrapper("server body"),
      }) as never,
    diagnostics: { clear: () => undefined, publishServerErrors: () => 0, dispose: () => undefined } as never,
    serverContent: {} as never,
    output: { appendLine: (line: string) => output.push(line) } as never,
  };
}

describe("syncDownload vs open dirty editors (C2)", () => {
  it("skips a file with an open dirty editor, reports it, and leaves the disk copy alone", async () => {
    const { filePath, output } = await setupFolder();
    __addTextDocument(filePath, "unsaved editor content", true);
    __queueQuickPick((items) => items); // download everything offered

    await syncDownload(syncDeps(output));

    expect(await readFile(filePath, "utf8")).toBe(wrapper("local body")); // untouched
    expect(output.some((l) => l.includes("unsaved changes"))).toBe(true);
    expect(messages.some((m) => m.includes("Skipped (unsaved editor changes): act"))).toBe(true);
    expect(messages.some((m) => m.includes("Downloaded 0/1"))).toBe(true);
  });

  it("writes the server bodies when the file is not dirty", async () => {
    const { filePath, output } = await setupFolder();
    __addTextDocument(filePath, wrapper("local body"), false); // open but clean
    __queueQuickPick((items) => items);

    await syncDownload(syncDeps(output));

    expect(await readFile(filePath, "utf8")).toContain("server body");
    expect(messages.some((m) => m.includes("Downloaded 1/1"))).toBe(true);
    expect(messages.some((m) => m.includes("Skipped"))).toBe(false);
  });
});

describe("syncDownload never overwrites an unparseable file (ADR 0012)", () => {
  it("skips a MES-only action whose file name is taken by a file without valid markers", async () => {
    const { folder, output } = await setupFolder();
    const damaged = path.join(folder, "act.cs");
    await writeFile(damaged, "// markers damaged, work in progress", "utf8");
    __queueQuickPick((items) => items);

    await syncDownload(syncDeps(output));

    expect(await readFile(damaged, "utf8")).toBe("// markers damaged, work in progress");
    expect(output.some((l) => l.includes("no valid DEE markers"))).toBe(true);
    expect(messages.some((m) => m.includes("Failed: act"))).toBe(true);
  });
});

describe("materialize vs open dirty editors (C2)", () => {
  it("openAction refuses to overwrite a dirty editor instead of clobbering it", async () => {
    __resetCommands();
    const folder = await mkdtemp(path.join(tmpdir(), "dee-mat-"));
    __reset();
    __setWorkspaceFolders([{ uri: { fsPath: folder } }]);
    __setConfig({ deesFolder: folder });
    const filePath = path.join(folder, "act.cs");
    __addTextDocument(filePath, "unsaved editor content", true);
    const getActionFullCode = vi.fn(async () => wrapper("server body"));
    registerCommands({ subscriptions: [] } as never, {
      getClient: () => ({ getActionFullCode }) as never,
      explorer: {
        refresh: vi.fn(async () => undefined),
        allActions: () => [],
        isLoaded: true,
        rawActions: () => [],
        findAction: () => undefined,
        setFilter: () => undefined,
        currentFilter: undefined,
      } as never,
      sessions: new SessionStore(),
      diagnostics: { clear: () => undefined, publishServerErrors: () => 0, dispose: () => undefined } as never,
      credentials: new CredentialStore(new FakeSecrets() as never),
      output: { appendLine: () => undefined } as never,
      serverContent: {} as never,
    });

    await __getCommand("deeDebugger.openAction")!({ action: { Name: "act" } });

    expect(messages.some((m) => m.includes("unsaved changes"))).toBe(true);
    expect(getActionFullCode).not.toHaveBeenCalled();
    await expect(stat(filePath)).rejects.toThrow(); // nothing written to disk
  });
});
