/**
 * Wire types for the MES DEE Management API (POST /api/DynamicExecutionEngine/{Method}).
 * Field names match the host's DataContracts. Unknown fields are preserved (index signature)
 * so entities can be echoed back on save without losing server-side data.
 */

/** Cmf.Foundation.Common.Base.UniversalState — may arrive as a number or its name. */
export enum UniversalState {
  Created = 0,
  Frozen = 1,
  Active = 2,
  Effective = 3,
  Terminated = 4,
}

export function isEffective(state: unknown): boolean {
  return state === UniversalState.Effective || state === "Effective";
}

/**
 * Entity ids exceed Number.MAX_SAFE_INTEGER (e.g. "2406270147150000006") and arrive as
 * JSON strings from the host — never parse them to numbers, always pass through verbatim.
 */
export type EntityId = string | number;

export interface DeeActionGroup {
  Id?: EntityId;
  Name: string;
  Description?: string;
  ActionGroupActions?: DeeActionGroupAction[];
  [key: string]: unknown;
}

export interface DeeActionGroupAction {
  Id?: EntityId;
  ActionGroup?: DeeActionGroup;
  Action?: DeeAction;
  EvaluateOrder?: number;
  [key: string]: unknown;
}

export interface DeeAction {
  Id?: EntityId;
  Name: string;
  Description?: string;
  Classification?: string;
  ActionCode?: string;
  ValidationCode?: string;
  IsEnabled?: boolean;
  /** Not persisted server-side: reflects the in-memory per-user debug cache. */
  IsInDebugMode?: boolean;
  IsSystemRule?: boolean;
  IsToHideHistory?: boolean;
  /** Not persisted: the file registered via ActivateDebugMode (host filesystem path). */
  SourceFilePath?: string;
  AssemblyName?: string;
  Version?: number;
  UniversalState?: UniversalState | string;
  ActionGroupActions?: DeeActionGroupAction[];
  CreatedBy?: string;
  CreatedOn?: string;
  ModifiedBy?: string;
  ModifiedOn?: string;
  [key: string]: unknown;
}

/** How the MES host process is reachable for file delivery and debugger attach. */
export type HostKind = "process" | "docker" | "kubernetes";

export interface HostTarget {
  kind: HostKind;
  /**
   * Command prefix used to reach the container engine that runs the host.
   * Default: ["docker"] (or ["kubectl"] for kind=kubernetes). For docker-in-docker
   * devcontainers, e.g. ["docker", "exec", "-i", "<devcontainer>", "docker"].
   */
  engineCommand?: string[];
  /** Docker container name (kind=docker). */
  containerName?: string;
  /** kubectl exec target, e.g. "deployment/host -n local" (kind=kubernetes). */
  k8sTarget?: string;
  /** Directory in the host's filesystem for debug source files (container kinds). */
  sourcePathInHost: string;
  /** sourcePathInHost is a bind mount of the local folder — skip copies. */
  useMount?: boolean;
  /** Path of vsdbg inside the container/pod. */
  vsdbgPath: string;
}
