import * as fs from "node:fs/promises";
import { runCli } from "./fileBridge";
import {
  DiscoveredEnvironment,
  DockerPsEntry,
  isDevcontainer,
  isMesHostContainer,
  parseDockerPs,
} from "../core/discovery";

const PROBE_TIMEOUT_MS = 5_000;
const PING_TIMEOUT_MS = 3_000;
const PS_FORMAT = "{{.Names}}\t{{.Image}}";

/** Reachable = the MES API route answered at all (401 without a token is a success here). */
async function ping(address: string): Promise<boolean> {
  try {
    const response = await fetch(`${address.replace(/\/+$/, "")}/api/ping`, {
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * Probe this machine for MES environments:
 * 1. host containers on the outer docker daemon (API expected via localhost);
 * 2. devcontainers (vsc-* images) running an inner docker daemon with a host
 *    container — the cmf-cli docker-in-docker topology (API via the devcontainer IP);
 * 3. a local Cmf.Foundation.Services.HostService process.
 * All probes are read-only and individually best-effort.
 */
export async function discoverEnvironments(log: (message: string) => void): Promise<DiscoveredEnvironment[]> {
  const found: DiscoveredEnvironment[] = [];

  let containers: DockerPsEntry[] = [];
  try {
    const { stdout } = await runCli(["docker", "ps", "--format", PS_FORMAT], undefined, PROBE_TIMEOUT_MS);
    containers = parseDockerPs(stdout);
    log(`docker: ${containers.length} running container(s)`);
  } catch (error) {
    log(`docker not available: ${error instanceof Error ? error.message : error}`);
  }

  for (const host of containers.filter(isMesHostContainer)) {
    let hostAddress = "http://localhost";
    let reachable = false;
    for (const candidate of ["http://localhost", "http://localhost:8084"]) {
      if (await ping(candidate)) {
        hostAddress = candidate;
        reachable = true;
        break;
      }
    }
    found.push({
      name: `docker-${host.name}`,
      kind: "docker",
      containerName: host.name,
      hostAddress,
      source: "docker",
      reachable,
    });
    log(`docker host container '${host.name}' → ${hostAddress} (${reachable ? "reachable" : "no ping"})`);
  }

  for (const devcontainer of containers.filter(isDevcontainer)) {
    try {
      const { stdout } = await runCli(
        ["docker", "exec", devcontainer.name, "docker", "ps", "--format", PS_FORMAT],
        undefined,
        PROBE_TIMEOUT_MS,
      );
      const innerHost = parseDockerPs(stdout).find(isMesHostContainer);
      if (!innerHost) continue;
      const inspect = await runCli(
        ["docker", "inspect", devcontainer.name, "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}"],
        undefined,
        PROBE_TIMEOUT_MS,
      );
      const ip = inspect.stdout.trim().split(/\s+/)[0] ?? "";
      const hostAddress = ip ? `http://${ip}` : "http://localhost";
      found.push({
        name: `dind-${devcontainer.name}`,
        kind: "docker",
        containerName: innerHost.name,
        engineCommand: ["docker", "exec", "-i", devcontainer.name, "docker"],
        hostAddress,
        source: "docker-in-docker",
        reachable: ip ? await ping(hostAddress) : false,
      });
      log(`devcontainer '${devcontainer.name}' runs inner host '${innerHost.name}' → ${hostAddress}`);
    } catch {
      // no inner docker daemon — not a DinD devcontainer
    }
  }

  try {
    if (await hasLocalHostProcess(log)) {
      let hostAddress = "http://localhost:8084";
      let reachable = false;
      for (const candidate of ["http://localhost:8084", "http://localhost"]) {
        if (await ping(candidate)) {
          hostAddress = candidate;
          reachable = true;
          break;
        }
      }
      found.push({ name: "local-process", kind: "process", hostAddress, source: "process", reachable });
      log(`local host process found → ${hostAddress} (${reachable ? "reachable" : "no ping"})`);
    }
  } catch {
    // pgrep missing or no match — nothing local
  }

  return found;
}

/**
 * True only for a genuinely local host process. On WSL2/Linux, containers share the
 * kernel, so pgrep also sees containerized processes — require the same PID namespace
 * as ours (falling back to trusting pgrep where /proc is unavailable, e.g. macOS,
 * where container processes live in a VM and are invisible anyway).
 */
async function hasLocalHostProcess(log: (message: string) => void): Promise<boolean> {
  const { stdout } = await runCli(["pgrep", "-af", "Cmf.Foundation.Services.HostService"], undefined, PROBE_TIMEOUT_MS);
  const candidates = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ");
      return { pid: line.slice(0, space), cmd: line.slice(space + 1) };
    })
    .filter((c) => /(^|[/\s])dotnet\s/.test(c.cmd) && c.cmd.includes("Cmf.Foundation.Services.HostService.dll"));
  if (candidates.length === 0) return false;
  const selfNs = await fs.readlink("/proc/self/ns/pid").catch(() => undefined);
  if (!selfNs) return true;
  for (const candidate of candidates) {
    const ns = await fs.readlink(`/proc/${candidate.pid}/ns/pid`).catch(() => undefined);
    if (ns === selfNs) return true;
  }
  log("host process matches exist but all live in container PID namespaces — ignoring");
  return false;
}
