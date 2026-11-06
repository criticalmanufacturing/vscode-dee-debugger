/**
 * Minimal 'vscode' module stub for headless unit tests of the VS Code layer
 * (wired via the resolve.alias in vitest.config.ts). Extend as tests need it —
 * keep every member behaviorally faithful to the real API.
 */

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;

export class EventEmitter<T> {
  private readonly listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire(e: T): void {
    for (const listener of this.listeners) listener(e);
  }
  dispose(): void {
    this.listeners.length = 0;
  }
}

export class RelativePattern {
  constructor(
    public base: unknown,
    public pattern: string,
  ) {}
}

/**
 * Scoped configuration model (faithful to real VS Code: get() merges workspace over
 * global; update() targets a scope; inspect() reveals per-scope values — array settings
 * shadow, they never merge). __setConfig seeds the GLOBAL scope.
 */
let globalConfig: Record<string, unknown> = {};
let workspaceConfig: Record<string, unknown> = {};
export function __setConfig(data: Record<string, unknown>): void {
  globalConfig = data;
  workspaceConfig = {};
}
export function __setWorkspaceConfig(data: Record<string, unknown>): void {
  workspaceConfig = data;
}
/** Merged view (workspace shadows global) — what get() returns. */
export function __getConfig(): Record<string, unknown> {
  return { ...globalConfig, ...workspaceConfig };
}
export function __getScopedConfig(): { global: Record<string, unknown>; workspace: Record<string, unknown> } {
  return { global: globalConfig, workspace: workspaceConfig };
}

/** Faithful-enough shape of vscode.TextDocument for the members the extension uses. */
export interface FakeTextDocument {
  uri: { fsPath: string };
  getText(): string;
  isDirty: boolean;
  save(): Promise<boolean>;
  readonly lineCount: number;
  lineAt(line: number): { text: string };
}

// Real VS Code exposes every open document (dirty or not) in workspace.textDocuments;
// openTextDocument returns the already-open document for a path when there is one.
const textDocumentsData: FakeTextDocument[] = [];
export function __addTextDocument(fsPath: string, text = "", isDirty = false): FakeTextDocument {
  const lines = (): string[] => text.split(/\r\n|\r|\n/);
  const doc: FakeTextDocument = {
    uri: { fsPath },
    getText: () => text,
    isDirty,
    save: async () => {
      doc.isDirty = false;
      return true;
    },
    get lineCount() {
      return lines().length;
    },
    lineAt: (line: number) => ({ text: lines()[line] ?? "" }),
  };
  textDocumentsData.push(doc);
  return doc;
}

const saveListeners: ((doc: unknown) => unknown)[] = [];
/** Fire the onDidSaveTextDocument listeners registered by the code under test. */
export async function __fireDidSave(doc: { uri: { fsPath: string }; getText(): string }): Promise<void> {
  for (const l of saveListeners) await l(doc);
}

type FindFilesHandler = (include?: unknown, exclude?: unknown) => Promise<{ fsPath: string }[]>;
let findFilesHandler: FindFilesHandler | undefined;
export function __setFindFiles(handler?: FindFilesHandler): void {
  findFilesHandler = handler;
}

export function __setWorkspaceFolders(folders: { uri: { fsPath: string } }[] | undefined): void {
  workspace.workspaceFolders = folders;
}

export const workspace = {
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
  textDocuments: textDocumentsData as FakeTextDocument[],
  getConfiguration: (_section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T => {
      if (key in workspaceConfig) return workspaceConfig[key] as T;
      if (key in globalConfig) return globalConfig[key] as T;
      return defaultValue as T;
    },
    inspect: (key: string) => ({
      key,
      globalValue: key in globalConfig ? globalConfig[key] : undefined,
      workspaceValue: key in workspaceConfig ? workspaceConfig[key] : undefined,
      workspaceFolderValue: undefined,
    }),
    update: async (key: string, value: unknown, target?: number): Promise<void> => {
      // Real VS Code defaults to Workspace when no target is given.
      const bag = target === ConfigurationTarget.Global ? globalConfig : workspaceConfig;
      if (value === undefined) delete bag[key];
      else bag[key] = value;
    },
  }),
  findFiles: async (include?: unknown, exclude?: unknown): Promise<unknown[]> =>
    findFilesHandler ? findFilesHandler(include, exclude) : [],
  onDidSaveTextDocument: (listener: (doc: unknown) => unknown): { dispose(): void } => {
    saveListeners.push(listener);
    return { dispose: () => undefined };
  },
  openTextDocument: async (arg?: unknown): Promise<FakeTextDocument> => {
    const fsPath = typeof arg === "string" ? arg : (arg as { fsPath?: string } | undefined)?.fsPath;
    const existing = fsPath ? textDocumentsData.find((d) => d.uri.fsPath === fsPath) : undefined;
    if (existing) return existing;
    return {
      uri: { fsPath: fsPath ?? "" },
      getText: () => "",
      isDirty: false,
      save: async () => true,
      lineCount: 1,
      lineAt: () => ({ text: "" }),
    };
  },
};

let inputBoxValue: string | undefined;
export function __setInputBox(value: string | undefined): void {
  inputBoxValue = value;
}
const inputBoxQueue: (string | undefined)[] = [];
export function __queueInputBox(value: string | undefined): void {
  inputBoxQueue.push(value);
}

type QuickPickResponder = (items: unknown[], options: unknown) => unknown;
const quickPickQueue: QuickPickResponder[] = [];
export function __queueQuickPick(responder: QuickPickResponder): void {
  quickPickQueue.push(responder);
}

const infoResponseQueue: (string | undefined)[] = [];
export function __queueInfoResponse(button: string | undefined): void {
  infoResponseQueue.push(button);
}

