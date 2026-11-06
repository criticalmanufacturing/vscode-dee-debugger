import { describe, expect, it } from "vitest";
import {
  buildAttachConfig,
  capabilityProbeArgs,
  hasPtraceCapability,
  decideAttachPrivilege,
  parsePtraceProbe,
  ptraceProbeArgs,
  downloaderProbeArgs,
  engineCommand,
  execInHostArgs,
  extractVsdbgTarArgs,
  findHostPidArgs,
  readFileArgs,
  runtimeIdFromArch,
  vsdbgInstallArgs,
  vsdbgProbeArgs,
  writeFileArgs,
} from "../src/core/hostExec";
import { HostTarget } from "../src/core/types";

const docker = (overrides: Partial<HostTarget> = {}): HostTarget => ({
  kind: "docker",
  containerName: "custom_host",
  sourcePathInHost: "/tmp/CriticalManufacturing/dee-debug",
  vsdbgPath: "/vsdbg/vsdbg",
  ...overrides,
});

const DIND_PREFIX = ["docker", "exec", "-i", "devcontainer", "docker"];

describe("engineCommand", () => {
  it("defaults per kind and honors overrides", () => {
    expect(engineCommand(docker())).toEqual(["docker"]);
    expect(engineCommand(docker({ kind: "kubernetes" }))).toEqual(["kubectl"]);
    expect(engineCommand(docker({ engineCommand: DIND_PREFIX }))).toEqual(DIND_PREFIX);
    expect(engineCommand(docker({ engineCommand: [] }))).toEqual(["docker"]);
  });
});

describe("execInHostArgs", () => {
  it("builds plain docker exec argv", () => {
    expect(execInHostArgs(docker(), ["cat", "/x"])).toEqual(["docker", "exec", "custom_host", "cat", "/x"]);
  });

  it("nests through a docker-in-docker prefix", () => {
    expect(execInHostArgs(docker({ engineCommand: DIND_PREFIX }), ["ls"], true)).toEqual([
      ...DIND_PREFIX,
      "exec",
      "-i",
      "custom_host",
      "ls",
    ]);
  });

  it("builds kubectl argv with the -- separator", () => {
    const target = docker({ kind: "kubernetes", k8sTarget: "deployment/host -n local" });
    expect(execInHostArgs(target, ["cat", "/x"])).toEqual([
      "kubectl", "exec", "deployment/host", "-n", "local", "--", "cat", "/x",
    ]);
  });

  it("rejects kubernetes without a target", () => {
    expect(() => execInHostArgs(docker({ kind: "kubernetes" }), ["ls"])).toThrow(/k8sTarget/);
  });
});

describe("file streaming argv", () => {
  it("writes via stdin with mkdir -p and quoted paths", () => {
    const args = writeFileArgs(docker(), "/tmp/a dir", "/tmp/a dir/My Action.cs");
    expect(args.slice(0, 4)).toEqual(["docker", "exec", "-i", "custom_host"]);
    expect(args[args.length - 1]).toBe("mkdir -p '/tmp/a dir' && cat > '/tmp/a dir/My Action.cs'");
  });

  it("reads via cat", () => {
    expect(readFileArgs(docker(), "/tmp/x.cs")).toEqual(["docker", "exec", "custom_host", "cat", "/tmp/x.cs"]);
  });
});

describe("vsdbg argv", () => {
  it("probes with test -x via sh -c, exiting 0 with present/missing whenever the exec ran (SUP-2)", () => {
    expect(vsdbgProbeArgs(docker())).toEqual([
      "docker",
      "exec",
      "custom_host",
      "sh",
      "-c",
      "test -x '/vsdbg/vsdbg' && echo present || echo missing",
    ]);
  });

  it("builds curl and wget install variants targeting the vsdbg directory", () => {
    const curl = vsdbgInstallArgs(docker(), "curl");
    expect(curl[curl.length - 1]).toContain("curl -sSL");
    expect(curl[curl.length - 1]).toContain("-l '/vsdbg'");
    const wget = vsdbgInstallArgs(docker(), "wget");
    expect(wget[wget.length - 1]).toContain("wget -qO-");
  });

  it("probes for an in-container downloader", () => {
    const args = downloaderProbeArgs(docker());
    expect(args[args.length - 1]).toBe("command -v curl || command -v wget");
  });

  it("extracts a streamed tarball into the vsdbg dir with stdin enabled", () => {
    const args = extractVsdbgTarArgs(docker());
    expect(args.slice(0, 4)).toEqual(["docker", "exec", "-i", "custom_host"]);
    expect(args[args.length - 1]).toBe("mkdir -p '/vsdbg' && tar -xzf - -C '/vsdbg'");
  });

  it("maps uname arch to runtime ids", () => {
    expect(runtimeIdFromArch("x86_64\n")).toBe("linux-x64");
    expect(runtimeIdFromArch("aarch64")).toBe("linux-arm64");
    expect(runtimeIdFromArch("armv7l")).toBe("linux-arm");
  });
});

