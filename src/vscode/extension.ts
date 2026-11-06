import * as vscode from "vscode";
import { MesClient } from "../core/mesClient";
import { decideActivation, resolveEnvironment } from "../core/env";
import { CredentialStore, migrateLegacyFlatSettings, readSettings } from "./settings";
import { SessionStore } from "./session";
import { DeeExplorerProvider } from "./explorer";
import { DeeDiagnostics } from "./diagnostics";
import { registerCommands } from "./commands";
import { SERVER_SCHEME, ServerDeeContentProvider } from "./sync";
import { DebugFileWatcher } from "./debugFileWatcher";
import { SupportLogger } from "./logging";

let onDeactivate: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = new SupportLogger("DEE Debugger");
  const credentials = new CredentialStore(context.secrets, undefined, (m) => output.appendLine(m));
  const sessions = new SessionStore();
  const diagnostics = new DeeDiagnostics();
  context.subscriptions.push(output, sessions, diagnostics);

  // Support banner (supportability review L2): the first lines a support engineer needs.
  const version = (context.extension.packageJSON as { version?: string }).version ?? "?";
  output.appendLine(
    `[startup] DEE Debugger v${version} · VS Code ${vscode.version} · ${process.platform}/${process.arch}` +
      `${vscode.env.remoteName ? ` · remote=${vscode.env.remoteName}` : ""}`,
  );

  let client = createClient(credentials, output);
  const getClient = (): MesClient => client;

  /** Client bound to a SPECIFIC environment (R2) — for cleanup against a previous env. */
  const createClientFor = (envName: string): MesClient | undefined => {
    const resolved = resolveEnvironment(readSettings().environments, envName);
    if (!resolved) return undefined;
    const scoped = new CredentialStore(context.secrets, () => envName);
    return new MesClient({
      hostAddress: resolved.settings.hostAddress,
      credentials: () => scoped.get(),
      culture: vscode.env.language || "en-US",
      log: (message) => output.appendLine(`[api:${envName}] ${message}`),
    });
  };

  const explorer = new DeeExplorerProvider(
    getClient,
    () => readSettings().showDisabledActions,
    sessions,
    () => readSettings().envName,
  );
  const treeView = vscode.window.createTreeView("deeDebugger.explorer", {
    treeDataProvider: explorer,
    showCollapseAll: true,
  });
  explorer.attachView(treeView);
  context.subscriptions.push(treeView);

  // R5: reconcile local debug flags with the server's per-user view after every refresh —
  // a host restart clears the in-memory registrations while our badge would keep lying.
  context.subscriptions.push(
    explorer.onDidRefresh((actions) => {
      const serverByName = new Map(actions.map((a) => [a.Name, a]));
      for (const session of sessions.debugging()) {
        const server = serverByName.get(session.action.Name);
        if (server && server.IsInDebugMode === false) {
          sessions.update(session.action.Name, { debugOn: false, hostPath: undefined });
          output.appendLine(
            `[debug] host no longer holds the debug registration for '${session.action.Name}' (host restarted?).`,
          );
          void vscode.window
            .showWarningMessage(
              `Debug mode for '${session.action.Name}' was lost (the MES host restarted). Re-enable?`,
              "Re-enable Debug Mode",
            )
            .then((choice) => {
              if (choice === "Re-enable Debug Mode") {
                void vscode.commands.executeCommand("deeDebugger.toggleDebugMode");
              }
            });
        }
      }
    }),
  );

  const serverContent = new ServerDeeContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SERVER_SCHEME, serverContent),
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = "deeDebugger.switchEnvironment";
  const updateStatusBar = (): void => {
    const settings = readSettings();
    const debugging = sessions.debugging();
    if (settings.envName) {
      // UX: the live debug-mode count belongs where the eye already is — a forgotten
      // registration keeps the host compiling from your file for every execution.
      const debugBadge = debugging.length > 0 ? ` · $(debug) ${debugging.length}` : "";
      statusBar.text = `$(circuit-board) MES: ${settings.envName}${debugBadge}`;
      statusBar.tooltip =
        `DEE Debugger — environment '${settings.envName}' → ${settings.hostAddress} (${settings.hostTarget.kind}). Click to switch environment.` +
        (debugging.length > 0 ? `\nDebug mode ON for: ${debugging.map((s) => s.action.Name).join(", ")}` : "");
    } else {
      statusBar.text = `$(circuit-board) MES: not connected`;
      statusBar.tooltip = "DEE Debugger — no environment selected. Click to switch, add, or discover one.";
    }
    statusBar.show();
  };
  updateStatusBar();
  context.subscriptions.push(statusBar, sessions.onDidChange(updateStatusBar));

  // Drives the per-state welcome view (not connected / needs credentials / connected but empty).
  const updateConnectionState = async (): Promise<void> => {
    const settings = readSettings();
    const hasCreds = settings.envName ? await credentials.hasCredentials(settings.envName) : false;
    void vscode.commands.executeCommand("setContext", "deeDebugger.connectionState", decideActivation(settings.envName, hasCreds));
  };
  void updateConnectionState();
  context.subscriptions.push(context.secrets.onDidChange?.(() => void updateConnectionState()) ?? { dispose: () => undefined });

  // R2: when the active environment changes, sessions from the previous environment are
  // invalid — deactivate their debug registrations against the PREVIOUS env and drop them.
  let currentEnv = readSettings().envName;
  const handleEnvironmentChange = async (): Promise<void> => {
    const previous = currentEnv;
    currentEnv = readSettings().envName;
    if (previous === currentEnv) return;
    output.appendLine(`[env] switched: ${previous ?? "(none)"} → ${currentEnv ?? "(none)"}`);
    const dropped = sessions.clear();
    const debugging = dropped.filter((s) => s.debugOn);
    if (debugging.length > 0 && previous) {
      const oldClient = createClientFor(previous);
      if (oldClient) {
        const results = await Promise.allSettled(debugging.map((s) => oldClient.deactivateDebugMode(s.action)));
        const failed = results.filter((r) => r.status === "rejected").length;
        output.appendLine(
          `[env] deactivated ${debugging.length - failed}/${debugging.length} debug registration(s) on '${previous}'.`,
        );
      } else {
        output.appendLine(`[env] '${previous}' no longer exists — its debug registrations expire with the host.`);
      }
    }
  };

  // M3: differentiate config changes — connection changes recreate the client and refresh
  // (debounced: env switches and migration produce bursts of writes); display-only changes
  // rebuild locally without a server round-trip.
  let refreshTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("deeDebugger")) return;
      const connectionChange =
        event.affectsConfiguration("deeDebugger.environments") ||
        event.affectsConfiguration("deeDebugger.activeEnvironment");
      if (!connectionChange) {
        explorer.rebuild(); // showDisabledActions / deesFolder — no server round-trip (R8)
        return;
      }
      client = createClient(credentials, output);
      updateStatusBar();
      void updateConnectionState();
      void handleEnvironmentChange();
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void (async () => {
          const settings = readSettings();
          const hasCreds = settings.envName ? await credentials.hasCredentials(settings.envName) : false;
          const decision = decideActivation(settings.envName, hasCreds);
          switch (decision) {
            case "not-connected":
              explorer.rebuild();
              return;
            case "needs-credentials":
              // Switching/connecting to an environment with no stored credentials: ask for
              // them (the chooser offers PAT / access token). Single prompt point for every
              // activation path — switches, add/remove fall-over, settings edits. (Also
              // suppresses the doomed auto-refresh + its error toast behind the dialog.)
              output.appendLine(`[env] '${settings.envName}' has no stored token — asking for credentials.`);
              explorer.rebuild();
              void vscode.commands.executeCommand("deeDebugger.setCredentials");
              return;
            case "ready":
              void vscode.commands.executeCommand("deeDebugger.refresh");
              return;
            default: {
              // Exhaustiveness guard: a new ActivationDecision must be handled explicitly.
              const _never: never = decision;
              void _never;
            }
          }
        })();
      }, 150);
    }),
  );

  registerCommands(context, { getClient, explorer, sessions, diagnostics, credentials, output, serverContent });
  context.subscriptions.push(new DebugFileWatcher(sessions, output));

  // Track the coreclr attach sessions WE start, so we can detach them on shutdown. An attach
  // session left running when the window/WSL closes abruptly leaves vsdbg attached to the MES
  // host with its request threads suspended — after which every /api call hangs (a killed
  // vsdbg does not resume them; only a host restart recovers). Detaching cleanly on deactivate
  // prevents that. Our attach configs are named "Attach to MES Host…" (see commands.ts).
  const ourDebugSessions = new Set<vscode.DebugSession>();
  const isOurAttach = (s: vscode.DebugSession): boolean =>
    s.type === "coreclr" && typeof s.name === "string" && s.name.startsWith("Attach to MES Host");
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((s) => {
      if (isOurAttach(s)) ourDebugSessions.add(s);
    }),
    vscode.debug.onDidTerminateDebugSession((s) => ourDebugSessions.delete(s)),
  );

  onDeactivate = async () => {
    // 1) Detach our debuggers first (stopDebugging on an attach session disconnects → detaches
    //    → resumes the host), so shutdown can never orphan a vsdbg holding the host suspended.
    if (ourDebugSessions.size > 0) {
      output.appendLine(`[debug] detaching ${ourDebugSessions.size} attach session(s) on shutdown.`);
      await Promise.allSettled([...ourDebugSessions].map((s) => vscode.debug.stopDebugging(s)));
    }
    // 2) Then deactivate DEE debug registrations against each session's environment (R2),
    //    falling back to the current client for sessions predating env tracking.
    const debugging = sessions.debugging();
    if (debugging.length === 0) return;
    await Promise.allSettled(
      debugging.map((s) => (s.envName ? (createClientFor(s.envName) ?? getClient()) : getClient()).deactivateDebugMode(s.action)),
    );
  };

  void (async () => {
    try {
      const migrated = await migrateLegacyFlatSettings(credentials);
      if (migrated) {
        output.appendLine(`[startup] migrated legacy flat settings into environment '${migrated}'.`);
        updateStatusBar();
      }
      const creds = await credentials.get();
      if (readSettings().envName && (creds.accessToken || creds.personalAccessToken)) {
        await explorer.refresh();
      }
    } catch (error) {
      output.appendLine(
        `[startup] initial load failed (welcome view shown): ${error instanceof Error ? error.message : error}`,
      );
    }
  })();

  output.appendLine("[startup] DEE Debugger activated.");
}

export function deactivate(): Promise<void> | undefined {
  return onDeactivate?.();
}

function createClient(credentials: CredentialStore, output: SupportLogger): MesClient {
  const settings = readSettings();
  return new MesClient({
    hostAddress: settings.hostAddress,
    credentials: () => credentials.get(),
    culture: vscode.env.language || "en-US",
    log: (message) => output.appendLine(`[api] ${message}`),
  });
}
