import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { MesApiError, MesClient } from "../core/mesClient";
import { DeeAction } from "../core/types";
import { extractBodies, replaceBodies, validateMarkers } from "../core/deeFile";
import { codeEquals } from "../core/syncPlan";
import { findIndexed, planLocalFile } from "../core/localDees";
import { ensureWorkingCopyFolder, indexLocalDees } from "./localDees";
import { extractServerMessage, parseHostErrors } from "../core/errorMap";
import { ActionRef } from "../core/treeModel";
import { DeeExplorerProvider, DeeTreeNode } from "./explorer";
import { SessionStore } from "./session";
import { DeeDiagnostics } from "./diagnostics";
import {
  CredentialStore,
  readSettings,
  resolveDeesFolder,
  resolveDeesFolders,
  setActiveEnvironment,
  workspaceRoot,
  updateSettingInOwningScope,
} from "./settings";
import { decodeCmfValues } from "../core/cmfData";
import {
  canMakeEffective,
  draftExecutionNote,
  isDraftVersion,
  knownClassifications,
  newActionPayload,
  stateName,
  validateActionName,
} from "../core/actionVersions";
import { createFileBridge, md5Hex, runCli } from "./fileBridge";
import { attachDebugger, installVsdbg } from "./debugAttach";
import { applyHostPatch, checkHostPatchPrereqs, checkHostPatchState, restartHost, restoreHostDll } from "./hostPatch";
import {
  DEFAULT_HOST_APP_DIR,
  describeUnpatchedHost,
  hostPatchApplies,
  HostPatchState,
  isPdbCompileError,
  patchStateIsFresh,
} from "../core/hostPatch";
import { ServerDeeContentProvider, syncCompare, syncDownload, syncUpload } from "./sync";
import { discoverEnvironments } from "./discovery";
import { sameEnvironment, uniqueName } from "../core/discovery";
import { buildDockerEngineCommand, DEFAULT_HOST_ADDRESS, dindDevcontainerName, EnvironmentProfile, mesUiEntityUrl } from "../core/env";
import { execInHostArgs, listHostRuntimesArgs } from "../core/hostExec";
import { describeDotnetMismatch, parseHostRuntimeMajor, parseProjectTfmMajor } from "../core/dotnetRuntime";
import {
  resolveBusinessSourceMap,
  shouldWarnUnboundBreakpoints,
  UNBOUND_BREAKPOINT_CAUSES,
} from "../core/businessAttach";
import { redactArgvSecrets, redactSecrets } from "../core/redact";
import { decodeJwt } from "../core/jwt";
import { SupportLogger } from "./logging";

export interface CommandDeps {
  getClient: () => MesClient;
  explorer: DeeExplorerProvider;
  sessions: SessionStore;
  diagnostics: DeeDiagnostics;
  credentials: CredentialStore;
  output: SupportLogger;
  serverContent: ServerDeeContentProvider;
}

function isActionNode(node: DeeTreeNode | undefined): node is ActionRef {
  return !!node && (node as ActionRef).action !== undefined;
}

/** The Microsoft C# extension that ships vsdbg + the coreclr debug type (ADR 0001). */
const CSHARP_EXTENSION_ID = "ms-dotnettools.csharp";
/** globalState key gating the one-time business-attach prerequisites primer (UX-2). */
const BUSINESS_PRIMER_KEY = "deeDebugger.businessAttachPrimerShown";
/** How long to wait for the host API after a patch-triggered restart before giving up. */
const HOST_READY_TIMEOUT_MS = 180_000;
/** The "DEE vs Business debugging" user-guide page — the "Open guide" anchor (UX-2/UX-3). */
const BUSINESS_GUIDE_URL =
  "https://github.com/criticalmanufacturing/vscode-dee-debugger/blob/main/docs/user-guide/dee-vs-business-debugging.md";
