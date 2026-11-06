import { describe, expect, it } from "vitest";
import {
  describeDotnetMismatch,
  parseHostRuntimeMajor,
  parseProjectTfmMajor,
} from "../src/core/dotnetRuntime";
import { listHostRuntimesArgs } from "../src/core/hostExec";
import type { HostTarget } from "../src/core/types";

const docker = (o: Partial<HostTarget> = {}): HostTarget => ({
  kind: "docker",
  containerName: "custom_host",
  k8sTarget: "",
  sourcePathInHost: "/tmp/x",
  useMount: false,
  vsdbgPath: "/vsdbg/vsdbg",
  ...o,
});

describe("parseHostRuntimeMajor", () => {
  it("takes the highest Microsoft.NETCore.App major from --list-runtimes", () => {
    const out = [
      "Microsoft.AspNetCore.App 8.0.24 [/usr/lib64/dotnet/shared/Microsoft.AspNetCore.App]",
      "Microsoft.NETCore.App 8.0.24 [/usr/lib64/dotnet/shared/Microsoft.NETCore.App]",
    ].join("\n");
    expect(parseHostRuntimeMajor(out)).toBe(8);
  });
  it("recognizes .NET 10 and picks the newest when several are installed", () => {
    const out = "Microsoft.NETCore.App 8.0.11 [..]\nMicrosoft.NETCore.App 10.0.0 [..]";
    expect(parseHostRuntimeMajor(out)).toBe(10);
  });
  it("returns undefined for empty/absent runtime output", () => {
    expect(parseHostRuntimeMajor("")).toBeUndefined();
    expect(parseHostRuntimeMajor(undefined)).toBeUndefined();
    expect(parseHostRuntimeMajor("command not found: dotnet")).toBeUndefined();
  });
});

describe("parseProjectTfmMajor", () => {
  it("reads a single TargetFramework", () => {
    expect(parseProjectTfmMajor("<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>")).toBe(8);
    expect(parseProjectTfmMajor("<TargetFramework>net10.0</TargetFramework>")).toBe(10);
  });
  it("reads the first entry of TargetFrameworks", () => {
    expect(parseProjectTfmMajor("<TargetFrameworks>net10.0;net8.0</TargetFrameworks>")).toBe(10);
  });
  it("ignores netstandard / non-runtime TFMs", () => {
    expect(parseProjectTfmMajor("<TargetFramework>netstandard2.0</TargetFramework>")).toBeUndefined();
    expect(parseProjectTfmMajor("<TargetFramework>net472</TargetFramework>")).toBeUndefined();
    expect(parseProjectTfmMajor("no tfm here")).toBeUndefined();
  });
});

describe("describeDotnetMismatch", () => {
  it("reports a mismatch only when both majors are known and differ", () => {
    const r = describeDotnetMismatch(10, 8);
    expect(r.mismatch).toBe(true);
    expect(r.message).toMatch(/\.NET 10.*\.NET 8/);
    expect(r.message).toMatch(/v10 → net6\.0, v11 → net8\.0, v12 → net10\.0/);
  });

  it("handles the MES 10 (.NET 6) line", () => {
    expect(describeDotnetMismatch(6, 6).mismatch).toBe(false);
    expect(describeDotnetMismatch(6, 8).mismatch).toBe(true);
  });
  it("is silent when they match or either is unknown (no false alarm)", () => {
    expect(describeDotnetMismatch(8, 8).mismatch).toBe(false);
    expect(describeDotnetMismatch(10, undefined).mismatch).toBe(false);
    expect(describeDotnetMismatch(undefined, 8).mismatch).toBe(false);
  });
});

describe("listHostRuntimesArgs", () => {
  it("runs `dotnet --list-runtimes` in the host", () => {
    expect(listHostRuntimesArgs(docker())).toEqual(["docker", "exec", "custom_host", "dotnet", "--list-runtimes"]);
  });
});
