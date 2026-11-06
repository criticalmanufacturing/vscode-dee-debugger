import * as vscode from "vscode";
import * as path from "node:path";
import { HostTarget, HostKind } from "../core/types";
import { MesCredentials } from "../core/mesClient";
import { decodeJwt } from "../core/jwt";
import { DEFAULT_HOST_TARGET, EnvironmentProfile, resolveEnvironment } from "../core/env";

export interface Settings {
  /** Empty string = no environment selected (not connected). */
  hostAddress: string;
  showDisabledActions: boolean;
  deesFolderSetting: string;
  /** `deeDebugger.deesFolder` as a list (the setting accepts a string or an array). */
  deesFolderSettings: string[];
  hostTarget: HostTarget;
  /** Active environment name; undefined = not connected. */
  envName?: string;
  environments: EnvironmentProfile[];
}

export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration("deeDebugger");
  const environments = config.get<EnvironmentProfile[]>("environments", []);
  const resolved = resolveEnvironment(environments, config.get<string>("activeEnvironment", ""));
  return {
    hostAddress: resolved?.settings.hostAddress ?? "",
    hostTarget: resolved?.settings.hostTarget ?? { ...DEFAULT_HOST_TARGET },
    envName: resolved?.envName,
    environments,
    showDisabledActions: config.get<boolean>("showDisabledActions", false),
    deesFolderSetting: deesSettingList(config.get<string | string[]>("deesFolder", ""))[0] ?? "",
    deesFolderSettings: deesSettingList(config.get<string | string[]>("deesFolder", "")),
  };
}

/**
 * One-time migration from the pre-0.2 "flat settings + Default credentials" model:
 * when no environments exist but legacy connection settings or Default-scoped tokens
 * are present, wrap them into an environment named "default" and activate it.
 */
export async function migrateLegacyFlatSettings(credentials: CredentialStore): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration("deeDebugger");
  if ((config.get<EnvironmentProfile[]>("environments", []) ?? []).length > 0) return undefined;
  const legacyHost = config.get<string>("hostAddress", "");
  const hadLegacyCredentials = await credentials.hasCredentials(undefined);
  if (!legacyHost && !hadLegacyCredentials) return undefined;
  const profile: EnvironmentProfile = {
    name: "default",
    hostAddress: legacyHost || undefined,
    kind: config.get<HostKind>("host.kind") ?? undefined,
    containerName: config.get<string>("host.containerName") || undefined,
    k8sTarget: config.get<string>("host.k8sTarget") || undefined,
    engineCommand: (config.get<string[]>("host.engineCommand", []) ?? []).length > 0
      ? config.get<string[]>("host.engineCommand")
      : undefined,
    sourcePathInHost: config.get<string>("host.sourcePathInHost") || undefined,
    useMount: config.get<boolean>("host.useMount") || undefined,
    vsdbgPath: config.get<string>("host.vsdbgPath") || undefined,
  };
  // Migration writes to GLOBAL: it must not silently create .vscode/settings.json in
  // the user's repo (engineering review M8), and environments are machine-scoped (R1).
  await config.update("environments", [profile], vscode.ConfigurationTarget.Global);
  await config.update("activeEnvironment", "default", vscode.ConfigurationTarget.Global);
  if (hadLegacyCredentials) await credentials.migrate(undefined, "default");
  return "default";
}

/**
 * Write a deeDebugger setting to the scope that currently DEFINES its value, so edits
 * never fork state across Global/Workspace (M8: array settings shadow, they don't
 * merge — writing the merged view to another scope resurrects removed entries).
 * New values default to Global (environments are per-machine, per R1).
 */
export async function updateSettingInOwningScope(key: string, value: unknown): Promise<void> {
  const config = vscode.workspace.getConfiguration("deeDebugger");
  const info = config.inspect(key);
  const target =
    info?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : info?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  await config.update(key, value, target);
}

export async function setActiveEnvironment(name: string | undefined): Promise<void> {
  await updateSettingInOwningScope("activeEnvironment", name || undefined);
}

function deesSettingList(value: string | string[] | undefined): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((v) => String(v).trim()).filter(Boolean);
}

/** Root of the first workspace folder (DEE folders, working copies and debug paths live under it). */
export function workspaceRoot(): string {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error("Open a workspace folder first.");
  return ws.uri.fsPath;
}

/**
 * Every folder holding DEE .cs files, primary first:
 * explicit setting (string or list) → every folder containing DeeDevBase.cs (one per Data
 * package) → every `DEEs` folder with a .csproj → "<ws>/.dees".
 */
export async function resolveDeesFolders(): Promise<string[]> {
  const root = workspaceRoot();
  const settings = readSettings().deesFolderSettings;
  if (settings.length > 0) return settings.map((s) => (path.isAbsolute(s) ? s : path.join(root, s)));
  const exclude = "**/{node_modules,bin,obj,.dee-debug}/**";
  const shims = await vscode.workspace.findFiles("**/DeeDevBase.cs", exclude, 50);
  const fromShims = [...new Set(shims.map((u) => path.dirname(u.fsPath)))].sort();
  if (fromShims.length > 0) return fromShims;
  const projects = await vscode.workspace.findFiles("**/DEEs/*.csproj", exclude, 50);
  const fromProjects = [...new Set(projects.map((u) => path.dirname(u.fsPath)))].sort();
  if (fromProjects.length > 0) return fromProjects;
  return [path.join(root, ".dees")];
}

