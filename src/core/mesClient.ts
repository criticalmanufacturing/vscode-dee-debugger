/**
 * Typed client for the MES DEE Management REST API.
 *
 * Contract (verified against DynamicExecutionEngineController + the old VS add-in):
 *   POST {hostAddress}/api/DynamicExecutionEngine/{Method}
 *   Authorization: Bearer <accessToken>   |   Basic base64(<PAT> + ":" + <PAT>)  (see basicAuthorization)
 *   cmf_currentculture: <culture>, cmf_returnfaultexceptions: false
 * Requests are plain JSON (no $type needed); responses may carry Json.NET
 * $id/$ref metadata and are resolved before returning.
 */

import { resolveJsonRefs } from "./jsonRefs";
import { DeeAction, DeeActionGroup, EntityId } from "./types";

export interface MesCredentials {
  accessToken?: string;
  personalAccessToken?: string;
}

export interface MesClientOptions {
  hostAddress: string;
  credentials: () => Promise<MesCredentials>;
  culture?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Diagnostic sink; must never receive secrets. */
  log?: (message: string) => void;
}

/**
 * Authorization header for a Personal Access Token.
 *
 * PAT auth is implemented by the Traefik forward-auth service (`cmf.auth.service`), not by
 * the host: it base64-decodes the Basic credential, splits on ":" and exchanges the part
 * AFTER the colon (`userPass.Split(":")[1]`, identical from MES 11.0 to 12.0) for an
 * access token. The old VS add-in's `PAT + ":"` therefore sends an EMPTY token and gets the
 * login redirect — observed live on MES 12.0.0-beta.2 (2026-10-18): `PAT:` → 302,
 * `:PAT` → 200. The token is placed on BOTH sides of the colon so a parser reading either
 * field is satisfied; the host itself has no Basic handler, so nothing else sees it.
 */
export function basicAuthorization(personalAccessToken: string): string {
  const token = personalAccessToken.trim();
  return `Basic ${Buffer.from(`${token}:${token}`).toString("base64")}`;
}

export class MesApiError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status?: number,
    public readonly details?: string,
  ) {
    super(message);
    this.name = "MesApiError";
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /**
   * MES optimistic concurrency: saving an entity whose concurrency token is stale
   * (changed by another user — or by our own previous save when the object wasn't
   * re-fetched) fails with 409 DataChangedByOtherUserCmfException.
   */
  get isConcurrencyConflict(): boolean {
    return this.status === 409;
  }
}

export class MesClient {
  constructor(private readonly options: MesClientOptions) {}

  private endpoint(method: string): string {
    const base = this.options.hostAddress.replace(/\/+$/, "");
    return `${base}/api/DynamicExecutionEngine/${method}`;
  }

  private async invoke<T>(method: string, body: unknown): Promise<T> {
    if (!this.options.hostAddress.trim()) {
      throw new MesApiError(
        "No MES environment selected — use 'Switch Environment…' or 'Discover Environments…' first.",
        "(no host)",
      );
    }
    const url = this.endpoint(method);
    const credentials = await this.options.credentials();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      cmf_currentculture: this.options.culture ?? "en-US",
      cmf_returnfaultexceptions: "false",
    };
    if (credentials.accessToken) {
      headers["Authorization"] = `Bearer ${credentials.accessToken}`;
    } else if (credentials.personalAccessToken) {
      headers["Authorization"] = basicAuthorization(credentials.personalAccessToken);
    } else {
      throw new MesApiError(
        "No credentials configured. Run 'DEE Debugger: Set Credentials…'.",
        url,
      );
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const started = Date.now();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.options.log?.(`POST ${url} → network error after ${Date.now() - started} ms (${reason})`);
      throw new MesApiError(`Could not reach the MES host at ${url}: ${reason}`, url);
    }
    // L8: one outcome line per call — status + duration are the first things support asks for.
    this.options.log?.(`POST ${url} → ${response.status} in ${Date.now() - started} ms`);

