import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { MesApiError, MesClient } from "../core/mesClient";
import { DeeAction } from "../core/types";
import { actionFileName, replaceBodies } from "../core/deeFile";
import { buildSyncPlan, serverDees, SyncEntry, uploadPayload } from "../core/syncPlan";
import { isDraftVersion } from "../core/actionVersions";
import { DeeDiagnostics } from "./diagnostics";
import { resolveDeesFolders } from "./settings";
import { indexLocalDees } from "./localDees";
import { extractServerMessage } from "../core/errorMap";

export const SERVER_SCHEME = "dee-mes";

/** Serves read-only server-side content for diff editors (dee-mes:/<Action>.cs). */
export class ServerDeeContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(actionName: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: SERVER_SCHEME, path: `/${actionFileName(actionName)}` });
    this.contents.set(uri.path, content);
    this.emitter.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? "";
  }
}

export interface SyncDeps {
  getClient: () => MesClient;
  diagnostics: DeeDiagnostics;
  serverContent: ServerDeeContentProvider;
  output: { appendLine(value: string): void };
}

interface SyncContext {
  plan: SyncEntry[];
  byName: Map<string, DeeAction>;
  folder: string;
}

async function buildPlan(deps: SyncDeps): Promise<SyncContext> {
  // Every DEE folder (several Data packages), subfolders included; new files go to the first.
  const folders = await resolveDeesFolders();
  const folder = folders[0]!;
  const actions = await deps.getClient().getAllActions();
  const { list, byName } = serverDees(actions);
  const { files } = await indexLocalDees(folders, [...byName.keys()], deps.output);
  return { plan: buildSyncPlan(files, list), byName, folder };
}

const STATUS_META: Record<SyncEntry["status"], { icon: string; label: string }> = {
  modified: { icon: "$(diff)", label: "differs" },
  localOnly: { icon: "$(cloud-upload)", label: "local only (not on MES)" },
  serverOnly: { icon: "$(cloud-download)", label: "MES only (no local file)" },
  unchanged: { icon: "$(check)", label: "in sync" },
};

/** Quick-pick description: status + a draft warning when the MES side is not effective. */
function describe(entry: SyncEntry): string {
  const base = STATUS_META[entry.status].label;
  if (entry.server && !entry.server.effective) return `${base} · MES version is a draft (not effective)`;
  if (entry.server && !entry.server.enabled) return `${base} · disabled on MES`;
  return base;
}

function summarize(plan: SyncEntry[]): string {
  const count = (s: SyncEntry["status"]): number => plan.filter((e) => e.status === s).length;
  return `${count("unchanged")} in sync, ${count("modified")} differ, ${count("localOnly")} local-only, ${count("serverOnly")} MES-only`;
}

/** Open a diff editor: server content (left, read-only) vs local file (right, editable). */
async function openEntryDiff(entry: SyncEntry, deps: SyncDeps, folder: string): Promise<void> {
  if (entry.status === "serverOnly") {
    const fullCode = await deps.getClient().getActionFullCode({ Name: entry.actionName });
    const uri = deps.serverContent.set(entry.actionName, fullCode);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    return;
  }
  if (!entry.local) return;
  const localUri = vscode.Uri.file(entry.local.filePath);
  if (entry.status === "localOnly") {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(localUri), { preview: true });
    return;
  }
  // Render the server bodies inside the local file's own wrapper so the diff shows
  // only real code differences, not scaffolding noise.
  const localText = await fs.readFile(entry.local.filePath, "utf8");
  const serverView = replaceBodies(localText, entry.server!.actionCode, entry.server!.validationCode);
  const serverUri = deps.serverContent.set(entry.actionName, serverView);
  await vscode.commands.executeCommand(
    "vscode.diff",
    serverUri,
    localUri,
    `${entry.actionName}: MES ↔ ${path.relative(folder, entry.local.filePath)}`,
  );
}