export const messages: string[] = [];
export function __reset(): void {
  messages.length = 0;
  quickPickQueue.length = 0;
  infoResponseQueue.length = 0;
  inputBoxQueue.length = 0;
  inputBoxValue = undefined;
  globalConfig = {};
  workspaceConfig = {};
  textDocumentsData.length = 0;
  findFilesHandler = undefined;
  workspace.workspaceFolders = undefined;
  breakpointsData = [];
  // The C# extension is declared as an extensionDependency, so treat it as present by
  // default; tests that exercise the "C# not installed" path clear it explicitly.
  installedExtensions = new Set(["ms-dotnettools.csharp"]);
  openedExternalUris.length = 0;
}

export const window = {
  showInputBox: async (options?: {
    validateInput?: (value: string) => string | undefined | null;
  }): Promise<string | undefined> => {
    const value = inputBoxQueue.length > 0 ? inputBoxQueue.shift() : inputBoxValue;
    // Real VS Code blocks submission of invalid input; model that as a cancel.
    if (value !== undefined && options?.validateInput && options.validateInput(value)) return undefined;
    return value;
  },
  showInformationMessage: (message: string, ...rest: unknown[]): Promise<string | undefined> => {
    messages.push(message);
    const buttons = rest.filter((r): r is string => typeof r === "string");
    if (buttons.length === 0) return Promise.resolve(undefined);
    const response = infoResponseQueue.shift();
    return Promise.resolve(response && buttons.includes(response) ? response : undefined);
  },
  showWarningMessage: async (message: string, ...rest: unknown[]): Promise<string | undefined> => {
    messages.push(message);
    const buttons = rest.filter((r): r is string => typeof r === "string");
    if (buttons.length === 0) return undefined;
    const response = infoResponseQueue.shift();
    return response && buttons.includes(response) ? response : undefined;
  },
  showErrorMessage: (message: string, ...rest: unknown[]): Promise<string | undefined> => {
    messages.push(message);
    const buttons = rest.filter((r): r is string => typeof r === "string");
    if (buttons.length === 0) return Promise.resolve(undefined);
    const response = infoResponseQueue.shift();
    return Promise.resolve(response && buttons.includes(response) ? response : undefined);
  },
  showQuickPick: async (items: unknown[] | Promise<unknown[]>, options: unknown): Promise<unknown> => {
    const responder = quickPickQueue.shift();
    if (!responder) return undefined;
    return responder(await items, options);
  },
  withProgress: async <T>(_options: unknown, task: (progress: unknown, token: unknown) => Thenable<T>): Promise<T> =>
    task({ report: () => undefined }, { isCancellationRequested: false }),
  setStatusBarMessage: (): { dispose(): void } => ({ dispose: () => undefined }),
  showTextDocument: async (document: unknown): Promise<{ document: unknown }> => ({ document }),
  activeTextEditor: undefined as unknown,
};

const commandRegistry = new Map<string, (...args: unknown[]) => unknown>();
export const commands = {
  registerCommand: (id: string, handler: (...args: unknown[]) => unknown): { dispose(): void } => {
    commandRegistry.set(id, handler);
    return { dispose: () => commandRegistry.delete(id) };
  },
  executeCommand: async (id: string, ...args: unknown[]): Promise<unknown> => commandRegistry.get(id)?.(...args),
};
export function __getCommand(id: string): ((...args: unknown[]) => unknown) | undefined {
  return commandRegistry.get(id);
}
export function __resetCommands(): void {
  commandRegistry.clear();
  saveListeners.length = 0;
}

export const languages = {
  createDiagnosticCollection: () => ({
    set: () => undefined,
    delete: () => undefined,
    dispose: () => undefined,
  }),
};

/** Minimal SourceBreakpoint stand-in (only the members the extension reads). */
export class SourceBreakpoint {
  constructor(
    public readonly id: string,
    public readonly enabled = true,
  ) {}
}

let breakpointsData: SourceBreakpoint[] = [];
export function __setBreakpoints(bps: SourceBreakpoint[]): void {
  breakpointsData = bps;
}

export const debug = {
  activeDebugSession: undefined as unknown,
  startDebugging: async (): Promise<boolean> => true,
  get breakpoints(): SourceBreakpoint[] {
    return breakpointsData;
  },
  onDidChangeBreakpoints: (_listener: (e: unknown) => void): { dispose(): void } => ({ dispose: () => undefined }),
  onDidTerminateDebugSession: (_listener: (e: unknown) => void): { dispose(): void } => ({ dispose: () => undefined }),
};

let installedExtensions = new Set<string>();
export function __setInstalledExtensions(ids: string[]): void {
  installedExtensions = new Set(ids);
}
export const extensions = {
  getExtension: (id: string): { id: string } | undefined =>
    installedExtensions.has(id) ? { id } : undefined,
};

export const openedExternalUris: string[] = [];
export const env = {
  openExternal: async (uri: { toString(): string }): Promise<boolean> => {
    openedExternalUris.push(uri.toString());
    return true;
  },
};

/** Tree API surface used by the explorer (TreeItem is a plain data bag in VS Code too). */
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export class TreeItem {
  id?: string;
  description?: string | boolean;
  tooltip?: unknown;
  iconPath?: unknown;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    public label: string,
    public collapsibleState: number = TreeItemCollapsibleState.None,
  ) {}
}
export class ThemeColor {
  constructor(public readonly id: string) {}
}
export class ThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: ThemeColor,
  ) {}
}
export class MarkdownString {
  constructor(public value = "") {}
}

export const Uri = {
  file: (fsPath: string): { fsPath: string } => ({ fsPath }),
  parse: (value: string): { toString(): string } => ({ toString: () => value }),
  from: (components: Record<string, unknown>): Record<string, unknown> => ({ ...components }),
};
