/**
 * Pure logic for environment auto-discovery: classifying `docker ps` output and
 * assembling candidate environment profiles. The actual probing (docker/pgrep/HTTP)
 * lives in the VS Code layer.
 */

import { EnvironmentProfile } from "./env";

export interface DockerPsEntry {
  name: string;
  image: string;
}

/** Parse `docker ps --format '{{.Names}}\t{{.Image}}'` output. */
export function parseDockerPs(output: string): DockerPsEntry[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", image = ""] = line.split("\t");
      return { name: name.trim(), image: image.trim() };
    })
    .filter((entry) => entry.name.length > 0);
}

const HOST_NAME_PATTERN = /^(custom_)?host$/;
const HOST_IMAGE_PATTERN = /criticalmanufacturing[^\t]*\/(core-)?host(:|$)/;

/** MES host container: canonical names (host / custom_host) or the product host image. */
export function isMesHostContainer(entry: DockerPsEntry): boolean {
  return HOST_NAME_PATTERN.test(entry.name) || HOST_IMAGE_PATTERN.test(entry.image);
}

/** VS Code devcontainers get images named vsc-<project>-<hash>; candidates for docker-in-docker. */
export function isDevcontainer(entry: DockerPsEntry): boolean {
  return /^vsc-/.test(entry.image);
}

export type DiscoverySource = "docker" | "docker-in-docker" | "process";

export interface DiscoveredEnvironment extends EnvironmentProfile {
  source: DiscoverySource;
  /** An /api/ping probe answered (any HTTP status < 500). */
  reachable: boolean;
}

/** Deduplicate a proposed profile name against already-taken names. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  let i = 2;
  while (set.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/**
 * Two discovered/configured profiles point at the same environment when the address
 * and container line up — used to avoid offering duplicates of existing profiles.
 */
export function sameEnvironment(a: EnvironmentProfile, b: EnvironmentProfile): boolean {
  return (
    (a.hostAddress ?? "") === (b.hostAddress ?? "") &&
    (a.containerName ?? "") === (b.containerName ?? "") &&
    JSON.stringify(a.engineCommand ?? []) === JSON.stringify(b.engineCommand ?? [])
  );
}