/** Grace window before judging business breakpoints unbound (UX-3). */
const UNBOUND_BREAKPOINT_GRACE_MS = 8_000;

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const { getClient, explorer, sessions, diagnostics, credentials, output, serverContent } = deps;
  const syncDeps = { getClient, diagnostics, serverContent, output };

  const showError = (prefix: string, error: unknown): void => {
    // Redact before display: runCli failures embed the full argv, which can contain an
    // engine-command password (`sshpass -p …`) — the toast must not leak it.
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    output.appendLine(`[error] ${prefix}: ${message}`);
    if (error instanceof MesApiError && error.details) output.appendLine(error.details);
    let hint = "";
    if (error instanceof MesApiError && error.isAuthError) {
      hint = " The token may be expired — run 'DEE Debugger: Set Credentials…' to set a new one.";
    } else if (error instanceof MesApiError && error.status === undefined && vscode.debug.activeDebugSession) {
      // A debugger stop suspends the whole host process — every HTTP call times out.
      hint =
        " The MES host is probably paused by the attached debugger (stopped at a breakpoint) — continue the debug session (F5) and retry.";
    } else if (error instanceof MesApiError && /timed out|timeout/i.test(message)) {
      // No active session here, but a PREVIOUS debug session that ended uncleanly can leave
      // vsdbg attached with the host's request threads suspended: the host answers '/' but every
      // '/api' call hangs. Killing vsdbg does not resume it — restarting the host container does.
      hint =
        " If the host was recently debugged, a leftover debugger may have it suspended (it answers '/' but '/api' hangs) — restart the MES host container, then retry.";
    }
    // The Linux DEE debug-compile bug (#158143) has a one-command fix — offer it inline.
    const details = error instanceof MesApiError ? error.details : undefined;
    if (isPdbCompileError(message) || isPdbCompileError(details)) {
      void vscode.window
        .showErrorMessage(
          `${prefix}: DEE debug compile failed — this is the known Linux host PDB bug (#158143). ` +
            "Patch the host to fix it?",
          "Patch Host for Debugging…",
          "Show Log",
        )
        .then((choice) => {
          if (choice === "Patch Host for Debugging…") void vscode.commands.executeCommand("deeDebugger.patchHostForDebugging");
          else if (choice === "Show Log") output.show?.();
        });
      return;
    }
    void vscode.window.showErrorMessage(`${prefix}: ${message}${hint}`, "Show Log").then((choice) => {
      if (choice === "Show Log") output.show?.();
    });
    // L9: on auth failures, log token metadata (type + expiry delta) — the first
    // support question for every 401 ticket. Metadata only; never the token.
    if (error instanceof MesApiError && error.isAuthError) {
      void credentials.get().then((creds) => {
        const token = creds.accessToken ?? creds.personalAccessToken;
        const info = token ? decodeJwt(token) : undefined;
        const kind = creds.accessToken ? "access token (Bearer)" : creds.personalAccessToken ? "PAT (Basic)" : "none";
        const expiry = info?.expiresAt
          ? `expires ${info.expiresAt.toISOString()} (${Math.round((info.expiresAt.getTime() - Date.now()) / 60000)} min from now)`
          : "no expiry claim";
        output.appendLine(`[auth] stored credential: ${kind}; ${token ? expiry : "no token stored"}`);
      });
    }
  };

  /** Cap for raw host payloads echoed to the output channel (docs/smoke-test.md Phase 4.4). */
  const MAX_RAW_PAYLOAD_CHARS = 4096;

  /**
   * Publish host compile errors as diagnostics — but only when the payload really
   * contains structured `[Action Code]…[Line n,m]` rows and the error is not an auth
   * failure (M5/SUP-1: an expired token must surface showError's auth hint, not a fake
   * "Compilation failed" with a bogus problem at line 0). The raw payload is also
   * appended to the output channel so contract drift can be captured as a fixture.
   * Returns true when the error was handled as a compile failure.
   */
  const publishCompileFailure = async (
    actionName: string,
    localPath: string,
    error: unknown,
  ): Promise<boolean> => {
    if (!(error instanceof MesApiError) || !error.details || error.isAuthError) return false;
    const serverMessage = extractServerMessage(error.details);
    if (!parseHostErrors(serverMessage).some((e) => e.scope !== "unknown")) return false;
    const raw =
      error.details.length > MAX_RAW_PAYLOAD_CHARS
        ? `${error.details.slice(0, MAX_RAW_PAYLOAD_CHARS)}\n[error] … payload truncated (${error.details.length} chars total)`
        : error.details;
    output.appendLine(`[error] Compilation of '${actionName}' failed — raw host payload:`);
    output.appendLine(raw);
    const document = await vscode.workspace.openTextDocument(localPath);
    const count = diagnostics.publishServerErrors(document, serverMessage);
    void vscode.window.showErrorMessage(
      `Compilation of '${actionName}' failed — ${count} problem(s) reported by the MES host (see Problems panel).`,
    );
    return true;
  };

  /** Resolve the action for a command invoked from the tree, the editor, or the palette. */
  const resolveAction = async (node?: DeeTreeNode): Promise<DeeAction | undefined> => {
    if (isActionNode(node)) return node.action;
    const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activePath) {
      const session = sessions.getByPath(activePath);
      if (session) return session.action;
    }
    const actions = explorer.allActions();
    if (actions.length === 0) {
      void vscode.window.showInformationMessage("Load the DEE Explorer first (DEE Debugger: Refresh).");
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      actions.map((ref) => ({ label: ref.action.Name, description: ref.action.Description, ref })),
      { title: "Select a DEE Action", matchOnDescription: true },
    );
    return pick?.ref.action;
  };

  /**
   * Find or create the local file for an action (ADR 0012). The action's file is looked up in
   * every DEE folder, subfolders included:
   * - generated-format file → used in place (opened, uploaded and debugged where it lives);
   * - DeeDevBase-format file → never touched; a generated working copy under `.dee-debug/`
   *   (the MES wrapper with that file's bodies) is used instead;
   * - no file → `<primary DEE folder>/<ActionName>.cs` is created from the MES.
   * `fresh` (Reload) takes the MES version even when a local file exists. An existing file is
   * never overwritten unless it is ours to rewrite (Reload of the same file, or a working copy).
   */
  const prepareLocalFile = async (action: DeeAction, options: { fresh?: boolean } = {}): Promise<string> => {
    const root = workspaceRoot();
    const folders = await resolveDeesFolders();
    const rel = (p: string): string => path.relative(root, p) || p;
    const serverNames = typeof explorer.rawActions === "function" ? explorer.rawActions().map((a) => a.Name) : [];
    const index = await indexLocalDees(folders, [...new Set([...serverNames, action.Name])], output);
    const { match, conflicts } = findIndexed(index.files, action.Name);
    if (conflicts.length > 1) {
      throw new Error(
        `Several local files belong to '${action.Name}': ${conflicts.map((c) => rel(c.filePath)).join(", ")} — keep one, or limit deeDebugger.deesFolder to one Data package.`,
      );
    }
    const plan = planLocalFile(action.Name, match, folders[0]!, root);
    // Sanitized names can collide ("A/B" and "A_B" both map to A_B.cs) — refuse rather
    // than silently sharing a file between two different actions.
    const collision = sessions.all().find((s) => s.localPath === plan.editPath && s.action.Name !== action.Name);
    if (collision) {
      throw new Error(
        `'${action.Name}' and '${collision.action.Name}' map to the same file (${rel(plan.editPath)}) — rename one of the actions.`,
      );
    }
    // C2 guard: never rewrite a file that has unsaved changes in an open editor.
    const refuseIfDirty = (p: string): void => {
      if (vscode.workspace.textDocuments.find((d) => d.uri.fsPath === p && d.isDirty)) {
        throw new Error(`'${action.Name}' has unsaved changes in an open editor (${rel(p)}) — save or revert them first.`);
      }
    };
    let content: string | undefined;
    if (plan.kind === "inPlace") {
      if (options.fresh) {
        refuseIfDirty(plan.editPath);
        content = await getClient().getActionFullCode(action);
      }
    } else if (plan.kind === "workingCopy") {
      refuseIfDirty(plan.editPath);
      const fullCode = await getClient().getActionFullCode(action);
      if (options.fresh) {
        content = fullCode;
      } else {
        const source = extractBodies(await fs.readFile(plan.sourcePath, "utf8"));
        content = replaceBodies(fullCode, source.actionCode, source.validationCode);
      }
      await ensureWorkingCopyFolder(root);
    } else {
      // Proposal 4: a file of that name that the index could not parse (damaged markers, or
      // not a DEE file) is never overwritten.
      if (await fs.stat(plan.editPath).catch(() => undefined)) {
        throw new Error(
          `${rel(plan.editPath)} exists but has no valid DEE markers — the extension will not overwrite it. Fix its markers or move it, then retry.`,
        );
      }
      refuseIfDirty(plan.editPath);
      content = await getClient().getActionFullCode(action);
    }
    if (content !== undefined) {
      await fs.mkdir(path.dirname(plan.editPath), { recursive: true });
      await fs.writeFile(plan.editPath, content, "utf8");
    }
    if (plan.kind === "workingCopy") {
      output.appendLine(
        `[dees] '${action.Name}': ${rel(plan.sourcePath)} is in DeeDevBase format — working on ${rel(plan.editPath)}; ` +
          "use 'Write Code Back to Source File' to update it.",
      );
    }
    const previous = sessions.get(action.Name);
    sessions.upsert({
      action,
      localPath: plan.editPath,
      sourcePath: plan.kind === "workingCopy" ? plan.sourcePath : undefined,
      debugOn: previous?.debugOn ?? false,
      hostPath: previous?.hostPath,
      pendingUpload: false,
      envName: readSettings().envName, // R2: sessions belong to one environment
    });
    // An existing local file now wins over the MES version — say so when they differ, so a
    // stale copy is never debugged or saved over newer MES code unknowingly.
    if (!options.fresh && plan.kind !== "create" && action.ActionCode !== undefined) {
      const localBodies = extractBodies(await fs.readFile(plan.kind === "workingCopy" ? plan.sourcePath : plan.editPath, "utf8"));
      const server = { actionCode: action.ActionCode ?? "", validationCode: action.ValidationCode ?? "" };
      if (!codeEquals(localBodies, server)) {
        void vscode.window
          .showInformationMessage(
            `Your local file for '${action.Name}' (${rel(plan.kind === "workingCopy" ? plan.sourcePath : plan.editPath)}) differs from the MES version.`,
            "Compare",
            "Reload from MES",
          )
          .then(async (choice) => {
            if (choice === "Compare") {
              const localText = await fs.readFile(plan.editPath, "utf8");
              const uri = serverContent.set(action.Name, replaceBodies(localText, server.actionCode, server.validationCode));
              await vscode.commands.executeCommand("vscode.diff", uri, vscode.Uri.file(plan.editPath), `${action.Name}: MES ↔ local`);
            } else if (choice === "Reload from MES") {
              await vscode.commands.executeCommand("deeDebugger.reloadAction", { action });
            }
          });
      }
    }
    return plan.editPath;
  };

  /** After saving a working copy to the MES, offer to carry the code into the repository file. */
  const offerWriteBack = (actionName: string): void => {
    const source = sessions.get(actionName)?.sourcePath;
    if (!source) return;
    void vscode.window
      .showInformationMessage(
        `'${actionName}' was saved from a working copy. Write the code back to ${path.relative(workspaceRoot(), source)} as well?`,
        "Write Back",
      )
      .then(async (choice) => {
        if (choice !== "Write Back") return;
        try {
          const rel = await writeBackToSource(actionName);
          if (rel) vscode.window.setStatusBarMessage(`$(check) Code written back to ${rel}`, 5000);
        } catch (error) {
          showError(`Failed to write '${actionName}' back`, error);
        }
      });
  };

  /** Local folder that `sourcePathInHost` stands for in the attach map (ADR 0012). */
  const debugLocalRoot = async (target: { useMount?: boolean }): Promise<string> =>
    target.useMount ? resolveDeesFolder() : workspaceRoot();

  /**
   * Copy the bodies of a working copy into its DeeDevBase-format source file, keeping that
   * file's layout and line endings. Returns the relative path written, or undefined.
   */
  const writeBackToSource = async (actionName: string): Promise<string | undefined> => {
    const session = sessions.get(actionName);
    if (!session?.sourcePath) return undefined;
    // Save an open editor of the working copy first, then read what is on disk.
    const working = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === session.localPath);
    if (working?.isDirty) await working.save();
    const bodies = extractBodies(await fs.readFile(session.localPath, "utf8"));
    if (vscode.workspace.textDocuments.find((d) => d.uri.fsPath === session.sourcePath && d.isDirty)) {
      throw new Error(`${session.sourcePath} has unsaved changes in an open editor — save or revert them first.`);
    }
    const sourceText = await fs.readFile(session.sourcePath, "utf8");
    let updated = replaceBodies(sourceText, bodies.actionCode, bodies.validationCode);
    if (sourceText.includes("\r\n")) updated = updated.replace(/\r?\n/g, "\r\n");
    const rel = path.relative(workspaceRoot(), session.sourcePath);
    if (updated !== sourceText) {
      await fs.writeFile(session.sourcePath, updated, "utf8");
      output.appendLine(`[dees] wrote '${actionName}' back to ${rel}.`);
    }
    return rel;
  };

  const register = (command: string, handler: (...args: any[]) => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  register("deeDebugger.refresh", async () => {
    try {
      await vscode.window.withProgress(
        { location: { viewId: "deeDebugger.explorer" }, title: "Loading DEE actions…" },
        () => explorer.refresh(),
      );
    } catch (error) {
      showError("Failed to load DEE actions", error);
    }
  });

  register("deeDebugger.expandAll", () => explorer.expandAll());

  register("deeDebugger.openAction", async (node?: DeeTreeNode) => {
    const action = await resolveAction(node);
    if (!action) return;
    try {
      const existing = sessions.get(action.Name);
      const filePath =
        existing && (await fs.stat(existing.localPath).catch(() => undefined))
          ? existing.localPath
          : await prepareLocalFile(action);
      const document = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      showError(`Failed to open action '${action.Name}'`, error);
    }
  });

  /**
   * Save with MES optimistic-concurrency handling: on 409 (object changed since it was
   * loaded — by another user, or by our own previous save) offer to re-fetch the fresh
   * object and re-apply the local bodies on top of it.
   */
  const saveHandlingConflict = async (
    base: DeeAction,
    bodies: { actionCode: string; validationCode: string },
    doSave: (payload: DeeAction) => Thenable<DeeAction>,
  ): Promise<DeeAction | undefined> => {
    const withBodies = (a: DeeAction): DeeAction => ({
      ...a,
      ActionCode: bodies.actionCode,
      ValidationCode: bodies.validationCode,
    });
    try {
      return await doSave(withBodies(base));
    } catch (error) {
      if (!(error instanceof MesApiError) || !error.isConcurrencyConflict) throw error;
      output.appendLine(`[save] 409 concurrency conflict on '${base.Name}' — asking the user.`);
      const choice = await vscode.window.showWarningMessage(
        `'${base.Name}' was changed on the MES since it was loaded (another user or session). Overwrite it with your local code?`,
        { modal: true },
        "Overwrite",
      );
      output.appendLine(`[save] conflict on '${base.Name}': user chose ${choice === "Overwrite" ? "overwrite" : "cancel"}.`);
      if (choice !== "Overwrite") return undefined;
      const fresh = await getClient().getActionByName(base.Name);
      return doSave(withBodies(fresh));
    }
  };

  register("deeDebugger.uploadAction", async (node?: DeeTreeNode) => {
    const action = await resolveAction(node);
    if (!action) return;
    const session = sessions.get(action.Name);
    if (!session) {
      void vscode.window.showWarningMessage(`Action '${action.Name}' has no local file — open it first.`);
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(session.localPath);
      if (document.isDirty) await document.save();
      const text = document.getText();
      const issues = validateMarkers(text);
      if (issues.length > 0) {
        output.appendLine(`[upload] refused '${action.Name}' — marker validation: ${issues.join(" | ")}`);
        void vscode.window.showErrorMessage(
          `Cannot upload '${action.Name}' — marker problems: ${issues.join(" ")}`,
        );
        return;
      }
      const bodies = extractBodies(text);
      const saved = await saveHandlingConflict(session.action, bodies, (payload) =>
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Compiling and saving '${action.Name}'…` },
          () => getClient().compileAndSave(payload),
        ),
      );
      if (!saved) return;
      diagnostics.clear(document.uri);
      sessions.update(action.Name, { action: saved, pendingUpload: false });
      void vscode.commands.executeCommand("deeDebugger.refresh");
      offerWriteBack(action.Name);
      if (isDraftVersion(saved)) {
        // GitHub #7: saving into a draft. Whether it runs depends on whether another version
        // is effective (the tree row is the effective one when it exists) — say which, and
        // offer the promotion right here.
        const row = explorer.findAction(action.Name)?.action;
        const effectiveVersion = row && !isDraftVersion(row) ? row.Version : undefined;
        const choice = await vscode.window.showInformationMessage(
          `Action '${action.Name}' saved to v${saved.Version ?? "?"} — a draft (${stateName(saved.UniversalState)}, not effective). ${draftExecutionNote(saved.Version, effectiveVersion)}`,
          "Make Effective",
        );
        if (choice === "Make Effective") await makeVersionEffective(action, saved);
        return;
      }
      // Success is the common case: a status-bar confirmation (plus the "pending upload" badge
      // clearing) instead of a toast the user has to dismiss every time.
      vscode.window.setStatusBarMessage(`$(cloud-upload) '${action.Name}' saved to MES (v${saved.Version ?? "?"})`, 5000);
    } catch (error) {
      if (await publishCompileFailure(action.Name, session.localPath, error)) return;
      showError(`Failed to save action '${action.Name}'`, error);
    }
  });

  /**
   * Promote a version to Effective (MakeActionVersionEffective). The host validates the
   * concurrency token and only accepts Active versions, so re-fetch unless the caller
   * passes an entity the host just returned. Returns the effective entity, or undefined.
   */
  const makeVersionEffective = async (action: DeeAction, fresh?: DeeAction): Promise<DeeAction | undefined> => {
    try {
      const target =
        fresh ?? (action.Id ? await getClient().getActionById(action.Id) : await getClient().getActionByName(action.Name));
      if (!isDraftVersion(target)) {
        void vscode.window.showInformationMessage(`'${action.Name}' v${target.Version ?? "?"} is already effective.`);
        return target;
      }
      if (!canMakeEffective(target)) {
        void vscode.window.showWarningMessage(
          `'${action.Name}' v${target.Version ?? "?"} is ${stateName(target.UniversalState)} — only Active versions can be made effective.`,
        );
        return undefined;
      }
      const effective = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Making '${action.Name}' v${target.Version ?? "?"} effective…` },
        () => getClient().makeActionVersionEffective(target),
      );
      if (sessions.get(action.Name)) sessions.update(action.Name, { action: effective });
      output.appendLine(`[version] '${action.Name}' v${effective.Version ?? target.Version ?? "?"} made effective.`);
      void vscode.window.showInformationMessage(
        `'${action.Name}' v${effective.Version ?? target.Version ?? "?"} is now effective — the MES executes it from now on.`,
      );
      void vscode.commands.executeCommand("deeDebugger.refresh");
      return effective;
    } catch (error) {
      showError(`Failed to make '${action.Name}' effective`, error);
      return undefined;
    }
  };

  register("deeDebugger.makeVersionEffective", async (node?: DeeTreeNode) => {
    const action = await resolveAction(node);
    if (!action) return;
    await makeVersionEffective(action);
  });

  register("deeDebugger.toggleShowDisabledActions", async () => {
    const next = !readSettings().showDisabledActions;
    await updateSettingInOwningScope("showDisabledActions", next);
    // The configuration listener rebuilds the tree; the status line confirms the flip.
    vscode.window.setStatusBarMessage(next ? "DEE Explorer: showing disabled actions" : "DEE Explorer: hiding disabled actions", 3000);
  });

  /**
   * GitHub #8: create a brand-new action from VS Code — the same CreateAction call as the
   * MES UI wizard, then (by default) make v1 effective, then open it locally. The host
   * stores a created action as version 1 / Active. It runs anyway (no version is
   * effective, so the highest runs), but stays exposed to a later staged version taking
   * over until one is effective — hence the explicit choice up front.
   */
  register("deeDebugger.createAction", async () => {
    if (!explorer.isLoaded) {
      await vscode.commands.executeCommand("deeDebugger.refresh");
      if (!explorer.isLoaded) return;
    }
    const existingNames = explorer.rawActions().map((a) => a.Name);
    const name = await vscode.window.showInputBox({
      title: "New DEE Action — name (1/3)",
      prompt: "C# identifier (letters, digits, underscores; starts with a letter), unique on this MES.",
      validateInput: (value) => validateActionName(value, existingNames),
      ignoreFocusOut: true,
    });
    if (!name) return;
    const description = await vscode.window.showInputBox({
      title: `New DEE Action '${name.trim()}' — description (2/3)`,
      prompt: "Optional, up to 500 characters.",
      ignoreFocusOut: true,
    });
    if (description === undefined) return;

    const classifications = knownClassifications(explorer.rawActions());
    const classificationPick = await vscode.window.showQuickPick(
      [
        { label: "$(circle-slash) No classification", value: "" },
        ...classifications.map((c) => ({ label: `$(tag) ${c}`, value: c })),
        { label: "$(edit) Other…", value: undefined as string | undefined },
      ],
      { title: `New DEE Action '${name.trim()}' — classification (3/3)`, ignoreFocusOut: true },
    );
    if (!classificationPick) return;
    let classification = classificationPick.value;
    if (classification === undefined) {
      classification = await vscode.window.showInputBox({
        title: `New DEE Action '${name.trim()}' — classification`,
        prompt: "Free text used to group actions in the MES UI (e.g. the tenant or module name).",
        ignoreFocusOut: true,
      });
      if (classification === undefined) return;
    }
    const effectiveness = await vscode.window.showQuickPick(
      [
        {
          label: "$(pass-filled) Create and make effective",
          description: "recommended — v1 is the version that runs; later staged versions wait until promoted",
          makeEffective: true,
        },
        {
          label: "$(circle-outline) Create as draft",
          description: "v1 (Active) still runs while no version is effective, but a later staged version would take over",
          makeEffective: false,
        },
      ],
      { title: `Create DEE Action '${name.trim()}'`, ignoreFocusOut: true },
    );
    if (!effectiveness) return;

    const payload = newActionPayload({ name, description, classification });
    try {
      let created = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Creating DEE action '${payload.Name}'…` },
        () => getClient().createAction(payload),
      );
      output.appendLine(`[create] '${created.Name}' created as v${created.Version ?? 1} (${stateName(created.UniversalState)}).`);
      if (effectiveness.makeEffective) created = (await makeVersionEffective(created, created)) ?? created;
      await vscode.commands.executeCommand("deeDebugger.refresh");
      try {
        const filePath = await prepareLocalFile(created);
        const document = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(document, { preview: false });
      } catch (error) {
        // No workspace folder / dirty collision — the action exists on the MES regardless.
        output.appendLine(`[create] '${created.Name}' not opened locally: ${error instanceof Error ? error.message : error}`);
      }
      void vscode.window.showInformationMessage(
        isDraftVersion(created)
          ? `DEE action '${created.Name}' created as a draft (v${created.Version ?? 1}, not effective). It runs already — no version is effective — so make it effective before staging new versions. Add it to an action group in the MES UI so the MES invokes it.`
          : `DEE action '${created.Name}' created and effective. Add it to an action group in the MES UI (Administration → DEE Actions) so the MES invokes it.`,
      );
    } catch (error) {
      showError(`Failed to create DEE action '${payload.Name}'`, error);
    }
  });

  register("deeDebugger.uploadActionNewVersion", async (node?: DeeTreeNode) => {
    const action = await resolveAction(node);
    if (!action) return;
    const session = sessions.get(action.Name);
    if (!session) {
      void vscode.window.showWarningMessage(`Action '${action.Name}' has no local file — open it first.`);
      return;
    }
    const choice = await vscode.window.showQuickPick(
      [
        { label: "Save as new version and make it effective", makeEffective: true },
        { label: "Save as new version (keep current version effective)", makeEffective: false },
      ],
      { title: `Save '${action.Name}' as new version (current: v${action.Version ?? "?"})` },
    );
    if (!choice) return;
    try {
      const document = await vscode.workspace.openTextDocument(session.localPath);
      if (document.isDirty) await document.save();
      const text = document.getText();
      const issues = validateMarkers(text);
      if (issues.length > 0) {
        output.appendLine(`[upload] refused '${action.Name}' — marker validation: ${issues.join(" | ")}`);
        void vscode.window.showErrorMessage(`Cannot upload '${action.Name}' — marker problems: ${issues.join(" ")}`);
        return;
      }
      const bodies = extractBodies(text);
      const saved = await saveHandlingConflict(session.action, bodies, (payload) =>
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Saving '${action.Name}' as new version…` },
          () => getClient().compileAndSaveWithNewVersion(payload, choice.makeEffective),
        ),
      );
      if (!saved) return;
      diagnostics.clear(document.uri);
      sessions.update(action.Name, { action: saved, pendingUpload: false });
      offerWriteBack(action.Name);
      void vscode.window.showInformationMessage(
        `Action '${action.Name}' saved as v${saved.Version ?? "?"}${choice.makeEffective ? " (effective)" : ""}.`,
      );
      void vscode.commands.executeCommand("deeDebugger.refresh");
    } catch (error) {
      if (await publishCompileFailure(action.Name, session.localPath, error)) return;
      showError(`Failed to save new version of '${action.Name}'`, error);
    }
  });

  const searchActions = async (): Promise<void> => {
    if (!explorer.isLoaded) {
      await vscode.commands.executeCommand("deeDebugger.refresh");
      if (!explorer.isLoaded) return;
    }
    const value = await vscode.window.showInputBox({
      title: "Filter DEE actions",
      prompt: "Case-insensitive substring on action names; empty clears the filter.",
      value: explorer.currentFilter ?? "",
    });
    if (value === undefined) return;
    explorer.setFilter(value);
  };
  register("deeDebugger.searchActions", searchActions);
  register("deeDebugger.searchActionsFiltered", searchActions);

  register("deeDebugger.syncCompare", async () => {
    try {
      await syncCompare(syncDeps);
    } catch (error) {
      showError("DEE sync comparison failed", error);
    }
  });

  register("deeDebugger.syncUpload", async () => {
    try {
      await syncUpload(syncDeps);
      void vscode.commands.executeCommand("deeDebugger.refresh");
    } catch (error) {
      showError("DEE sync upload failed", error);
    }
  });

  register("deeDebugger.syncDownload", async () => {
    try {
      await syncDownload(syncDeps);
    } catch (error) {
      showError("DEE sync download failed", error);
    }
  });

  register("deeDebugger.reloadAction", async (node?: DeeTreeNode) => {
    const action = await resolveAction(node);
    if (!action) return;
    const confirmed = await vscode.window.showWarningMessage(
      `Reload '${action.Name}' from the MES? Any pending changes to the local source code will be lost.`,
      { modal: true },
      "Reload",
    );
    if (confirmed !== "Reload") return;
    try {
      const fresh = action.Id ? await getClient().getActionById(action.Id) : await getClient().getActionByName(action.Name);
      const filePath = await prepareLocalFile(fresh, { fresh: true });
      diagnostics.clear(vscode.Uri.file(filePath));
      const document = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      showError(`Failed to reload action '${action.Name}'`, error);
    }
  });

  /**
   * UX: enabling debug mode is only half the job — the other half is attaching. Fold that
   * decision into the enable flow (one modal question with the semantics as detail text)
   * instead of a toast that is easy to miss; `deeDebugger.attachAfterEnablingDebug` lets heavy
   * users skip the question in either direction. Nothing is asked when our debugger is
   * already attached.
   */
  const offerAttachAfterEnable = async (actionName: string): Promise<void> => {
    const semantics = `Debug mode is per-user and in-memory (lost on host restart). The host now compiles '${actionName}' from your local file on every execution — edits hot-reload; Save Action to MES persists them for everyone.`;
    const session = vscode.debug.activeDebugSession;
    if (session && session.type === "coreclr" && session.name.startsWith("Attach to MES Host")) {
      vscode.window.setStatusBarMessage(`$(bug) Debug mode enabled for '${actionName}' — debugger already attached`, 5000);
      return;
    }
    const mode = vscode.workspace.getConfiguration("deeDebugger").get<string>("attachAfterEnablingDebug", "ask");
    if (mode === "never") {
      vscode.window.setStatusBarMessage(`$(bug) Debug mode enabled for '${actionName}' — attach the debugger to bind breakpoints`, 6000);
      return;
    }
    if (mode === "always") {
      output.appendLine(`[debug] attachAfterEnablingDebug=always — attaching.`);
      await vscode.commands.executeCommand("deeDebugger.attach");
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `Debug mode enabled for '${actionName}'. Attach the debugger now?`,
      { modal: true, detail: `${semantics}\n\nTip: set deeDebugger.attachAfterEnablingDebug to "always" or "never" to skip this question.` },
      "Attach Debugger",
      "Not Now",
    );
    if (choice === "Attach Debugger") await vscode.commands.executeCommand("deeDebugger.attach");
  };

  register("deeDebugger.openGettingStarted", async () => {
    const id = `${context.extension?.id ?? "CriticalManufacturing.dee-debugger"}#deeDebugger.gettingStarted`;
    await vscode.commands.executeCommand("workbench.action.openWalkthrough", id, false);
  });

  const toggleDebugMode = async (node?: DeeTreeNode): Promise<void> => {
    const action = await resolveAction(node);
    if (!action) return;
    const settings = readSettings();
    const session = sessions.get(action.Name);
    try {
      if (session?.debugOn) {
        await getClient().deactivateDebugMode(action);
        sessions.update(action.Name, { debugOn: false, hostPath: undefined });
        output.appendLine(`[debug] debug mode disabled for '${action.Name}'.`);
        // Low-stakes confirmation: the DEBUG badge disappearing is the primary signal.
        vscode.window.setStatusBarMessage(`$(debug-disconnect) Debug mode disabled for '${action.Name}'`, 4000);
        return;
      }
      const localPath = session?.localPath ?? (await prepareLocalFile(action));
      const prepared = sessions.get(action.Name);
      // Proactive #158143 check: on an unpatched Linux host every debug-mode execution fails
      // out of our sight (triggered from the MES UI), so breakpoints never bind and nothing
      // ever prompted. Ask BEFORE registering — patching restarts the host, which would drop
      // the registration anyway.
      if (!(await ensureHostPatchedForDebug())) {
        output.appendLine(`[debug] debug mode for '${action.Name}' not enabled — host unpatched and user declined.`);
        return;
      }
      const bridge = createFileBridge(settings.hostTarget, await debugLocalRoot(settings.hostTarget));
      const publishedContent = await fs.readFile(localPath);
      const hostPath = await bridge.publish(localPath);
      await getClient().activateDebugMode(action, hostPath);
      sessions.upsert({
        action,
        localPath,
        sourcePath: prepared?.sourcePath,
        hostPath,
        debugOn: true,
        pendingUpload: session?.pendingUpload ?? false,
        envName: readSettings().envName, // R2
        // C1: remember what the host now holds so the watcher can tell our own
        // pushes apart from genuine host rewrites.
        lastPushedHash: md5Hex(publishedContent),
        lastPushAt: Date.now(),
      });
      output.appendLine(`[debug] '${action.Name}' registered with host path ${hostPath} (${bridge.description}).`);
      const document = await vscode.workspace.openTextDocument(localPath);
      await vscode.window.showTextDocument(document, { preview: false });
      await offerAttachAfterEnable(action.Name);
    } catch (error) {
      showError(`Failed to toggle debug mode for '${action.Name}'`, error);
    }
  };
  register("deeDebugger.toggleDebugMode", toggleDebugMode);
  // UX: the tree shows a state-specific verb + icon (Enable / Disable) instead of an ambiguous
  // "Toggle" whose icon never changed; both are the same operation.
  register("deeDebugger.enableDebugMode", toggleDebugMode);
  register("deeDebugger.disableDebugMode", toggleDebugMode);

  register("deeDebugger.openInMesUi", async (node?: DeeTreeNode) => {
    const action = await resolveAction(node);
    if (!action) return;
    const url = mesUiEntityUrl(readSettings().hostAddress, "Action", action.Id);
    if (!url) {
      void vscode.window.showInformationMessage(`'${action.Name}' has no Id yet — refresh the DEE Explorer and try again.`);
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  });

  register("deeDebugger.showOutput", () => output.show?.());

  register("deeDebugger.writeBackToSource", async (node?: DeeTreeNode) => {
    const action = await resolveAction(node);
    if (!action) return;
    if (!sessions.get(action.Name)?.sourcePath) {
      void vscode.window.showInformationMessage(
        `'${action.Name}' is edited in place — there is no separate source file to write back to. (Write back applies to working copies of DeeDevBase-format files.)`,
      );
      return;
    }
    try {
      const rel = await writeBackToSource(action.Name);
      if (rel) vscode.window.setStatusBarMessage(`$(check) Code of '${action.Name}' written back to ${rel}`, 5000);
    } catch (error) {
      showError(`Failed to write '${action.Name}' back`, error);
    }
  });

  // R7: attaching a debugger is privileged — parse the hostname (a substring test is
  // bypassable — "notlocalhost.example", paths, userinfo tricks) and confirm before
  // attaching to anything that isn't genuinely local. Shared by both attach commands.
  const confirmNonLocalAttach = async (hostAddress: string): Promise<boolean> => {
    const isLocalHost = (address: string): boolean => {
      try {
        const hostname = new URL(address).hostname.toLowerCase();
        return (
          hostname === "localhost" ||
          hostname === "::1" ||
          hostname === "[::1]" ||
          /^127\.\d+\.\d+\.\d+$/.test(hostname) ||
          /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname) || // docker bridge nets
          hostname.endsWith(".local")
        );
      } catch {
        return false;
      }
    };
    if (isLocalHost(hostAddress)) return true;
    const proceed = await vscode.window.showWarningMessage(
      `You are about to attach a debugger to a non-local MES host (${hostAddress}). ` +
        "Debugging is a privileged operation — never do this on a production environment.",
      { modal: true },
      "Continue",
    );
    return proceed === "Continue";
  };

  /** Open the "DEE vs Business debugging" guide (the "Open guide" target). */
  const openAttachGuide = (): void => {
    void vscode.env.openExternal(vscode.Uri.parse(BUSINESS_GUIDE_URL));
  };

  /**
   * One-shot prerequisites primer shown before the FIRST attach — the prereqs that decide
   * whether a breakpoint binds, for BOTH debugging modes the one attach serves. Gated on a
   * globalState flag so it never nags twice. Returns true when the user chose to continue.
   */
  const showAttachPrimer = async (): Promise<boolean> => {
    if (context.globalState.get<boolean>(BUSINESS_PRIMER_KEY)) return true;
    const choice = await vscode.window.showInformationMessage(
      "Attaching debugs the DEPLOYED MES host process. One attach covers both kinds of custom code; a " +
        "breakpoint binds when the matching code runs:\n\n" +
        "• DEE actions — enable Debug Mode for the action first; the host then runs your local file (hot reload).\n" +
        "• Custom business (Cmf.Custom.* DLLs) — the DLLs must be deployed with PORTABLE PDBs from your build " +
        "(cmf dev local stack up). The debugger opens the source paths recorded at build time — a local cmf build " +
        "needs no map; set deeDebugger.hostSourceMap only if the DLL was built elsewhere. " +
        "No hot-reload for business code — rebuild, redeploy, re-attach.\n\n" +
        "On MES 11.x Linux hosts, DEE debugging also needs the host patch (#158143); the extension checks and offers it.",
      { modal: true },
      "Attach",
      "Open guide",
    );
    // Any acknowledgement (Attach / Open guide) counts as "seen" — one-time by design.
    if (choice === "Attach" || choice === "Open guide") {
      await context.globalState.update(BUSINESS_PRIMER_KEY, true);
    }
    if (choice === "Open guide") {
      openAttachGuide();
      return false; // let the user read first; the primer won't re-show on the next run
    }
    return choice === "Attach";
  };

  /**
   * UX-3: after a successful attach, watch for breakpoints that never bind. A bound breakpoint
   * reports a resolved location via an onDidChangeBreakpoints "changed" event; if the user's
   * source breakpoints show no bind signal within a grace window, surface the likely causes.
   * (Business breakpoints are the common unbound case — DEE ones bind on first execute.)
   * Everything is disposed on session end or after firing.
   */
  const watchUnboundBreakpoints = (): void => {
    if (!vscode.debug.onDidChangeBreakpoints) return; // older API surface — best-effort only
    const boundIds = new Set<string>();
    const disposables: vscode.Disposable[] = [];
    const cleanup = (): void => {
      for (const d of disposables) d.dispose();
      disposables.length = 0;
    };
    disposables.push(
      vscode.debug.onDidChangeBreakpoints((e) => {
        for (const bp of e.changed) if (bp.id) boundIds.add(bp.id);
      }),
    );
    const timer = setTimeout(() => {
      cleanup();
      const sourceIds = (vscode.debug.breakpoints ?? [])
        .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint && bp.enabled)
        .map((bp) => bp.id);
      if (!shouldWarnUnboundBreakpoints(sourceIds, boundIds)) return;
      // A known-unpatched host beats every heuristic cause — say so and offer the fix.
      const unpatched = cachedHostPatchState() === "unpatched";
      output.appendLine(
        `[debug] ${sourceIds.length} breakpoint(s) did not bind within ${UNBOUND_BREAKPOINT_GRACE_MS} ms — ${
          unpatched ? "the host is NOT patched for DEE debugging (#158143); other " : ""
        }likely causes: ${UNBOUND_BREAKPOINT_CAUSES.join(" ")}`,
      );
      void vscode.window
        .showWarningMessage(
          unpatched
            ? "Your breakpoint(s) have not bound. If they are in DEE actions: the MES host is not patched for DEE debugging (#158143), so DEE actions cannot compile with debug symbols. (Business-DLL breakpoints are not affected by the patch — see Show Log for their causes.)"
            : `Your breakpoint(s) have not bound. Most likely: ${UNBOUND_BREAKPOINT_CAUSES[0]}`,
          ...(unpatched ? ["Patch Host for Debugging"] : []),
          "Show Log",
          "Open guide",
        )
        .then((choice) => {
          if (choice === "Patch Host for Debugging") void patchHostForDebugging({ consented: true });
          else if (choice === "Show Log") output.show?.();
          else if (choice === "Open guide") openAttachGuide();
        });
    }, UNBOUND_BREAKPOINT_GRACE_MS);
    // Don't keep the process alive for the grace window (tests, headless).
    (timer as { unref?: () => void }).unref?.();
    const termSub = vscode.debug.onDidTerminateDebugSession?.(() => {
      clearTimeout(timer);
      cleanup();
    });
    if (termSub) disposables.push(termSub);
  };

  /**
   * Best-effort runtime-mismatch check: the aligned .NET major tracks the MES line (v11 → 8,
   * v12 → 10). Detect the host's runtime major and compare with the expected major — either
   * `deeDebugger.expectedDotnetMajor` (when set > 0) or inferred from a local `Cmf.Custom.*`
   * project's target framework. Warns (non-blocking) on a genuine mismatch only; never throws.
   */
  const warnOnDotnetMismatch = async (): Promise<void> => {
    try {
      const target = readSettings().hostTarget;
      const { stdout } = await runCli(listHostRuntimesArgs(target), undefined, 10_000);
      const hostMajor = parseHostRuntimeMajor(stdout);
      if (hostMajor === undefined) return;

      const configured = vscode.workspace.getConfiguration("deeDebugger").get<number>("expectedDotnetMajor", 0);
      let expected = configured && configured > 0 ? configured : undefined;
      if (expected === undefined) {
        const csprojs = await vscode.workspace.findFiles("**/Cmf.Custom.*.csproj", "**/{node_modules,bin,obj}/**", 20);
        for (const uri of csprojs) {
          const major = parseProjectTfmMajor(await fs.readFile(uri.fsPath, "utf8"));
          if (major !== undefined) {
            expected = major;
            break;
          }
        }
      }
      output.appendLine(`[debug] host .NET major=${hostMajor}; expected=${expected ?? "unknown"}`);
      const result = describeDotnetMismatch(hostMajor, expected);
      if (result.mismatch && result.message) {
        void vscode.window.showWarningMessage(result.message, "Show Log").then((c) => {
          if (c === "Show Log") output.show?.();
        });
      }
    } catch (error) {
      output.appendLine(`[debug] .NET runtime check skipped: ${error instanceof Error ? error.message : error}`);
    }
  };

  // ADR 0009 (supersedes ADR 0008 §Resolution R2): ONE unified "Attach to MES Host" — DEE and
  // custom-business debugging are the same operation (stock coreclr attach to the same host
  // process), differing only in sourceFileMap entries, and coreclr sourceFileMap takes many
  // entries. So we attach once with a MERGED map: the DEE temp folder (for actions in debug
  // mode) + the business /src map (for deployed Cmf.Custom.* DLLs). Breakpoints in either
  // domain resolve in the same session. Toggle DEE Debug Mode stays a separate action (it does
  // the ActivateDebugMode registration + file-stream + hot-reload); this command only attaches.
  register("deeDebugger.attach", async () => {
    try {
      // UX-5: the coreclr debug type + vsdbg live in the C# extension. It is declared as an
      // extensionDependency, but detect an actually-absent install and offer to add it.
      if (!vscode.extensions.getExtension(CSHARP_EXTENSION_ID)) {
        const choice = await vscode.window.showErrorMessage(
          "The C# extension (ms-dotnettools.csharp) is required to attach the coreclr debugger, but it is not installed.",
          "Install C# extension",
        );
        if (choice === "Install C# extension") {
          await vscode.commands.executeCommand("workbench.extensions.installExtension", CSHARP_EXTENSION_ID);
        }
        return;
      }
      const settings = readSettings();
      // UX-4: actionable button instead of a dead-end info message.
      if (!settings.envName) {
        const choice = await vscode.window.showInformationMessage(
          "No MES environment is selected. Choose one, then attach to its host to debug DEE actions or custom business code.",
          "Switch Environment…",
        );
        if (choice === "Switch Environment…") await vscode.commands.executeCommand("deeDebugger.switchEnvironment");
        return;
      }
      if (!(await confirmNonLocalAttach(settings.hostAddress))) return;

      // Merged source map: DEE temp folder (best-effort — skipped when no workspace) + the
      // business map. Extra/unused entries are harmless no-ops, so we always include both.
      const sourceFileMap: Record<string, string> = {};
      try {
        sourceFileMap[settings.hostTarget.sourcePathInHost] = await debugLocalRoot(settings.hostTarget);
      } catch {
        /* no workspace / DEEs folder — business-only attach, business map still applies */
      }
      const configured = vscode.workspace
        .getConfiguration("deeDebugger")
        .get<Record<string, string>>("hostSourceMap", {});
      const { sourceFileMap: businessMap, isDefault } = resolveBusinessSourceMap(configured);
      Object.assign(sourceFileMap, businessMap);

      // UX-2: one-time prerequisites primer (covers both debugging modes).
      if (!(await showAttachPrimer())) return;
      // #158143: an unpatched host is the top reason "attach works but nothing hits". Warn
      // without blocking (business-DLL breakpoints don't need the patch) and offer the fix.
      if ((await probeHostPatchState()) === "unpatched") {
        void vscode.window
          .showWarningMessage(describeUnpatchedHost(settings.envName, "attach"), "Patch Host for Debugging", "Show Log")
          .then((choice) => {
            if (choice === "Patch Host for Debugging") void patchHostForDebugging({ consented: true });
            else if (choice === "Show Log") output.show?.();
          });
      }
      output.appendLine(`[debug] attach sourceFileMap=${JSON.stringify(sourceFileMap)} (businessDefault=${isDefault})`);
      // UX-5: a single wrapping progress notification so the probe/resolve steps show progress
      // too (attachDebugger still shows its own progress for the long vsdbg install).
      const started = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Attaching to the MES host…" },
        () => attachDebugger(settings.hostTarget, sourceFileMap, (m) => output.appendLine(m), "Attach to MES Host"),
      );
      if (started) {
        output.appendLine(`[debug] coreclr attach started (${settings.hostTarget.kind}).`);
        watchUnboundBreakpoints(); // UX-3
        void warnOnDotnetMismatch(); // best-effort v11/v12 runtime-major check
        const choice = await vscode.window.showInformationMessage(
          "Attached to the MES host. Set breakpoints and trigger the code — DEE-action breakpoints bind when the " +
            "action runs with Debug Mode on; custom-business breakpoints bind against the deployed Cmf.Custom.* DLLs " +
            "(no hot-reload). No MES sign-in is needed for the attach itself.",
          "Open guide",
        );
        if (choice === "Open guide") openAttachGuide();
      }
    } catch (error) {
      showError("Failed to attach to MES host", error);
    }
  });

  register("deeDebugger.installVsdbg", async () => {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Installing vsdbg in the MES host container…" },
        () => installVsdbg(readSettings().hostTarget, (m) => output.appendLine(m)),
      );
      void vscode.window.showInformationMessage("vsdbg installed.");
    } catch (error) {
      showError("Failed to install vsdbg", error);
    }
  });

  const hostAppDir = (): string =>
    (vscode.workspace.getConfiguration("deeDebugger").get<string>("hostAppDir", "") || DEFAULT_HOST_APP_DIR).trim();

  /**
   * #158143 host-patch state, probed proactively (test-user report: attach "sometimes fails"
   * with no prompt — the host was unpatched and the compile failure happened out of our sight).
   * Cached per environment with a TTL so a stack recreate is noticed; invalidated by patch/restore.
   */
  const hostPatchStates = new Map<string, { state: HostPatchState; at: number }>();
  const hostPatchCheckEnabled = (): boolean =>
    vscode.workspace.getConfiguration("deeDebugger").get<string>("hostPatchCheck", "prompt") !== "off";
  const cachedHostPatchState = (): HostPatchState => {
    const key = readSettings().envName ?? "";
    const cached = hostPatchStates.get(key);
    return cached && patchStateIsFresh(cached.at, Date.now()) ? cached.state : "unknown";
  };
  const rememberHostPatchState = (state: HostPatchState): void => {
    hostPatchStates.set(readSettings().envName ?? "", { state, at: Date.now() });
  };
  const probeHostPatchState = async (): Promise<HostPatchState> => {
    const settings = readSettings();
    if (!settings.envName || !hostPatchApplies(settings.hostTarget) || !hostPatchCheckEnabled()) return "unknown";
    const cached = cachedHostPatchState();
    if (cached !== "unknown") return cached;
    const state = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Checking the MES host for DEE debug support…" },
      () => checkHostPatchState(settings.hostTarget, context.extensionPath, hostAppDir(), (m) => output.appendLine(m)),
    );
    rememberHostPatchState(state);
    return state;
  };
  /** Gate for enabling debug mode: true to proceed (patched, unknown, declined-but-continue). */
  const ensureHostPatchedForDebug = async (): Promise<boolean> => {
    if ((await probeHostPatchState()) !== "unpatched") return true;
    const choice = await vscode.window.showWarningMessage(
      describeUnpatchedHost(readSettings().envName, "debug"),
      { modal: true },
      "Patch Host for Debugging",
      "Continue Anyway",
    );
    if (choice === "Patch Host for Debugging") return patchHostForDebugging({ consented: true, continueAfter: true });
    return choice === "Continue Anyway";
  };

  /**
   * After a patch-triggered restart the container is up long before the .NET host answers —
   * registering debug mode right away would fail (or land on a host that is still starting).
   * Poll the API until it answers, with progress; false when it doesn't within the timeout.
   */
  const waitForHostReady = async (): Promise<boolean> =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Waiting for the MES host to come back up…" },
      async () => {
        const deadline = Date.now() + HOST_READY_TIMEOUT_MS;
        for (;;) {
          try {
            await getClient().testConnection();
            output.appendLine("[patch] host API is answering again.");
            return true;
          } catch (error) {
            if (Date.now() >= deadline) {
              output.appendLine(`[patch] host not ready after ${HOST_READY_TIMEOUT_MS / 1000} s: ${error instanceof Error ? error.message : error}`);
              return false;
            }
            await new Promise((resolve) => setTimeout(resolve, 3_000));
          }
        }
      },
    );

  // ADR 0010: apply the #158143 PortablePdb workaround to the MES host so DEE debug mode works
  // on Linux-containerized hosts. Modifies a product DLL in the host container (dev/test only),
  // in place, with a backup — then restarts the host. Runs the bundled Mono.Cecil patcher under
  // the host's own .NET runtime. Returns true when the host is patched AND running the patch
  // (already patched, or patched + restarted); `consented` skips the consent dialog when the
  // caller already asked (the proactive prompts above).
  const patchHostForDebugging = async (options: { consented?: boolean; continueAfter?: boolean } = {}): Promise<boolean> => {
    const settings = readSettings();
    if (!settings.envName) {
      const choice = await vscode.window.showInformationMessage(
        "Select a MES environment first, then patch its host for DEE debugging.",
        "Switch Environment…",
      );
      if (choice === "Switch Environment…") await vscode.commands.executeCommand("deeDebugger.switchEnvironment");
      return false;
    }
    if (settings.hostTarget.kind === "process") {
      void vscode.window.showWarningMessage(
        "Host patching applies to containerized MES hosts. For a local host process, apply the #158143 fix to its Cmf.Foundation.Common.dll manually (see tools/host-pdb-patcher).",
      );
      return false;
    }
    if (!(await confirmNonLocalAttach(settings.hostAddress))) return false;
    if (!options.consented) {
      const consent = await vscode.window.showWarningMessage(
        "Patch the MES host for DEE debugging?\n\n" +
          "This modifies a product assembly (Cmf.Foundation.Common.dll) inside the host container to emit " +
          "PortablePdb — the #158143 workaround that makes DEE debug mode work on Linux hosts. The original is " +
          "backed up (.orig) and the host is restarted afterwards.\n\n" +
          "Development / test hosts only — never a production MES. The patch is reverted if the stack is recreated.",
        { modal: true },
        "Patch host",
      );
      if (consent !== "Patch host") return false;
    }
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Patching MES host for DEE debugging…", cancellable: false },
        async () => {
          const pre = await checkHostPatchPrereqs(settings.hostTarget, hostAppDir(), (m) => output.appendLine(m));
          if (!pre.ok) throw new Error(pre.reason);
          return applyHostPatch(settings.hostTarget, context.extensionPath, hostAppDir(), pre.hostMajor, (m) => output.appendLine(m));
        },
      );
      output.appendLine(`[patch] outcome=${result.outcome} — ${result.detail}`);
      if (result.outcome === "already-patched") {
        rememberHostPatchState("patched");
        void vscode.window.showInformationMessage("The MES host is already patched for DEE debugging — no change needed.");
        return true;
      }
      if (result.outcome === "failed") {
        void vscode.window.showErrorMessage(`Host patch did not apply: ${result.detail}`, "Show Log").then((c) => {
          if (c === "Show Log") output.show?.();
        });
        return false;
      }
      // Patched — restart the host so it loads the patched DLL.
      rememberHostPatchState("patched");
      const restarted = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Restarting the MES host…" },
        () => restartHost(settings.hostTarget, (m) => output.appendLine(m)),
      );
      if (restarted) {
        if (options.continueAfter) {
          // Called from the enable-debug prompt: wait for the host, then let the caller register.
          if (await waitForHostReady()) return true;
          void vscode.window.showWarningMessage(
            "MES host patched and restarted, but it is not answering yet. Enable DEE Debug Mode again once the host is up.",
          );
          return false;
        }
        void vscode.window.showInformationMessage(
          "MES host patched and restarted. DEE debug mode now works — enable Debug Mode on your action again (the restart cleared in-memory registrations).",
        );
        return true;
      }
      const hint =
        settings.hostTarget.kind === "kubernetes"
          ? `Restart the host pod to load the patch, e.g.: kubectl rollout restart ${settings.hostTarget.k8sTarget || "deployment/host"}`
          : "Restart the host to load the patch.";
      void vscode.window.showInformationMessage(`MES host patched. ${hint} Then enable DEE Debug Mode again.`);
      return false;
    } catch (error) {
      showError("Failed to patch the MES host", error);
      return false;
    }
  };

  register("deeDebugger.patchHostForDebugging", () => patchHostForDebugging().then(() => undefined));

  register("deeDebugger.restoreHostDll", async () => {
    const settings = readSettings();
    if (!settings.envName || settings.hostTarget.kind === "process") {
      void vscode.window.showInformationMessage("Select a containerized MES environment first.");
      return;
    }
    if (!(await confirmNonLocalAttach(settings.hostAddress))) return;
    try {
      const result = await restoreHostDll(settings.hostTarget, hostAppDir());
      output.appendLine(`[patch] restore: ${result.detail}`);
      if (result.restored) {
        rememberHostPatchState("unpatched");
        const restarted = await restartHost(settings.hostTarget, (m) => output.appendLine(m));
        void vscode.window.showInformationMessage(
          restarted
            ? "Original host DLL restored and host restarted."
            : `Original host DLL restored. Restart the host pod to load it, e.g.: kubectl rollout restart ${settings.hostTarget.k8sTarget || "deployment/host"}`,
        );
      } else {
        void vscode.window.showWarningMessage(result.detail);
      }
    } catch (error) {
      showError("Failed to restore the host DLL", error);
    }
  });

  /**
   * Let the user choose how to authenticate the active environment — the method is a
   * user choice, never assumed (a PAT, or a browser-copied access token). Used by the
   * welcome view, the palette, and first activation of an environment with no credentials.
   */
  const chooseAndSetCredentials = async (): Promise<void> => {
    const settings = readSettings();
    if (!settings.envName) {
      void vscode.window.showInformationMessage(
        "Select a MES environment first (DEE Debugger: Switch Environment…), then set credentials.",
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "$(key) Set Personal Access Token…",
          detail: "Long-lived token from the Security Portal user page — best for daily work.",
          id: "pat",
        },
        {
          label: "$(clippy) Set Access Token…",
          detail: "Bearer token copied from the browser DevTools — expires after ~1 hour.",
          id: "access",
        },
      ],
      { title: `Authenticate to '${settings.envName}'`, placeHolder: "Choose how to provide credentials" },
    );
    if (!pick) return;
    if (pick.id === "pat") await credentials.promptPersonalAccessToken();
    else if (pick.id === "access") await credentials.promptAccessToken();
    void vscode.commands.executeCommand("deeDebugger.refresh");
  };

  /**
   * Activate an environment. Credential prompting when the environment has none is
   * handled centrally by the activation handler (extension.ts) so every path — switch,
   * connect, add/remove fall-over, and direct settings edits — behaves the same and we
   * never double-prompt. The configuration-change listener recreates the client and
   * refreshes the tree.
   */
  const activateEnvironment = async (name: string): Promise<void> => {
    await setActiveEnvironment(name);
  };

  register("deeDebugger.switchEnvironment", async () => {
    const settings = readSettings();
    const tokenBadge = async (env: string): Promise<string> =>
      (await credentials.hasCredentials(env)) ? "$(key) token set" : "$(warning) no token";
    const items = [
      ...(await Promise.all(
        settings.environments.map(async (env) => ({
          label: settings.envName === env.name ? `$(check) ${env.name}` : env.name,
          description: `${env.hostAddress ?? DEFAULT_HOST_ADDRESS} · ${await tokenBadge(env.name)}`,
          name: env.name as string | undefined,
          add: false as string | boolean,
        })),
      )),
      { label: "$(add) Add environment…", description: "guided setup of a new named MES environment", name: undefined, add: true as string | boolean },
      { label: "$(search) Discover environments…", description: "probe this machine for local / docker / docker-in-docker MES stacks", name: undefined, add: "discover" as string | boolean },
      { label: "$(gear) Manage environments…", description: "edit, rename or remove environments", name: undefined, add: "manage" as string | boolean },
    ];
    const choice = await vscode.window.showQuickPick(items, {
      title: "Switch MES environment",
      placeHolder:
        settings.environments.length === 0
          ? "No environments yet — discover or add one"
          : `Active: ${settings.envName ?? "none"} — switching also switches stored credentials`,
    });
    if (!choice) return;
    if (choice.add) {
      const command =
        choice.add === "discover"
          ? "deeDebugger.discoverEnvironments"
          : choice.add === "manage"
            ? "deeDebugger.manageEnvironments"
            : "deeDebugger.addEnvironment";
      await vscode.commands.executeCommand(command);
      return;
    }
    if (choice.name) await activateEnvironment(choice.name);
  });

  register("deeDebugger.discoverEnvironments", async () => {
    const discovered = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Discovering MES environments on this machine…" },
      () => discoverEnvironments((m) => output.appendLine(`[discover] ${m}`)),
    );
    const settings = readSettings();
    const fresh = discovered.filter((d) => !settings.environments.some((e) => sameEnvironment(e, d)));
    if (fresh.length === 0) {
      void vscode.window.showInformationMessage(
        discovered.length > 0
          ? "All discovered MES environments are already configured."
          : "No MES environments found — no host containers, docker-in-docker devcontainers, or local host process detected (see the DEE Debugger output for probe details).",
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      fresh.map((d) => ({
        label: `${d.reachable ? "$(pass-filled)" : "$(circle-slash)"} ${d.name}`,
        description: `${d.source} — ${d.hostAddress}${d.containerName ? ` · ${d.containerName}` : ""}`,
        detail: d.engineCommand ? `engine: ${d.engineCommand.join(" ")}` : undefined,
        picked: d.reachable,
        d,
      })),
      {
        title: `Discovered ${fresh.length} MES environment(s) — select which to add`,
        placeHolder: "$(pass-filled) = API answered a ping probe",
        canPickMany: true,
      },
    );
    if (!picked || picked.length === 0) return;
    const taken = new Set(settings.environments.map((e) => e.name));
    const profiles = picked.map(({ d }) => {
      const name = uniqueName(d.name, taken);
      taken.add(name);
      const { source: _source, reachable: _reachable, ...profile } = d;
      return { ...profile, name };
    });
    await updateSettingInOwningScope("environments", [...settings.environments, ...profiles]);
    if (profiles.length === 1) {
      const connect = await vscode.window.showInformationMessage(
        `Added environment '${profiles[0]!.name}'.`,
        "Connect",
      );
      if (connect === "Connect") await activateEnvironment(profiles[0]!.name);
    } else {
      const connect = await vscode.window.showInformationMessage(
        `Added ${profiles.length} environments: ${profiles.map((p) => p.name).join(", ")}.`,
        "Connect…",
      );
      if (connect === "Connect…") {
        // Several candidates — let the switcher (token badges included) pick one.
        await vscode.commands.executeCommand("deeDebugger.switchEnvironment");
      }
    }
  });

  /** Interactive prompts for an environment profile; existing = edit mode (prefilled). */
  const promptEnvironmentProfile = async (
    existing?: EnvironmentProfile,
  ): Promise<EnvironmentProfile | undefined> => {
    const settings = readSettings();
    const stage = existing ? `Edit environment '${existing.name}'` : "New environment";
    const name = await vscode.window.showInputBox({
      title: `${stage} — name (1/4)`,
      prompt: "Short identifier, e.g. 'local', 'cmf-io', 'shared-dev'. Also scopes the stored credentials.",
      value: existing?.name,
      validateInput: (value) => {
        if (!value.trim()) return "Name is required.";
        if (value.trim() !== existing?.name && settings.environments.some((e) => e.name === value.trim())) {
          return "An environment with this name already exists.";
        }
        return undefined;
      },
      ignoreFocusOut: true,
    });
    if (!name) return undefined;
    const hostAddress = await vscode.window.showInputBox({
      title: `${stage} — MES host address (2/4)`,
      prompt: "Base address of the MES API, e.g. http://localhost or http://172.17.0.2",
      value: existing?.hostAddress ?? (settings.hostAddress || DEFAULT_HOST_ADDRESS),
      validateInput: (value) => (/^https?:\/\/\S+$/.test(value.trim()) ? undefined : "Enter a http(s):// address."),
      ignoreFocusOut: true,
    });
    if (!hostAddress) return undefined;
    // Recognize an existing docker-in-docker engine command to prefill the devcontainer name.
    const existingDind = dindDevcontainerName(existing?.engineCommand);
    const kind = await vscode.window.showQuickPick(
      [
        { label: "Docker (local)", description: "host container on this machine's docker daemon", hostKind: "docker" as const, variant: "plain" },
        { label: "Docker-in-docker (devcontainer)", description: "stack started inside a devcontainer (cmf dev local stack up)", hostKind: "docker" as const, variant: "dind" },
        { label: "Docker (remote)", description: "another machine's daemon via a docker context or ssh://…/tcp://… host", hostKind: "docker" as const, variant: "remote" },
        { label: "Docker inside WSL", description: "VS Code on Windows, docker daemon inside a WSL distro", hostKind: "docker" as const, variant: "wsl" },
        { label: "Kubernetes (kubectl)", description: "host pod reachable with kubectl", hostKind: "kubernetes" as const, variant: "plain" },
        { label: "OpenShift (oc)", description: "host pod reachable with the oc CLI", hostKind: "kubernetes" as const, variant: "oc" },
        { label: "Local process", description: "host process shares this machine's filesystem", hostKind: "process" as const, variant: "plain" },
        { label: "Custom engine command…", description: "any docker-compatible CLI prefix (podman, nerdctl, ssh wrapper, …)", hostKind: "docker" as const, variant: "custom" },
      ],
      { title: `${stage} — where does the MES host run?`, ignoreFocusOut: true },
    );
    if (!kind) return undefined;

    const profile: EnvironmentProfile = { name: name.trim(), hostAddress: hostAddress.trim(), kind: kind.hostKind };
    const askContainerName = async (): Promise<boolean> => {
      const containerName = await vscode.window.showInputBox({
        title: `${stage} — host container name`,
        prompt: "cmf-cli scaffolded stacks name it 'custom_host'; some other stacks use 'host'.",
        value: existing?.containerName ?? (settings.hostTarget.containerName || "custom_host"),
        ignoreFocusOut: true,
      });
      if (!containerName) return false;
      profile.containerName = containerName.trim();
      return true;
    };

    if (kind.hostKind === "docker") {
      if (kind.variant === "dind") {
        const devcontainer = await vscode.window.showInputBox({
          title: `${stage} — devcontainer name`,
          prompt: "Name of the devcontainer running the inner docker daemon (find it with: docker ps). Tip: pin it via devcontainer.json runArgs [\"--name\", …] so it survives rebuilds.",
          value: existingDind,
          ignoreFocusOut: true,
        });
        if (!devcontainer) return undefined;
        profile.engineCommand = buildDockerEngineCommand({ type: "dind", devcontainer });
      } else if (kind.variant === "remote") {
        const remote = await vscode.window.showInputBox({
          title: `${stage} — docker context or host`,
          prompt: "A docker context name (docker context ls), or a daemon address like ssh://user@host or tcp://host:2376.",
          ignoreFocusOut: true,
        });
        if (!remote) return undefined;
        profile.engineCommand = buildDockerEngineCommand({ type: "remote", target: remote });
      } else if (kind.variant === "wsl") {
        const distro = await vscode.window.showInputBox({
          title: `${stage} — WSL distro (optional)`,
          prompt: "Leave empty for the default distro (wsl docker …), or name one (wsl -d <distro> docker …).",
          ignoreFocusOut: true,
        });
        if (distro === undefined) return undefined;
        profile.engineCommand = buildDockerEngineCommand({ type: "wsl", distro: distro || undefined });
      } else if (kind.variant === "custom") {
        const command = await vscode.window.showInputBox({
          title: `${stage} — engine command`,
          prompt: "Command prefix reaching the container engine, e.g. 'podman' or 'ssh devbox docker'. '<engine> exec …' is appended.",
          value: existing?.engineCommand?.join(" "),
          validateInput: (v) => (v.trim() ? undefined : "Command is required."),
          ignoreFocusOut: true,
        });
        if (!command) return undefined;
        profile.engineCommand = buildDockerEngineCommand({ type: "custom", command });
      }
      if (!(await askContainerName())) return undefined;
    } else if (kind.hostKind === "kubernetes") {
      if (kind.variant === "oc") profile.engineCommand = ["oc"];
      const k8sTarget = await vscode.window.showInputBox({
        title: `${stage} — ${kind.variant === "oc" ? "oc" : "kubectl"} exec target`,
        prompt: "e.g. 'deployment/host -n local' or a pod name (namespace flags allowed).",
        value: existing?.k8sTarget ?? settings.hostTarget.k8sTarget,
        ignoreFocusOut: true,
      });
      if (!k8sTarget) return undefined;
      profile.k8sTarget = k8sTarget.trim();
    }
    return profile;
  };

  const saveEnvironments = async (environments: EnvironmentProfile[]): Promise<void> => {
    // Write to the scope that owns the value (M8) — never fork Global/Workspace state.
    await updateSettingInOwningScope("environments", environments);
  };

  register("deeDebugger.addEnvironment", async () => {
    const profile = await promptEnvironmentProfile();
    if (!profile) return;
    await saveEnvironments([...readSettings().environments, profile]);
    void vscode.window.showInformationMessage(`Environment '${profile.name}' created and activated.`);
    // Activating it fires the central activation handler, which prompts for credentials
    // (the Set Credentials chooser) when the new environment has none — single prompt
    // point, consistent with every other activation path; no inline token prompt here.
    await activateEnvironment(profile.name);
  });

  register("deeDebugger.manageEnvironments", async () => {
    const settings = readSettings();
    if (settings.environments.length === 0) {
      void vscode.window.showInformationMessage("No environments defined yet — use 'Add Environment…' or 'Discover Environments…'.");
      return;
    }
    const env = await vscode.window.showQuickPick(
      settings.environments.map((e) => ({
        label: settings.envName === e.name ? `$(check) ${e.name}` : e.name,
        description: e.hostAddress,
        e,
      })),
      { title: "Manage environments — select one" },
    );
    if (!env) return;
    const action = await vscode.window.showQuickPick(
      [
        { label: "$(plug) Set active", action: "activate" as const },
        { label: "$(edit) Edit…", description: "change any field, including the name (credentials follow a rename)", action: "edit" as const },
        { label: "$(trash) Remove", description: "deletes the profile AND its stored credentials", action: "remove" as const },
      ],
      { title: `Environment '${env.e.name}'` },
    );
    if (!action) return;

    if (action.action === "activate") {
      await activateEnvironment(env.e.name);
      return;
    }

    if (action.action === "edit") {
      const updated = await promptEnvironmentProfile(env.e);
      if (!updated) return;
      await saveEnvironments(settings.environments.map((e) => (e.name === env.e.name ? updated : e)));
      if (updated.name !== env.e.name) {
        await credentials.migrate(env.e.name, updated.name);
        if (settings.envName === env.e.name) await setActiveEnvironment(updated.name);
      }
      void vscode.window.showInformationMessage(`Environment '${updated.name}' updated.`);
      void vscode.commands.executeCommand("deeDebugger.refresh");
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Remove environment '${env.e.name}'? Its stored credentials will be deleted. This does not touch the MES itself.`,
      { modal: true },
      "Remove",
    );
    if (confirmed !== "Remove") return;
    const remaining = settings.environments.filter((e) => e.name !== env.e.name);
    await saveEnvironments(remaining);
    await credentials.clearFor(env.e.name);
    if (settings.envName === env.e.name) {
      // Fall over to another environment when one exists; otherwise disconnect.
      await setActiveEnvironment(remaining[0]?.name);
    }
    void vscode.window.showInformationMessage(
      `Environment '${env.e.name}' removed${
        settings.envName === env.e.name
          ? remaining[0]
            ? ` (switched to '${remaining[0].name}')`
            : " (not connected — add or discover an environment)"
          : ""
      }.`,
    );
    void vscode.commands.executeCommand("deeDebugger.refresh");
  });

  register("deeDebugger.executeAction", async (node?: DeeTreeNode) => {
    const action = await resolveAction(node);
    if (!action) return;
    const mode = await vscode.window.showQuickPick(
      [
        {
          label: "$(shield) Execute read-only",
          description: "persistence side effects are discarded",
          readOnly: true,
        },
        {
          label: "$(zap) Execute",
          description: "runs like a real invocation — side effects PERSIST",
          readOnly: false,
        },
      ],
      { title: `Execute '${action.Name}'` },
    );
    if (!mode) return;
    const inputText = await vscode.window.showInputBox({
      title: `Input dictionary for '${action.Name}' (JSON object)`,
      value: "{}",
      ignoreFocusOut: true,
      validateInput: (text) => {
        try {
          const parsed = JSON.parse(text);
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? undefined
            : "Must be a JSON object.";
        } catch {
          return "Invalid JSON.";
        }
      },
    });
    if (inputText === undefined) return;
    if (!mode.readOnly) {
      const confirmed = await vscode.window.showWarningMessage(
        `Execute '${action.Name}' for real? Any side effects (data changes, transactions) will persist on ${readSettings().hostAddress}.`,
        { modal: true },
        "Execute",
      );
      if (confirmed !== "Execute") return;
    }
    try {
      const input = JSON.parse(inputText) as Record<string, unknown>;
      const started = Date.now();
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Executing '${action.Name}'…` },
        () =>
          mode.readOnly ? getClient().executeReadOnlyAction(action, input) : getClient().executeAction(action, input),
      );
      const report = {
        action: action.Name,
        mode: mode.readOnly ? "read-only" : "full",
        durationMs: Date.now() - started,
        input,
        output: decodeCmfValues(result.Output),
      };
      const document = await vscode.workspace.openTextDocument({
        content: JSON.stringify(report, null, 2),
        language: "json",
      });
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      if (error instanceof MesApiError && error.details) {
        output.appendLine(`[execute] ${action.Name}: ${extractServerMessage(error.details)}`);
      }
      showError(`Execution of '${action.Name}' failed`, error);
    }
  });

  register("deeDebugger.showVersionHistory", async (node?: DeeTreeNode) => {
    const action = await resolveAction(node);
    if (!action) return;
    try {
      // Always re-fetch: GetActionVersionsAsDataSet validates the concurrency token.
      const fresh = await getClient().getActionByName(action.Name);
      const rows = await getClient().getActionVersions(fresh);
      if (rows.length === 0) {
        void vscode.window.showInformationMessage(`No version history for '${action.Name}'.`);
        return;
      }
      const picked = await vscode.window.showQuickPick(
        rows
          .sort((a, b) => (b.Version ?? 0) - (a.Version ?? 0))
          .map((row) => ({
            label: `v${row.Version}${stateName(row.UniversalState) === "Effective" ? " $(pass-filled)" : ""}`,
            description: stateName(row.UniversalState),
            detail: `modified ${row.ModifiedOn ?? "?"} by ${row.ModifiedBy ?? "?"}`,
            row,
          })),
        { title: `Version history of '${action.Name}' (${rows.length} versions)` },
      );
      if (!picked) return;
      const versionAction = await getClient().getActionById(picked.row.Id);
      const fullCode = await getClient().getActionFullCode(versionAction);
      const uri = serverContent.set(`${action.Name}@v${picked.row.Version}`, fullCode);
      const session = sessions.get(action.Name);
      if (session) {
        await vscode.commands.executeCommand(
          "vscode.diff",
          uri,
          vscode.Uri.file(session.localPath),
          `${action.Name}: v${picked.row.Version} (MES) ↔ local`,
        );
      } else {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
      }
      // A staged (Active) version can be promoted from here — the one place that lists
      // versions other than the tree's representative row.
      if (canMakeEffective(versionAction)) {
        const choice = await vscode.window.showInformationMessage(
          `v${picked.row.Version} of '${action.Name}' is ${stateName(versionAction.UniversalState)} (not effective).`,
          `Make v${picked.row.Version} Effective`,
        );
        if (choice) await makeVersionEffective(action, versionAction);
      }
    } catch (error) {
      showError(`Failed to load version history of '${action.Name}'`, error);
    }
  });

  register("deeDebugger.setCredentials", async () => {
    await chooseAndSetCredentials();
  });

  register("deeDebugger.setAccessToken", async () => {
    await credentials.promptAccessToken();
  });

  register("deeDebugger.setPersonalAccessToken", async () => {
    await credentials.promptPersonalAccessToken();
  });

  register("deeDebugger.clearCredentials", async () => {
    await credentials.clear();
    void vscode.window.showInformationMessage("DEE Debugger credentials cleared.");
  });

  register("deeDebugger.collectSupportBundle", async () => {
    const settings = readSettings();
    let engineProbe: string;
    try {
      await runCli(execInHostArgs(settings.hostTarget, ["sh", "-c", "echo reachable"]), undefined, 5_000);
      engineProbe = "host container reachable via engine command";
    } catch (error) {
      engineProbe = `host container NOT reachable: ${error instanceof Error ? error.message : error}`;
    }
    // Credential METADATA only — the first thing support asks on an auth ticket — never
    // the token value (SUP §6.1-3): present y/n, kind, expiry, and the identity claim.
    const creds = await credentials.get();
    const activeToken = creds.accessToken ?? creds.personalAccessToken;
    const tokenInfo = activeToken ? decodeJwt(activeToken) : undefined;
    const credentialInfo = {
      hasAccessToken: Boolean(creds.accessToken),
      hasPat: Boolean(creds.personalAccessToken),
      inUse: creds.accessToken ? "access token (Bearer)" : creds.personalAccessToken ? "PAT (Basic)" : "none",
      expiresAt: tokenInfo?.expiresAt?.toISOString() ?? null,
      expired: tokenInfo?.expiresAt ? tokenInfo.expiresAt.getTime() < Date.now() : null,
      subject: typeof tokenInfo?.payload?.["sub"] === "string" ? (tokenInfo.payload["sub"] as string) : null,
    };
    // Engine commands can carry inline passwords (`sshpass -p …`); their argv is serialized as
    // a JSON array, so scrub element-wise here — the string redactor below can't see array-split
    // `flag`/`value` pairs.
    const safeHostTarget = {
      ...settings.hostTarget,
      engineCommand: settings.hostTarget.engineCommand
        ? redactArgvSecrets(settings.hostTarget.engineCommand)
        : settings.hostTarget.engineCommand,
    };
    const safeEnvironments = settings.environments.map((e) =>
      e.engineCommand ? { ...e, engineCommand: redactArgvSecrets(e.engineCommand) } : e,
    );
    const bundle = {
      collectedAt: new Date().toISOString(),
      extension: `dee-debugger v${(context.extension?.packageJSON as { version?: string } | undefined)?.version ?? "?"}`,
      vscode: vscode.version,
      platform: `${process.platform}/${process.arch}`,
      remote: vscode.env.remoteName ?? null,
      activeEnvironment: settings.envName ?? null,
      hostAddress: settings.hostAddress || null,
      hostTarget: safeHostTarget,
      environments: safeEnvironments,
      credential: credentialInfo,
      deesFolder: settings.deesFolderSetting || "(auto-detect)",
      engineProbe,
      sessions: sessions.all().map((s) => ({
        action: s.action.Name,
        env: s.envName ?? null,
        debugOn: s.debugOn,
        pendingUpload: s.pendingUpload,
      })),
      recentLog: output.recentLines(),
    };
    // Tokens never appear in settings; the log ring is pre-redacted; engine-command argv is
    // scrubbed above; redact once more end-to-end as a belt-and-braces guarantee before sharing.
    const content = redactSecrets(JSON.stringify(bundle, null, 2));
    const document = await vscode.workspace.openTextDocument({ content, language: "json" });
    await vscode.window.showTextDocument(document, { preview: false });
    void vscode.window.showInformationMessage(
      "Support bundle opened as an unsaved document — review it, then save/attach it to your support ticket. Tokens are never included.",
    );
  });

  register("deeDebugger.testConnection", async () => {
    try {
      await getClient().testConnection();
      const settings = readSettings();
      void vscode.window.showInformationMessage(`Connected to ${settings.hostAddress} successfully.`);
      // R7: credentials over cleartext HTTP to a non-local host are sniffable.
      try {
        const parsed = new URL(settings.hostAddress);
        const local =
          parsed.hostname === "localhost" || /^127\./.test(parsed.hostname) || parsed.hostname.endsWith(".local") ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(parsed.hostname);
        if (parsed.protocol === "http:" && !local) {
          void vscode.window.showWarningMessage(
            `'${settings.envName ?? settings.hostAddress}' uses plain HTTP to a non-local host — your token is sent unencrypted. Prefer https for remote MES instances.`,
          );
        }
      } catch {
        // unparseable address — nothing to warn about
      }
    } catch (error) {
      showError("Connection test failed", error);
    }
  });

  // While debug mode is on, every local save is pushed to the host filesystem so the
  // next execution compiles the latest code.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      // Saving the DeeDevBase-format source of a working copy: carry its bodies into the
      // working copy, which is what gets uploaded and debugged (ADR 0012).
      const owner = sessions.getBySourcePath(document.uri.fsPath);
      if (owner) {
        try {
          if (vscode.workspace.textDocuments.find((d) => d.uri.fsPath === owner.localPath && d.isDirty)) {
            void vscode.window.showWarningMessage(
              `'${owner.action.Name}': the working copy has unsaved changes, so it was not updated from ${path.basename(document.uri.fsPath)}.`,
            );
            return;
          }
          const bodies = extractBodies(document.getText());
          const working = await fs.readFile(owner.localPath, "utf8");
          const updated = replaceBodies(working, bodies.actionCode, bodies.validationCode);
          if (updated !== working) {
            await fs.writeFile(owner.localPath, updated, "utf8");
            output.appendLine(`[dees] working copy of '${owner.action.Name}' updated from ${path.basename(document.uri.fsPath)}.`);
            // Continue as if the working copy itself was saved (pending upload + debug push).
            document = { uri: vscode.Uri.file(owner.localPath) } as vscode.TextDocument;
          } else {
            return;
          }
        } catch (error) {
          output.appendLine(`[dees] could not update the working copy of '${owner.action.Name}': ${error instanceof Error ? error.message : error}`);
          return;
        }
      }
      const session = sessions.getByPath(document.uri.fsPath);
      if (!session) return;
      sessions.update(session.action.Name, { pendingUpload: true });
      if (session.debugOn) {
        try {
          // C1 guard: flag the push so the debug watcher never misreads a half-landed
          // push as a host rewrite and pulls the stale host copy over this save.
          sessions.update(session.action.Name, { pushInFlight: true });
          const pushStarted = Date.now();
          const content = await fs.readFile(session.localPath);
          const bridge = createFileBridge(readSettings().hostTarget, await debugLocalRoot(readSettings().hostTarget));
          await bridge.publish(session.localPath);
          sessions.update(session.action.Name, {
            lastPushedHash: md5Hex(content),
            lastPushAt: Date.now(),
          });
          output.appendLine(
            `[debug] pushed '${session.action.Name}' (${content.length} bytes, ${Date.now() - pushStarted} ms)`,
          );
          vscode.window.setStatusBarMessage(`DEE: pushed '${session.action.Name}' to host`, 3000);
        } catch (error) {
          showError(`Failed to push '${session.action.Name}' to the host`, error);
        } finally {
          sessions.update(session.action.Name, { pushInFlight: false });
        }
      }
    }),
  );
}
