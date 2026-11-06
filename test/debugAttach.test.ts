import { beforeEach, describe, expect, it, vi } from "vitest";
import { __queueInfoResponse, __reset, messages } from "./mocks/vscode";

const { runCliMock } = vi.hoisted(() => ({ runCliMock: vi.fn() }));
vi.mock("../src/vscode/fileBridge", () => ({ runCli: runCliMock }));

import { attachDebugger, hasVsdbg, installVsdbg } from "../src/vscode/debugAttach";
import { HostTarget } from "../src/core/types";

const target: HostTarget = {
  kind: "docker",
  containerName: "custom_host",
  sourcePathInHost: "/tmp/dee-debug",
  vsdbgPath: "/vsdbg/vsdbg",
};

beforeEach(() => {
  __reset();
  runCliMock.mockReset();
});

describe("hasVsdbg (SUP-2 — engine failure must not read as 'vsdbg missing')", () => {
  it("returns 'present' when the probe prints present", async () => {
    runCliMock.mockResolvedValue({ stdout: "present\n", stderr: "" });
    await expect(hasVsdbg(target)).resolves.toBe("present");
  });

  it("returns 'missing' when the probe ran but vsdbg is absent, and logs why", async () => {
    runCliMock.mockResolvedValue({ stdout: "missing\n", stderr: "" });
    const lines: string[] = [];
    await expect(hasVsdbg(target, (m) => lines.push(m))).resolves.toBe("missing");
    expect(lines.some((l) => l.includes("/vsdbg/vsdbg"))).toBe(true);
  });

  it("propagates engine failures instead of swallowing them into false", async () => {
    runCliMock.mockRejectedValue(new Error("docker exec custom_host … exited with 1: Error: No such container: custom_host"));
    await expect(hasVsdbg(target)).rejects.toThrow(/No such container/);
  });
});

describe("attachDebugger", () => {
  it("surfaces an unreachable engine and never offers the vsdbg install (SUP-2)", async () => {
    runCliMock.mockRejectedValue(new Error("spawn docker ENOENT"));
    const lines: string[] = [];
    await expect(attachDebugger(target, { "/x": "/dees" }, (m) => lines.push(m))).rejects.toThrow(
      /Could not reach the MES host container.*spawn docker ENOENT/,
    );
    expect(messages.some((m) => m.includes("vsdbg was not found"))).toBe(false);
    expect(lines.some((l) => l.includes("engine command failed"))).toBe(true);
  });

  it("offers the install only when the probe actually ran and reported missing", async () => {
    runCliMock.mockResolvedValue({ stdout: "missing\n", stderr: "" });
    // No queued response → user dismisses the install prompt → attach aborts cleanly.
    await expect(attachDebugger(target, { "/x": "/dees" })).resolves.toBe(false);
    expect(messages.some((m) => m.includes("vsdbg was not found"))).toBe(true);
  });
});

/** Parse the sanitized attach config the module logs (L7) — the only place the argv is visible. */
function loggedConfig(lines: string[]): { pipeTransport?: { pipeArgs: string[] } } {
  const line = lines.find((l) => l.includes("[attach] pid="))!;
  return JSON.parse(line.slice(line.indexOf("config=") + "config=".length));
}

describe("attachDebugger — ptrace rights (R7)", () => {
  const sequence = (probeOut: string): void => {
    runCliMock
      .mockResolvedValueOnce({ stdout: "present\n", stderr: "" }) // vsdbg probe
      .mockResolvedValueOnce({ stdout: "123 dotnet /opt/app/Cmf.Foundation.Services.HostService.dll\n", stderr: "" }) // pid
      .mockResolvedValueOnce({ stdout: probeOut, stderr: "" }); // ptrace probe
  };

  it("docker + non-root exec user without the cap → --privileged -u 0 (root with the full set)", async () => {
    sequence("CapEff:\t0000000000000000\nuid=1001\nyama=1\n");
    const lines: string[] = [];
    await expect(attachDebugger(target, { "/x": "/dees" }, (m) => lines.push(m))).resolves.toBe(true);
    expect(loggedConfig(lines).pipeTransport!.pipeArgs).toEqual(["exec", "--privileged", "-u", "0", "-i", "custom_host"]);
  });

  it("docker with CAP_SYS_PTRACE already granted → unprivileged exec", async () => {
    sequence("CapEff:\t000001ffffffffff\nuid=0\nyama=1\n");
    const lines: string[] = [];
    await attachDebugger(target, { "/x": "/dees" }, (m) => lines.push(m));
    expect(loggedConfig(lines).pipeTransport!.pipeArgs).toEqual(["exec", "-i", "custom_host"]);
  });

  it("kubernetes without the cap → explains the pod-spec fix and only attaches on 'Attach Anyway'", async () => {
    const k8s: HostTarget = { ...target, kind: "kubernetes", k8sTarget: "deployment/host -n mes" };
    sequence("CapEff:\t0000000000000000\nuid=1001\nyama=1\n");
    await expect(attachDebugger(k8s, { "/x": "/dees" })).resolves.toBe(false); // dialog dismissed
    expect(messages.some((m) => /SYS_PTRACE/.test(m) && /runAsUser: 0/.test(m))).toBe(true);

    sequence("CapEff:\t0000000000000000\nuid=1001\nyama=1\n");
    __queueInfoResponse("Attach Anyway");
    await expect(attachDebugger(k8s, { "/x": "/dees" })).resolves.toBe(true);
  });

  it("Yama ptrace_scope 3 blocks the attach with an explanation", async () => {
    sequence("CapEff:\t000001ffffffffff\nuid=0\nyama=3\n");
    await expect(attachDebugger(target, { "/x": "/dees" })).resolves.toBe(false);
    expect(messages.some((m) => /ptrace_scope is 3/.test(m))).toBe(true);
  });
});

describe("installVsdbg (L5 — no silent reroute)", () => {
  it("logs the downloader-probe failure before falling through to the local-download path", async () => {
    runCliMock
      .mockRejectedValueOnce(new Error("docker … exited with 1: ")) // downloader probe (no curl/wget)
      .mockRejectedValueOnce(new Error("engine down")); // uname probe of the local fallback
    const lines: string[] = [];
    await expect(installVsdbg(target, (m) => lines.push(m))).rejects.toThrow("engine down");
    expect(lines.some((l) => l.includes("downloader probe failed"))).toBe(true);
  });

  it("uses the in-container downloader when the image has curl", async () => {
    runCliMock
      .mockResolvedValueOnce({ stdout: "/usr/bin/curl\n", stderr: "" }) // downloader probe
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // install
    await expect(installVsdbg(target)).resolves.toBeUndefined();
    expect(runCliMock).toHaveBeenCalledTimes(2);
  });
});
