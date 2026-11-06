/**
 * DEE files in subfolders and several Data packages (ADR 0012): which local file is opened,
 * uploaded and debugged; DeeDevBase-format files are never rewritten except by write-back.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  __fireDidSave,
  __getCommand,
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
import { GENERATED_MARKERS, LEGACY_MARKERS } from "../src/core/deeFile";
import { DeeAction } from "../src/core/types";
import { syncCompare } from "../src/vscode/sync";

const generated = (body: string, validation = "return true;"): string =>
  [
    "using System;",
    "namespace Cmf.Foundation.Common.DynamicExpressionEvaluator.Runtime {",
    GENERATED_MARKERS.actionStart,
    body,
    GENERATED_MARKERS.actionEnd,
    GENERATED_MARKERS.validationStart,
    validation,
    GENERATED_MARKERS.validationEnd,
    "}",
  ].join("\n");

const legacy = (body: string, eol = "\n"): string =>
  [
    "namespace Cmf.Custom.Tenant.Actions",
    "{",
    "    public class Act : DeeDevBase",
    "    {",
    "        public override bool DeeTestCondition(Dictionary<string, object> Input)",
    "        {",
    `            ${LEGACY_MARKERS.validationStart}`,
    "            return true;",
    `            ${LEGACY_MARKERS.validationEnd}`,
    "        }",
    "        public override Dictionary<string, object> DeeActionCode(Dictionary<string, object> Input)",
    "        {",
    `            ${LEGACY_MARKERS.actionStart}`,
    `            ${body}`,
    `            ${LEGACY_MARKERS.actionEnd}`,
    "            return Input;",
    "        }",
    "    }",
    "}",
  ].join(eol);

class FakeSecrets {
  async get(): Promise<string | undefined> {
    return undefined;
  }
  async store(): Promise<void> {}
  async delete(): Promise<void> {}
}

interface Harness {
  root: string;
  dees: string;
  sessions: SessionStore;
  getActionFullCode: ReturnType<typeof vi.fn>;
  output: string[];
}

/** Workspace with a cmf-cli Data package; `files` are written relative to the workspace root. */
async function harness(files: Record<string, string>, opts: { deesFolder?: string | string[] } = {}): Promise<Harness> {
  __reset();
  __resetCommands();
  const root = await mkdtemp(path.join(tmpdir(), "dee-sub-"));
  const dees = path.join(root, "Cmf.Custom.Data", "DEEs");
  await mkdir(dees, { recursive: true });
  await writeFile(path.join(dees, "DeeDevBase.cs"), "public abstract class DeeDevBase {}", "utf8");
  const all: string[] = [path.join(dees, "DeeDevBase.cs")];
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    all.push(full);
  }
  __setWorkspaceFolders([{ uri: { fsPath: root } }]);
  __setConfig({
    environments: [{ name: "local", hostAddress: "http://localhost" }],
    activeEnvironment: "local",
    ...(opts.deesFolder !== undefined ? { deesFolder: opts.deesFolder } : {}),
  });
  // Faithful-enough findFiles: honor the glob's base folder and the DeeDevBase.cs search.
  __setFindFiles(async (include) => {
    if (typeof include === "string" && include.endsWith("DeeDevBase.cs")) {
      return all.filter((f) => f.endsWith("DeeDevBase.cs")).map((fsPath) => ({ fsPath }));
    }
    const base = (include as { base?: string } | undefined)?.base;
    return all.filter((f) => f.endsWith(".cs") && (!base || f.startsWith(`${base}${path.sep}`))).map((fsPath) => ({ fsPath }));
  });
  const sessions = new SessionStore();
  const output: string[] = [];
  const getActionFullCode = vi.fn(async (a: DeeAction) => generated(a.ActionCode ?? "// mes body"));
  registerCommands({ subscriptions: [], extensionPath: "/ext", globalState: { get: () => true, update: async () => undefined } } as never, {
    getClient: () => ({ getActionFullCode }) as never,
    explorer: { refresh: vi.fn(async () => undefined), allActions: () => [], isLoaded: true, rawActions: () => [], findAction: () => undefined } as never,
    sessions,
    diagnostics: { clear: () => undefined, publishServerErrors: () => 0, dispose: () => undefined } as never,
    credentials: new CredentialStore(new FakeSecrets() as never),
    output: { appendLine: (l: string) => output.push(l), show: () => undefined } as never,
    serverContent: { set: () => ({}) } as never,
  });
  return { root, dees, sessions, getActionFullCode, output };
}

