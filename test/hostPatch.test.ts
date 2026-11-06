import { describe, expect, it } from "vitest";
import {
  adaptRuntimeConfig,
  DEFAULT_HOST_APP_DIR,
  describeUnpatchedHost,
  HOST_PATCH_CHECK_TTL_MS,
  hostPatchApplies,
  hostPatchPaths,
  interpretPatchCheckOutput,
  interpretPatcherOutput,
  isPdbCompileError,
  MIN_HOST_DOTNET_MAJOR,
  patcherCheckInvocation,
  patcherInvocation,
  PATCHER_FILES,
  patchStateIsFresh,
} from "../src/core/hostPatch";
import { restartHostArgs } from "../src/core/hostExec";
import type { HostTarget } from "../src/core/types";

const docker = (o: Partial<HostTarget> = {}): HostTarget => ({
  kind: "docker",
  containerName: "custom_host",
  k8sTarget: "",
  sourcePathInHost: "/tmp/CriticalManufacturing/dee-debug",
  useMount: false,
  vsdbgPath: "/vsdbg/vsdbg",
  ...o,
});
const DIND = ["docker", "exec", "-i", "devc", "docker"];

describe("hostPatchPaths", () => {
  it("derives target, backup, and work paths from the app dir", () => {
    const p = hostPatchPaths();
    expect(p.appDir).toBe(DEFAULT_HOST_APP_DIR);
    expect(p.targetDll).toBe("/opt/app/Cmf.Foundation.Common.dll");
    expect(p.backupDll).toBe("/opt/app/Cmf.Foundation.Common.dll.orig");
    expect(p.patchedOut).toMatch(/\.patched\.dll$/);
  });

  it("honors a custom app dir and trims a trailing slash", () => {
    expect(hostPatchPaths("/srv/mes/").targetDll).toBe("/srv/mes/Cmf.Foundation.Common.dll");
  });
});

describe("patcherInvocation", () => {
  it("runs the bundled patcher DLL against the target with --patch", () => {
    const p = hostPatchPaths();
    expect(patcherInvocation(p)).toEqual([
      "dotnet",
      `${p.patcherDir}/host-pdb-patcher.dll`,
      p.targetDll,
      "--patch",
      p.patchedOut,
    ]);
  });

  it("bundles exactly the runtime files, no native apphost or pdb", () => {
    expect(PATCHER_FILES).toContain("host-pdb-patcher.dll");
    expect(PATCHER_FILES).toContain("Mono.Cecil.dll");
    expect(PATCHER_FILES.some((f) => f.endsWith(".pdb"))).toBe(false);
    expect(PATCHER_FILES).not.toContain("host-pdb-patcher"); // no linux apphost
  });
});

describe("isPdbCompileError (#158143 signature)", () => {
  it("matches the native-PDB writer failure the host surfaces", () => {
    expect(isPdbCompileError("Unexpected error writing debug information -- 'Value cannot be null. (Parameter 'type')'.")).toBe(true);
    expect(isPdbCompileError("Value cannot be null. (Parameter 'type')")).toBe(true);
  });
  it("does not match ordinary compile errors or empty input", () => {
    expect(isPdbCompileError("[Action Code] CS0103: The name 'x' does not exist")).toBe(false);
    expect(isPdbCompileError(undefined)).toBe(false);
    expect(isPdbCompileError("")).toBe(false);
  });
});

describe("adaptRuntimeConfig", () => {
  const base = JSON.stringify({
    runtimeOptions: { tfm: "net6.0", framework: { name: "Microsoft.NETCore.App", version: "6.0.0" }, rollForward: "LatestMajor" },
  });
  it("retargets the runtimeconfig to the detected host major", () => {
    const cfg = JSON.parse(adaptRuntimeConfig(base, 10));
    expect(cfg.runtimeOptions.tfm).toBe("net10.0");
    expect(cfg.runtimeOptions.framework.version).toBe("10.0.0");
    expect(cfg.runtimeOptions.rollForward).toBe("LatestMajor"); // kept as belt-and-braces
  });
  it("targets .NET 6 for a MES 10 host", () => {
    expect(JSON.parse(adaptRuntimeConfig(base, 6)).runtimeOptions.framework.version).toBe("6.0.0");
  });
  it("MIN_HOST_DOTNET_MAJOR is 6 (MES 10 floor)", () => {
    expect(MIN_HOST_DOTNET_MAJOR).toBe(6);
  });
});

