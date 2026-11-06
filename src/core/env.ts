/**
 * Environments are the ONLY connection configuration unit: each named profile is
 * self-contained (host address + how to reach the host container), fields it omits
 * fall back to built-in defaults, and `activeEnvironment` selects which one is in
 * use. There are no global host/docker settings; credentials are stored per
 * environment by the VS Code layer. No active (or no matching) environment means
 * "not connected".
 */

import { HostKind, HostTarget } from "./types";

export interface ConnectionSettings {
  hostAddress: string;
  hostTarget: HostTarget;
}

export interface EnvironmentProfile {
  name: string;
  hostAddress?: string;
  kind?: HostKind;
  containerName?: string;
  k8sTarget?: string;
  engineCommand?: string[];
  sourcePathInHost?: string;
  useMount?: boolean;
  vsdbgPath?: string;
}

/** Applied when a profile omits a field. */
/**
 * Deep link to an entity page in the MES UI (served next to the API behind Traefik on local
 * stacks): the UI's own navigation uses `/Entity/{EntityType}/{Id}` (cmf-core-business-controls
 * `entity-page.component.ts`). Undefined when the action has no Id yet.
 */
export function mesUiEntityUrl(hostAddress: string, entityType: string, id: string | number | undefined): string | undefined {
  if (id === undefined || id === null || String(id).length === 0 || !hostAddress.trim()) return undefined;
  return `${hostAddress.trim().replace(/\/+$/, "")}/Entity/${encodeURIComponent(entityType)}/${encodeURIComponent(String(id))}`;
}

export const DEFAULT_HOST_TARGET: HostTarget = {
  kind: "docker",
  containerName: "custom_host",
  k8sTarget: "",
  sourcePathInHost: "/tmp/CriticalManufacturing/dee-debug",
  useMount: false,
  vsdbgPath: "/vsdbg/vsdbg",
};

export const DEFAULT_HOST_ADDRESS = "http://localhost";

export interface ResolvedEnvironment {
  settings: ConnectionSettings;
  envName: string;
}

/**
 * Docker engine-command encodings for the connection-type wizard (R6: protocol
 * knowledge lives in core; the vscode layer only prompts).
 */
export type DockerEngineVariant =
  | { type: "dind"; devcontainer: string }
  | { type: "remote"; target: string }
  | { type: "wsl"; distro?: string }
  | { type: "custom"; command: string };

export function buildDockerEngineCommand(variant: DockerEngineVariant): string[] {
  switch (variant.type) {
    case "dind":
      return ["docker", "exec", "-i", variant.devcontainer.trim(), "docker"];
    case "remote": {
      const target = variant.target.trim();
      return /^(ssh|tcp|npipe|unix):\/\//.test(target)
        ? ["docker", "-H", target]
        : ["docker", "--context", target];
    }
    case "wsl":
      return variant.distro?.trim() ? ["wsl", "-d", variant.distro.trim(), "docker"] : ["wsl", "docker"];
    case "custom":
      return variant.command.trim().split(/\s+/);
  }
}

/** Recognize a docker-in-docker engine command; returns the devcontainer name. */
export function dindDevcontainerName(engineCommand?: string[]): string | undefined {
  return engineCommand?.length === 5 &&
    engineCommand[0] === "docker" &&
    engineCommand[1] === "exec" &&
    engineCommand[4] === "docker"
    ? engineCommand[3]
    : undefined;
}

/**
 * What to do after an environment is (re)activated — the single decision behind the
 * activation handler in the vscode layer. Pure so it can be unit-tested away from the
 * config-change listener and its debounce.
 *   not-connected    → no active environment; show the welcome view.
 *   needs-credentials → active but no stored credentials; prompt (Set Credentials chooser).
 *   ready            → active with credentials; load the tree.
 */
export type ActivationDecision = "not-connected" | "needs-credentials" | "ready";

export function decideActivation(
  envName: string | undefined,
  hasCredentials: boolean,
): ActivationDecision {
  if (!envName) return "not-connected";
  if (!hasCredentials) return "needs-credentials";
  return "ready";
}

/** Resolve the active environment; undefined = not connected. */
export function resolveEnvironment(
  profiles: EnvironmentProfile[],
  activeName: string | undefined,
): ResolvedEnvironment | undefined {
  const profile = activeName ? profiles.find((p) => p?.name === activeName) : undefined;
  if (!profile) return undefined;
  const target: HostTarget = { ...DEFAULT_HOST_TARGET };
  if (profile.kind !== undefined) target.kind = profile.kind;
  if (profile.containerName !== undefined) target.containerName = profile.containerName;
  if (profile.k8sTarget !== undefined) target.k8sTarget = profile.k8sTarget;
  if (profile.engineCommand !== undefined && profile.engineCommand.length > 0) {
    target.engineCommand = profile.engineCommand;
  }
  if (profile.sourcePathInHost !== undefined) target.sourcePathInHost = profile.sourcePathInHost;
  if (profile.useMount !== undefined) target.useMount = profile.useMount;
  if (profile.vsdbgPath !== undefined) target.vsdbgPath = profile.vsdbgPath;
  return {
    settings: { hostAddress: profile.hostAddress ?? DEFAULT_HOST_ADDRESS, hostTarget: target },
    envName: profile.name,
  };
}