const open = (action: DeeAction): Promise<void> => __getCommand("deeDebugger.openAction")!({ action }) as Promise<void>;

describe("opening an action whose file lives in a subfolder", () => {
  it("uses a generated-format file in place — no download, file untouched", async () => {
    const rel = "Cmf.Custom.Data/DEEs/Material/Act.cs";
    const h = await harness({ [rel]: generated("Input[\"x\"] = 1;") });
    await open({ Name: "Act", ActionCode: 'Input["x"] = 1;', ValidationCode: "return true;" });
    expect(h.getActionFullCode).not.toHaveBeenCalled();
    expect(h.sessions.get("Act")?.localPath).toBe(path.join(h.root, rel));
    expect(h.sessions.get("Act")?.sourcePath).toBeUndefined();
    expect(await readFile(path.join(h.root, rel), "utf8")).toBe(generated('Input["x"] = 1;'));
    expect(messages.some((m) => m.includes("differs from the MES version"))).toBe(false);
    // and no stray copy at the DEEs root
    await expect(stat(path.join(h.dees, "Act.cs"))).rejects.toThrow();
  });

  it("says so when the local file differs from the MES version", async () => {
    const h = await harness({ "Cmf.Custom.Data/DEEs/Sub/Act.cs": generated("local();") });
    await open({ Name: "Act", ActionCode: "server();", ValidationCode: "return true;" });
    expect(messages.some((m) => m.includes("Your local file for 'Act'") && m.includes("differs from the MES version"))).toBe(true);
    expect(h.getActionFullCode).not.toHaveBeenCalled();
  });
});

describe("DeeDevBase-format files are never rewritten (the data-loss fix)", () => {
  it("opens a working copy under .dee-debug with the file's own bodies; the source stays byte-identical", async () => {
    const rel = "Cmf.Custom.Data/DEEs/Act.cs"; // same path the old extension overwrote
    const original = legacy("Input[\"legacy\"] = true;");
    const h = await harness({ [rel]: original });
    await open({ Name: "Act", ActionCode: 'Input["legacy"] = true;', ValidationCode: "return true;" });

    expect(await readFile(path.join(h.root, rel), "utf8")).toBe(original);
    const copy = path.join(h.root, ".dee-debug", "Cmf.Custom.Data", "DEEs", "Act.cs");
    expect(h.sessions.get("Act")).toMatchObject({ localPath: copy, sourcePath: path.join(h.root, rel) });
    const copyText = await readFile(copy, "utf8");
    expect(copyText).toContain(GENERATED_MARKERS.actionStart); // generated format — the host can debug it
    expect(copyText).toContain('Input["legacy"] = true;');
    expect(await readFile(path.join(h.root, ".dee-debug", ".gitignore"), "utf8")).toMatch(/^\*$/m);
  });

  it("writes the working copy's bodies back into the source, keeping its format and CRLF endings", async () => {
    const rel = "Cmf.Custom.Data/DEEs/Deep/Act.cs";
    const h = await harness({ [rel]: legacy("old();", "\r\n") });
    await open({ Name: "Act" });
    const copy = h.sessions.get("Act")!.localPath;
    await writeFile(copy, (await readFile(copy, "utf8")).replace("old();", "changed();"), "utf8");

    await __getCommand("deeDebugger.writeBackToSource")!({ action: { Name: "Act" } });

    const source = await readFile(path.join(h.root, rel), "utf8");
    expect(source).toContain("changed();");
    expect(source).toContain(": DeeDevBase");
    expect(source).toContain(LEGACY_MARKERS.actionStart);
    expect(source).not.toContain(GENERATED_MARKERS.actionStart);
    expect(source.split("\r\n").length).toBeGreaterThan(5);
    expect(source.replace(/\r\n/g, "")).not.toContain("\n"); // no stray LF
  });

  it("saving the DeeDevBase source refreshes the working copy (which is what gets debugged)", async () => {
    const rel = "Cmf.Custom.Data/DEEs/Act.cs";
    const h = await harness({ [rel]: legacy("first();") });
    await open({ Name: "Act" });
    const copy = h.sessions.get("Act")!.localPath;
    const edited = legacy("second();");
    await writeFile(path.join(h.root, rel), edited, "utf8");

    await __fireDidSave({ uri: { fsPath: path.join(h.root, rel) }, getText: () => edited });

    const copyText = await readFile(copy, "utf8");
    expect(copyText).toContain("second();");
    expect(copyText).toContain(GENERATED_MARKERS.actionStart);
    expect(h.sessions.get("Act")?.pendingUpload).toBe(true);
    expect(await readFile(path.join(h.root, rel), "utf8")).toBe(edited); // source untouched by us
  });

  it("write-back on an in-place file explains there is nothing to write back to", async () => {
    await harness({ "Cmf.Custom.Data/DEEs/Act.cs": generated("x();") });
    await open({ Name: "Act" });
    await __getCommand("deeDebugger.writeBackToSource")!({ action: { Name: "Act" } });
    expect(messages.some((m) => m.includes("edited in place"))).toBe(true);
  });
});