describe("findHostPidArgs", () => {
  it("scans /proc for dotnet processes carrying the host marker, excluding the wrapper", () => {
    const args = findHostPidArgs(docker());
    expect(args.slice(0, 3)).toEqual(["docker", "exec", "custom_host"]);
    const script = args[args.length - 1]!;
    expect(script).toContain("dotnet\\ *Cmf.Foundation.Services.HostService.dll*");
    expect(script).toContain("/proc/[0-9]*");
  });
});

describe("buildAttachConfig", () => {
  const deeMap = { "/tmp/CriticalManufacturing/dee-debug": "/dees" };

  it("uses a resolved processId verbatim instead of the picker", () => {
    const config = buildAttachConfig(docker(), deeMap, 19) as any;
    expect(config.processId).toBe(19);
    expect(buildAttachConfig(docker({ kind: "process" }), deeMap, 42)["processId"]).toBe(42);
  });

  it("uses pickProcess for process kind", () => {
    const config = buildAttachConfig(docker({ kind: "process" }), deeMap);
    expect(config["processId"]).toBe("${command:pickProcess}");
    expect(config["pipeTransport"]).toBeUndefined();
    expect(config["justMyCode"]).toBe(false);
  });

  it("builds a docker pipe transport with sourceFileMap", () => {
    const config = buildAttachConfig(docker(), { "/tmp/CriticalManufacturing/dee-debug": "/path/to/proj/.dees" }) as any;
    expect(config.pipeTransport).toMatchObject({
      pipeProgram: "docker",
      pipeArgs: ["exec", "--privileged", "-u", "0", "-i", "custom_host"],
      debuggerPath: "/vsdbg/vsdbg",
      quoteArgs: false,
    });
    expect(config.sourceFileMap).toEqual({
      "/tmp/CriticalManufacturing/dee-debug": "/path/to/proj/.dees",
    });
  });

  it("carries a caller-supplied source map and name (ADR 0008 business attach)", () => {
    const config = buildAttachConfig(
      docker(),
      { "/src": "${workspaceFolder}" },
      77,
      true,
      "Attach to MES Host (Business)",
    ) as any;
    expect(config.name).toBe("Attach to MES Host (Business)");
    expect(config.sourceFileMap).toEqual({ "/src": "${workspaceFolder}" });
    expect(config.processId).toBe(77);
  });

  it("omits sourceFileMap entirely when the map is empty", () => {
    const dockerCfg = buildAttachConfig(docker(), {}) as any;
    expect(dockerCfg.sourceFileMap).toBeUndefined();
    const procCfg = buildAttachConfig(docker({ kind: "process" }), {}) as any;
    expect(procCfg.sourceFileMap).toBeUndefined();
  });

  it("nests the pipe transport through a docker-in-docker prefix", () => {
    const config = buildAttachConfig(docker({ engineCommand: DIND_PREFIX }), deeMap) as any;
    expect(config.pipeTransport.pipeProgram).toBe("docker");
    expect(config.pipeTransport.pipeArgs).toEqual([
      "exec", "-i", "devcontainer", "docker", "exec", "--privileged", "-u", "0", "-i", "custom_host",
    ]);
  });

  it("only privileges the innermost exec, never the engine prefix", () => {
    const args = execInHostArgs(docker({ engineCommand: DIND_PREFIX }), ["ls"], false, true);
    expect(args).toEqual([...DIND_PREFIX, "exec", "--privileged", "-u", "0", "custom_host", "ls"]);
  });
});