describe("interpretPatcherOutput", () => {
  it("reports already-patched regardless of exit code", () => {
    expect(interpretPatcherOutput("Compile: [42] already PortablePdb(2)\npatched=0", false)).toBe("already-patched");
  });
  it("reports patched on a successful flip", () => {
    expect(interpretPatcherOutput("  PATCHED [42] -> PortablePdb(2)\npatched=1\nwritten: out.dll", true)).toBe("patched");
  });
  it("reports failed when nothing was patched and exit was non-zero", () => {
    expect(interpretPatcherOutput("patched=0", false)).toBe("failed");
  });
});

describe("proactive patch-state probe (test-user report: attach fails with no prompt)", () => {
  it("patcherCheckInvocation runs the patcher read-only (no --patch, no output path)", () => {
    const p = hostPatchPaths();
    expect(patcherCheckInvocation(p)).toEqual(["dotnet", `${p.patcherDir}/host-pdb-patcher.dll`, p.targetDll]);
    expect(patcherCheckInvocation(p)).not.toContain("--patch");
  });

  it("interpretPatchCheckOutput classifies the patcher's report lines", () => {
    expect(interpretPatchCheckOutput("Compile: [42] debugInformationFormat = Pdb(1) <-- target\npatched=0")).toBe("unpatched");
    expect(interpretPatchCheckOutput("Compile: [42] already PortablePdb(2)\npatched=0")).toBe("patched");
    expect(interpretPatchCheckOutput("dotnet: command not found")).toBe("unknown");
    expect(interpretPatchCheckOutput(undefined)).toBe("unknown");
  });

  it("applies to containerized hosts only (the bug is Linux-only)", () => {
    expect(hostPatchApplies({ kind: "docker" })).toBe(true);
    expect(hostPatchApplies({ kind: "kubernetes" })).toBe(true);
    expect(hostPatchApplies({ kind: "process" })).toBe(false);
  });

  it("caches a probe for the TTL and not beyond (a stack recreate reverts the patch)", () => {
    expect(patchStateIsFresh(1_000, 1_000 + HOST_PATCH_CHECK_TTL_MS - 1)).toBe(true);
    expect(patchStateIsFresh(1_000, 1_000 + HOST_PATCH_CHECK_TTL_MS)).toBe(false);
    expect(patchStateIsFresh(5_000, 1_000)).toBe(false); // clock went backwards → re-probe
  });

  it("describeUnpatchedHost names the environment, the bug, and the consequence per entry point", () => {
    const debug = describeUnpatchedHost("local", "debug");
    expect(debug).toContain("'local'");
    expect(debug).toContain("#158143");
    expect(debug).toMatch(/breakpoints will never bind/);
    expect(describeUnpatchedHost(undefined, "attach")).toMatch(/this environment.*custom-business DLL breakpoints are unaffected/s);
  });
});

describe("restartHostArgs", () => {
  it("restarts a plain docker container via the engine", () => {
    expect(restartHostArgs(docker())).toEqual(["docker", "restart", "custom_host"]);
  });
  it("nests through a docker-in-docker engine prefix", () => {
    expect(restartHostArgs(docker({ engineCommand: DIND }))).toEqual([
      "docker", "exec", "-i", "devc", "docker", "restart", "custom_host",
    ]);
  });
  it("returns null for kubernetes and process (no container auto-restart)", () => {
    expect(restartHostArgs(docker({ kind: "kubernetes", k8sTarget: "deployment/host -n mes" }))).toBeNull();
    expect(restartHostArgs(docker({ kind: "process" }))).toBeNull();
  });
});