export async function syncCompare(deps: SyncDeps): Promise<void> {
  const context = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Comparing local DEEs with MES…" },
    () => buildPlan(deps),
  );
  const interesting = context.plan.filter((e) => e.status !== "unchanged");
  if (interesting.length === 0) {
    void vscode.window.showInformationMessage(`All DEEs in sync (${summarize(context.plan)}).`);
    return;
  }
  const items = interesting.map((entry) => ({
    label: `${STATUS_META[entry.status].icon} ${entry.actionName}`,
    description: describe(entry),
    detail: entry.local ? path.relative(context.folder, entry.local.filePath) : undefined,
    entry,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: `DEE Sync — ${summarize(context.plan)}`,
    placeHolder: "Select an entry to inspect (diff/open). Use the sync upload/download commands to apply changes.",
    matchOnDescription: true,
  });
  if (picked) await openEntryDiff(picked.entry, deps, context.folder);
}

export async function syncUpload(deps: SyncDeps): Promise<void> {
  const context = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Comparing local DEEs with MES…" },
    () => buildPlan(deps),
  );
  const candidates = context.plan.filter((e) => e.status === "modified" || e.status === "localOnly");
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage("Nothing to upload — all local DEEs match the MES.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((entry) => ({
      label: `${STATUS_META[entry.status].icon} ${entry.actionName}`,
      description: describe(entry),
      picked: entry.status === "modified",
      entry,
    })),
    {
      title: "Upload local DEEs to MES (Compile & Save)",
      placeHolder: "Local-only entries CREATE new actions on the MES (as enabled version 1 — you are asked whether to make them effective).",
      canPickMany: true,
    },
  );
  if (!picked || picked.length === 0) return;

  const failures: string[] = [];
  /** Actions this batch CREATED that came back as drafts (Active v1) — GitHub #8. */
  const createdDrafts: DeeAction[] = [];
  let uploaded = 0;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Uploading DEEs to MES…", cancellable: true },
    async (progress, token) => {
      for (const { entry } of picked) {
        if (token.isCancellationRequested) break;
        progress.report({ message: `${entry.actionName} (${uploaded + failures.length + 1}/${picked.length})` });
        const existing = context.byName.get(entry.actionName);
        const payload = uploadPayload(existing, entry.local!);
        try {
          const saved = await deps.getClient().compileAndSave(payload);
          uploaded++;
          if (!existing && saved && isDraftVersion(saved)) createdDrafts.push(saved);
        } catch (error) {
          failures.push(entry.actionName);
          if (error instanceof MesApiError && error.isConcurrencyConflict) {
            deps.output.appendLine(
              `[sync] ${entry.actionName}: changed on the MES since the comparison — run 'Sync: Compare' again and retry.`,
            );
            continue;
          }
          const message = error instanceof MesApiError && error.details ? extractServerMessage(error.details) : String(error);
          deps.output.appendLine(`[sync] upload failed for ${entry.actionName}: ${message}`);
          try {
            const document = await vscode.workspace.openTextDocument(entry.local!.filePath);
            deps.diagnostics.publishServerErrors(document, message);
          } catch {
            // diagnostics are best-effort
          }
        }
      }
    },
  );
  const summary = `Uploaded ${uploaded}/${picked.length} DEE(s).`;
  if (failures.length > 0) {
    void vscode.window.showWarningMessage(`${summary} Failed: ${failures.join(", ")} (see Problems/Output).`);
  } else {
    void vscode.window.showInformationMessage(summary);
  }
  if (createdDrafts.length > 0) await offerMakeEffective(createdDrafts, deps);
}

/**
 * A created action is stored as version 1 in state Active. It already runs (no version is
 * effective, so the highest runs), but a version staged later would take over until one is
 * effective. Ask once for the whole batch (GitHub #8).
 */