/** The primary DEE folder — where new action files are created. */
export async function resolveDeesFolder(): Promise<string> {
  return (await resolveDeesFolders())[0]!;
}

const ACCESS_TOKEN_KEY = "deeDebugger.accessToken";
const PAT_KEY = "deeDebugger.personalAccessToken";

/**
 * Tokens are stored per environment profile: the base key for the flat "Default"
 * configuration (backward compatible), "<key>.<envName>" for named environments —
 * switching environments switches credentials with it.
 */
export class CredentialStore {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly activeEnv: () => string | undefined = () => readSettings().envName,
    private readonly log?: (message: string) => void,
  ) {}

  private key(base: string, env: string | undefined = this.activeEnv()): string {
    return env ? `${base}.${env}` : base;
  }

  async get(): Promise<MesCredentials> {
    const [accessToken, personalAccessToken] = await Promise.all([
      this.secrets.get(this.key(ACCESS_TOKEN_KEY)),
      this.secrets.get(this.key(PAT_KEY)),
    ]);
    return { accessToken: accessToken || undefined, personalAccessToken: personalAccessToken || undefined };
  }

  /** Delete stored tokens of a specific environment (used when removing a profile). */
  async clearFor(env: string | undefined): Promise<void> {
    await Promise.all([
      this.secrets.delete(this.key(ACCESS_TOKEN_KEY, env)),
      this.secrets.delete(this.key(PAT_KEY, env)),
    ]);
  }

  /** Move stored tokens between environment scopes (used when renaming a profile). */
  async migrate(fromEnv: string | undefined, toEnv: string | undefined): Promise<void> {
    for (const base of [ACCESS_TOKEN_KEY, PAT_KEY]) {
      const value = await this.secrets.get(this.key(base, fromEnv));
      if (value) {
        await this.secrets.store(this.key(base, toEnv), value);
        await this.secrets.delete(this.key(base, fromEnv));
      }
    }
  }

  /** Whether any token is stored for the given environment (undefined = Default). */
  async hasCredentials(env: string | undefined): Promise<boolean> {
    const [accessToken, personalAccessToken] = await Promise.all([
      this.secrets.get(this.key(ACCESS_TOKEN_KEY, env)),
      this.secrets.get(this.key(PAT_KEY, env)),
    ]);
    return Boolean(accessToken || personalAccessToken);
  }

  private envSuffix(): string {
    const env = this.activeEnv();
    return env ? ` — environment '${env}'` : " — Default environment";
  }

  async promptAccessToken(): Promise<boolean> {
    const value = await vscode.window.showInputBox({
      title: `MES Access Token (Bearer)${this.envSuffix()}`,
      prompt:
        "Paste the Authorization Bearer token (from the browser DevTools Network tab of a logged-in MES session, without the 'Bearer ' prefix). Security Portal access tokens expire after 1 hour.",
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return false;
    await this.storeToken(value.trim().replace(/^Bearer\s+/i, ""), "access");
    return true;
  }

  async promptPersonalAccessToken(): Promise<boolean> {
    const value = await vscode.window.showInputBox({
      title: `MES Personal Access Token${this.envSuffix()}`,
      prompt: "Paste the Personal Access Token generated in the Security Portal user page.",
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return false;
    await this.storeToken(value.trim(), "pat");
    return true;
  }

  /**
   * Store a token in the slot matching what it actually is: PATs declare
   * `"type": "PAT"` in their JWT payload and must be sent as Basic auth, so a PAT
   * pasted into the access-token prompt (or vice versa) is silently re-routed —
   * a stored access token would otherwise shadow the PAT and cause 401s.
   */
  private async storeToken(token: string, promptedAs: "access" | "pat"): Promise<void> {
    const info = decodeJwt(token);
    const isPat = info?.isPat ?? promptedAs === "pat";
    if (isPat) {
      await this.secrets.store(this.key(PAT_KEY), token);
      await this.secrets.delete(this.key(ACCESS_TOKEN_KEY));
    } else {
      await this.secrets.store(this.key(ACCESS_TOKEN_KEY), token);
    }
    const env = this.activeEnv();
    const kind = isPat ? "Personal Access Token (sent as Basic auth)" : "access token (sent as Bearer)";
    const rerouted = isPat !== (promptedAs === "pat") ? " — detected automatically from the token" : "";
    const expiry = info?.expiresAt ? ` Expires ${info.expiresAt.toLocaleString()}.` : "";
    const scope = env ? ` [environment: ${env}]` : "";
    // L4: metadata-only log line (type + env + expiry) — never the token itself.
    this.log?.(`[auth] token stored: ${kind}${scope}${expiry ? ` —${expiry}` : ""}`);
    void vscode.window.showInformationMessage(`Stored as ${kind}${rerouted}${scope}.${expiry}`);
  }

  async clear(): Promise<void> {
    await Promise.all([this.secrets.delete(this.key(ACCESS_TOKEN_KEY)), this.secrets.delete(this.key(PAT_KEY))]);
  }
}