describe("capability probe (R7 unprivileged-first)", () => {
  it("parses CapEff and detects CAP_SYS_PTRACE", () => {
    expect(hasPtraceCapability("CapEff:\t000001ffffffffff")).toBe(true); // full caps
    expect(hasPtraceCapability("CapEff:\t00000000a80425fb")).toBe(false); // docker default set
    expect(hasPtraceCapability("CapEff:\t0000000000080000")).toBe(true); // exactly bit 19
    expect(hasPtraceCapability("garbage")).toBe(false);
  });

  it("builds an unprivileged probe and honors the privileged flag in attach configs", () => {
    expect(capabilityProbeArgs(docker())).toEqual(["docker", "exec", "custom_host", "grep", "CapEff", "/proc/self/status"]);
    const config = buildAttachConfig(docker(), { "/x": "/dees" }, 19, false) as any;
    expect(config.pipeTransport.pipeArgs).toEqual(["exec", "-i", "custom_host"]);
    const priv = buildAttachConfig(docker(), { "/x": "/dees" }, 19, true) as any;
    // -u 0 is load-bearing: a non-root exec user gets an EMPTY effective set even with --privileged.
    expect(priv.pipeTransport.pipeArgs).toEqual(["exec", "--privileged", "-u", "0", "-i", "custom_host"]);
  });

  it("ptrace probe reads caps, uid and Yama scope in one exec, for docker and kubernetes", () => {
    const argv = ptraceProbeArgs(docker());
    expect(argv.slice(0, 3)).toEqual(["docker", "exec", "custom_host"]);
    expect(argv.join(" ")).toMatch(/CapEff.*id -u.*ptrace_scope/);
    expect(ptraceProbeArgs(docker({ kind: "kubernetes", k8sTarget: "deployment/host -n mes" })).slice(0, 6)).toEqual([
      "kubectl", "exec", "deployment/host", "-n", "mes", "--",
    ]);
    expect(parsePtraceProbe("CapEff:\t00000000a80425fb\nuid=0\nyama=1\n")).toEqual({ hasCap: false, uid: 0, yamaScope: 1 });
    expect(parsePtraceProbe("CapEff:\t000001ffffffffff\nuid=1001\nyama=-\n")).toEqual({ hasCap: true, uid: 1001, yamaScope: undefined });
  });

  it("decideAttachPrivilege: docker escalates unless the cap is already there; probe failure → safe default", () => {
    expect(decideAttachPrivilege("docker", { hasCap: true, uid: 0, yamaScope: 1 })).toEqual({ privileged: false, blocking: false });
    expect(decideAttachPrivilege("docker", { hasCap: false, uid: 1001, yamaScope: 1 })).toEqual({ privileged: true, blocking: false });
    expect(decideAttachPrivilege("docker", undefined)).toEqual({ privileged: true, blocking: false });
    expect(decideAttachPrivilege("process", undefined)).toEqual({ privileged: false, blocking: false });
  });

  it("decideAttachPrivilege: kubernetes cannot escalate — a missing cap becomes the pod-spec fix, non-root adds the runAsUser note", () => {
    expect(decideAttachPrivilege("kubernetes", { hasCap: true, uid: 1001, yamaScope: 1 })).toEqual({ privileged: false, blocking: false });
    const nonRoot = decideAttachPrivilege("kubernetes", { hasCap: false, uid: 1001, yamaScope: 1 });
    expect(nonRoot.blocking).toBe(false);
    expect(nonRoot.warning).toMatch(/SYS_PTRACE/);
    expect(nonRoot.warning).toMatch(/runAsUser: 0/);
    expect(decideAttachPrivilege("kubernetes", { hasCap: false, uid: 0, yamaScope: 1 }).warning).not.toMatch(/runAsUser/);
    expect(decideAttachPrivilege("kubernetes", undefined)).toEqual({ privileged: false, blocking: false });
  });

  it("decideAttachPrivilege: Yama scope 3 blocks attach everywhere", () => {
    for (const kind of ["docker", "kubernetes"] as const) {
      const d = decideAttachPrivilege(kind, { hasCap: true, uid: 0, yamaScope: 3 });
      expect(d.blocking).toBe(true);
      expect(d.warning).toMatch(/ptrace_scope is 3/);
    }
  });

  it("rejects shell metacharacters in the host process marker", () => {
    expect(() => findHostPidArgs(docker(), "evil;rm -rf")).toThrow(/Invalid host process marker/);
  });
});