async function offerMakeEffective(created: DeeAction[], deps: SyncDeps): Promise<void> {
  const names = created.map((a) => a.Name).join(", ");
  const choice = await vscode.window.showWarningMessage(
    `${created.length} new action(s) created on the MES as version 1 (Active, not effective): ${names}. They run already — no version is effective, so the MES uses the highest — but a version staged later would take over. Make them effective now?`,
    { modal: true },
    "Make Effective",
    "Keep as Drafts",
  );
  if (choice !== "Make Effective") return;
  const failed: string[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Making new actions effective…" },
    async () => {
      for (const action of created) {
        try {
          await deps.getClient().makeActionVersionEffective(action);
          deps.output.appendLine(`[sync] '${action.Name}' v${action.Version ?? 1} is now effective.`);
        } catch (error) {
          failed.push(action.Name);
          deps.output.appendLine(`[sync] make effective failed for ${action.Name}: ${error instanceof Error ? error.message : error}`);
        }
      }
    },
  );
  if (failed.length > 0) {
    void vscode.window.showWarningMessage(`Could not make effective: ${failed.join(", ")} (see Output). They remain drafts.`);
  } else {
    void vscode.window.showInformationMessage(`${created.length} new action(s) are now effective.`);
  }
}

export async function syncDownload(deps: SyncDeps): Promise<void> {
  const context = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Comparing local DEEs with MES…" },
    () => buildPlan(deps),
  );
  const candidates = context.plan.filter((e) => e.status === "modified" || e.status === "serverOnly");
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage("Nothing to download — local DEEs already match the MES.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((entry) => ({
      label: `${STATUS_META[entry.status].icon} ${entry.actionName}`,
      description: describe(entry),
      picked: true,
      entry,
    })),
    {
      title: "Download DEEs from MES",
      placeHolder: "Existing files keep their layout (only marker bodies replaced); new files get the full generated wrapper.",
      canPickMany: true,
    },
  );
  if (!picked || picked.length === 0) return;

  let written = 0;
  const failures: string[] = [];
  const skippedDirty: string[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Downloading DEEs from MES…", cancellable: true },
    async (progress, token) => {
      for (const { entry } of picked) {
        if (token.isCancellationRequested) break;
        progress.report({ message: `${entry.actionName} (${written + failures.length + 1}/${picked.length})` });
        // C2 guard: writing under an open dirty editor silently loses one of the two
        // versions — skip the file, count it as a failure, and say so per file.
        const targetPath =
          entry.status === "modified"
            ? entry.local!.filePath
            : path.join(context.folder, actionFileName(entry.actionName));
        const dirty = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === targetPath && d.isDirty);
        if (dirty) {
          failures.push(entry.actionName);
          skippedDirty.push(entry.actionName);
          deps.output.appendLine(
            `[sync] skipped ${entry.actionName}: ${targetPath} has unsaved changes in an open editor — save or revert it and retry.`,
          );
          continue;
        }
        try {
          if (entry.status === "modified") {
            const localText = await fs.readFile(entry.local!.filePath, "utf8");
            await fs.writeFile(
              entry.local!.filePath,
              replaceBodies(localText, entry.server!.actionCode, entry.server!.validationCode),
              "utf8",
            );
          } else {
            // ADR 0012: a file of that name the index could not parse (damaged markers, or not
            // a DEE file) is never overwritten — it may hold the only copy of someone's work.
            if (await fs.stat(targetPath).catch(() => undefined)) {
              throw new Error(`${targetPath} exists but has no valid DEE markers — not overwritten; fix or move it and retry`);
            }
            const action = context.byName.get(entry.actionName) ?? { Name: entry.actionName };
            const fullCode = await deps.getClient().getActionFullCode(action);
            await fs.mkdir(context.folder, { recursive: true });
            await fs.writeFile(targetPath, fullCode, "utf8");
          }
          written++;
        } catch (error) {
          failures.push(entry.actionName);
          deps.output.appendLine(`[sync] download failed for ${entry.actionName}: ${error instanceof Error ? error.message : error}`);
        }
      }
    },
  );
  const failedOther = failures.filter((name) => !skippedDirty.includes(name));
  const parts = [`Downloaded ${written}/${picked.length} DEE(s) to ${context.folder}.`];
  if (skippedDirty.length > 0) {
    parts.push(`Skipped (unsaved editor changes): ${skippedDirty.join(", ")} — save or revert and retry.`);
  }
  if (failedOther.length > 0) parts.push(`Failed: ${failedOther.join(", ")} (see Output).`);
  if (failures.length > 0) {
    void vscode.window.showWarningMessage(parts.join(" "));
  } else {
    void vscode.window.showInformationMessage(parts.join(" "));
  }
}