    const text = await response.text();
    if (!response.ok) {
      throw new MesApiError(
        `MES call ${method} failed with HTTP ${response.status} ${response.statusText}.`,
        url,
        response.status,
        text,
      );
    }
    try {
      return resolveJsonRefs(JSON.parse(text.replace(/^﻿/, "")) as T);
    } catch {
      // A 200 that isn't JSON is almost always an auth redirect serving a login page —
      // seen live when a PAT is revoked: the forward-auth layer 200s the Security
      // Portal HTML instead of a 401. Say that, not "unparseable JSON".
      const looksLikeLoginPage = /<html[\s>]/i.test(text) || /<!doctype html/i.test(text);
      throw new MesApiError(
        looksLikeLoginPage
          ? `MES call ${method} returned a login page instead of data — the token was rejected (revoked or expired). Run 'DEE Debugger: Set Credentials…'.`
          : `MES call ${method} returned unparseable JSON.`,
        url,
        response.status,
        text,
      );
    }
  }

  async testConnection(): Promise<void> {
    await this.invoke<{ ActionGroups?: DeeActionGroup[] }>("GetAllActionGroups", {});
  }

  async getAllActionGroups(): Promise<DeeActionGroup[]> {
    const out = await this.invoke<{ ActionGroups?: DeeActionGroup[] }>("GetAllActionGroups", {});
    return out.ActionGroups ?? [];
  }

  async getAllActions(): Promise<DeeAction[]> {
    const out = await this.invoke<{ Actions?: DeeAction[] }>("GetAllActions", {});
    return out.Actions ?? [];
  }

  async getActionById(id: EntityId): Promise<DeeAction> {
    const out = await this.invoke<{ Action: DeeAction }>("GetActionById", { Id: id });
    return out.Action;
  }

  async getActionByName(name: string): Promise<DeeAction> {
    const out = await this.invoke<{ Action: DeeAction }>("GetActionByName", { Name: name });
    return out.Action;
  }

  /** Returns the complete server-generated .cs source for the action. */
  async getActionFullCode(action: DeeAction): Promise<string> {
    const out = await this.invoke<{ FullCode: string }>("GetActionFullCode", { Action: action });
    return out.FullCode;
  }

  /**
   * Register per-user debug mode. sourceFilePath must be readable by the HOST process
   * (a container path for containerized hosts). Registration is in-memory and lost on
   * host restart.
   */
  async activateDebugMode(action: DeeAction, sourceFilePath: string): Promise<DeeAction> {
    const out = await this.invoke<{ Action: DeeAction }>("ActivateDebugMode", {
      Action: action,
      SourceFilePath: sourceFilePath,
    });
    return out.Action;
  }

  async deactivateDebugMode(action: DeeAction): Promise<DeeAction> {
    const out = await this.invoke<{ Action: DeeAction }>("DeactivateDebugMode", { Action: action });
    return out.Action;
  }

  /** Persist ActionCode/ValidationCode (compiles server-side; overwrites current version). */
  async compileAndSave(action: DeeAction): Promise<DeeAction> {
    const out = await this.invoke<{ Action: DeeAction }>("CompileAndSave", { Action: action });
    return out.Action;
  }

  /**
   * Create a new action (what the MES UI "Create DEE Action" wizard calls). The host stores
   * it as version 1 in state Active — NOT effective — and does not compile it; send
   * IsEnabled explicitly (a missing flag deserializes to false). Returns the stored entity
   * (with Id), which is fresh enough to pass straight to makeActionVersionEffective.
   */
  async createAction(action: DeeAction): Promise<DeeAction> {
    const out = await this.invoke<{ Action: DeeAction }>("CreateAction", { Action: action });
    return out.Action;
  }

  /**
   * Promote an Active version to Effective (the version the MES executes). Validates the
   * concurrency token, so pass a freshly fetched or just-returned entity. The host rejects
   * versions that are not Active.
   */
  async makeActionVersionEffective(action: DeeAction): Promise<DeeAction> {
    const out = await this.invoke<{ Action: DeeAction }>("MakeActionVersionEffective", { Action: action });
    return out.Action;
  }

  async compileAndSaveWithNewVersion(
    action: DeeAction,
    makeEffective: boolean,
  ): Promise<DeeAction> {
    const out = await this.invoke<{ Action: DeeAction }>("CompileAndSaveWithNewVersion", {
      Action: action,
      IsNewVersion: true,
      IsToMakeNewVersionEffective: makeEffective,
    });
    return out.Action;
  }

  async executeAction(action: DeeAction, input: Record<string, unknown>): Promise<ExecuteOutput> {
    return this.invoke<ExecuteOutput>("ExecuteAction", { Action: action, Input: input });
  }

  /** Read-only execution — the host discards persistence side effects. */
  async executeReadOnlyAction(action: DeeAction, input: Record<string, unknown>): Promise<ExecuteOutput> {
    return this.invoke<ExecuteOutput>("ExecuteReadOnlyAction", {
      ActionId: action.Id,
      ActionName: action.Name,
      Input: input,
    });
  }

  /**
   * All versions of an action as flat rows (server returns a DataSet: Actions.Table1).
   * Requires a FRESH action object — a stale concurrency token fails with 409.
   */
  async getActionVersions(action: DeeAction): Promise<ActionVersionRow[]> {
    const out = await this.invoke<{ Actions?: { Table1?: ActionVersionRow[] } }>(
      "GetActionVersionsAsDataSet",
      { Action: action },
    );
    return out.Actions?.Table1 ?? [];
  }
}

export interface ExecuteOutput {
  /** CMFMap-encoded dictionary — decode with decodeCmfValues before display. */
  Output?: unknown;
  Action?: DeeAction;
}

/** Row shape verified live against MES 11.2.5. */
export interface ActionVersionRow {
  ActionId?: string | number;
  Id: string | number;
  Name: string;
  Version: number;
  UniversalState: number | string;
  IsEnabled?: boolean;
  Description?: string;
  CreatedBy?: string;
  CreatedOn?: string;
  ModifiedBy?: string;
  ModifiedOn?: string;
  [key: string]: unknown;
}