describe("safety", () => {
  it("never overwrites an existing file that has no valid DEE markers", async () => {
    const rel = "Cmf.Custom.Data/DEEs/Act.cs";
    const h = await harness({ [rel]: "// half-edited file, markers damaged" });
    await open({ Name: "Act" });
    expect(messages.some((m) => m.includes("exists but has no valid DEE markers"))).toBe(true);
    expect(await readFile(path.join(h.root, rel), "utf8")).toBe("// half-edited file, markers damaged");
    expect(h.getActionFullCode).not.toHaveBeenCalled();
  });

  it("refuses to guess when two Data packages hold a file for the same action", async () => {
    const h = await harness(
      {
        "Cmf.Custom.Data/DEEs/Act.cs": generated("a();"),
        "Cmf.Custom.Data.Extra/DEEs/Act.cs": generated("b();"),
      },
      { deesFolder: ["Cmf.Custom.Data/DEEs", "Cmf.Custom.Data.Extra/DEEs"] },
    );
    await open({ Name: "Act" });
    expect(messages.some((m) => m.includes("Several local files belong to 'Act'"))).toBe(true);
    expect(h.sessions.get("Act")).toBeUndefined();
  });

  it("creates new actions in the primary DEE folder when no local file exists", async () => {
    const h = await harness({});
    await open({ Name: "Brand_New" });
    expect(h.getActionFullCode).toHaveBeenCalledTimes(1);
    expect(h.sessions.get("Brand_New")?.localPath).toBe(path.join(h.dees, "Brand_New.cs"));
  });
});

describe("sync covers several Data packages and skips working copies", () => {
  it("compares files from every configured DEE folder, subfolders included, but not .dee-debug", async () => {
    const h = await harness(
      {
        "Cmf.Custom.Data/DEEs/Sub/A.cs": generated("a();"),
        "Cmf.Custom.Data.Extra/DEEs/B.cs": legacy("b();"),
        ".dee-debug/Cmf.Custom.Data.Extra/DEEs/B.cs": generated("stale copy();"),
      },
      { deesFolder: ["Cmf.Custom.Data/DEEs", "Cmf.Custom.Data.Extra/DEEs"] },
    );
    let offered: string[] = [];
    __queueQuickPick((items: unknown[]) => {
      offered = (items as { label: string }[]).map((i) => i.label);
      return undefined;
    });
    await syncCompare({
      getClient: () =>
        ({
          getAllActions: async () => [
            { Name: "A", IsEnabled: true, UniversalState: 3, ActionCode: "a();", ValidationCode: "return true;" },
            { Name: "B", IsEnabled: true, UniversalState: 3, ActionCode: "server b();", ValidationCode: "return true;" },
          ],
        }) as never,
      diagnostics: {} as never,
      serverContent: {} as never,
      output: { appendLine: (l: string) => h.output.push(l) } as never,
    });
    // A matches (in sync, not offered); B differs (found in the second package, legacy format).
    expect(offered.some((l) => l.includes(" B"))).toBe(true);
    expect(offered.some((l) => l.includes(" A"))).toBe(false);
  });
});
