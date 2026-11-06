import { describe, expect, it } from "vitest";
import { buildDockerEngineCommand, DEFAULT_HOST_ADDRESS, DEFAULT_HOST_TARGET, decideActivation, dindDevcontainerName, resolveEnvironment } from "../src/core/env";

describe("decideActivation", () => {
  it("returns not-connected when no environment is active", () => {
    expect(decideActivation(undefined, false)).toBe("not-connected");
    expect(decideActivation(undefined, true)).toBe("not-connected");
    expect(decideActivation("", true)).toBe("not-connected");
  });

  it("asks for credentials when an active environment has none", () => {
    expect(decideActivation("cmf-io", false)).toBe("needs-credentials");
  });

  it("is ready to load when an active environment has credentials", () => {
    expect(decideActivation("cmf-io", true)).toBe("ready");
  });
});

describe("resolveEnvironment", () => {
  it("returns undefined (not connected) when no environment is active or found", () => {
    expect(resolveEnvironment([], undefined)).toBeUndefined();
    expect(resolveEnvironment([], "")).toBeUndefined();
    expect(resolveEnvironment([{ name: "dev" }], "missing")).toBeUndefined();
  });

  it("fills omitted fields with built-in defaults", () => {
    const resolved = resolveEnvironment([{ name: "min" }], "min")!;
    expect(resolved.envName).toBe("min");
    expect(resolved.settings.hostAddress).toBe(DEFAULT_HOST_ADDRESS);
    expect(resolved.settings.hostTarget).toEqual(DEFAULT_HOST_TARGET);
  });

  it("applies every field a profile defines", () => {
    const resolved = resolveEnvironment(
      [{
        name: "cmf-io",
        hostAddress: "http://172.17.0.2",
        containerName: "custom_host",
        engineCommand: ["docker", "exec", "-i", "dc", "docker"],
        sourcePathInHost: "/mnt/dee",
        vsdbgPath: "/opt/vsdbg/vsdbg",
        useMount: true,
      }],
      "cmf-io",
    )!;
    expect(resolved.settings.hostAddress).toBe("http://172.17.0.2");
    expect(resolved.settings.hostTarget).toMatchObject({
      kind: "docker",
      containerName: "custom_host",
      engineCommand: ["docker", "exec", "-i", "dc", "docker"],
      sourcePathInHost: "/mnt/dee",
      vsdbgPath: "/opt/vsdbg/vsdbg",
      useMount: true,
    });
  });

  it("kubernetes profiles switch kind fields cleanly", () => {
    const resolved = resolveEnvironment(
      [{ name: "k8s", kind: "kubernetes", k8sTarget: "deployment/host -n local" }],
      "k8s",
    )!;
    expect(resolved.settings.hostTarget.kind).toBe("kubernetes");
    expect(resolved.settings.hostTarget.k8sTarget).toBe("deployment/host -n local");
  });

  it("ignores an empty engineCommand and does not mutate the defaults", () => {
    const resolved = resolveEnvironment([{ name: "e", engineCommand: [] }], "e")!;
    expect(resolved.settings.hostTarget.engineCommand).toBeUndefined();
    expect(DEFAULT_HOST_TARGET.engineCommand).toBeUndefined();
    expect(DEFAULT_HOST_TARGET.containerName).toBe("custom_host");
  });
});

describe("buildDockerEngineCommand / dindDevcontainerName", () => {
  it("encodes every wizard variant", () => {
    expect(buildDockerEngineCommand({ type: "dind", devcontainer: " devc " })).toEqual(["docker", "exec", "-i", "devc", "docker"]);
    expect(buildDockerEngineCommand({ type: "remote", target: "ssh://u@h" })).toEqual(["docker", "-H", "ssh://u@h"]);
    expect(buildDockerEngineCommand({ type: "remote", target: "ctx1" })).toEqual(["docker", "--context", "ctx1"]);
    expect(buildDockerEngineCommand({ type: "wsl" })).toEqual(["wsl", "docker"]);
    expect(buildDockerEngineCommand({ type: "wsl", distro: "Ubuntu" })).toEqual(["wsl", "-d", "Ubuntu", "docker"]);
    expect(buildDockerEngineCommand({ type: "custom", command: " ssh devbox  docker " })).toEqual(["ssh", "devbox", "docker"]);
  });

  it("recognizes only genuine dind engine commands", () => {
    expect(dindDevcontainerName(["docker", "exec", "-i", "devc", "docker"])).toBe("devc");
    expect(dindDevcontainerName(["docker", "--context", "x"])).toBeUndefined();
    expect(dindDevcontainerName(undefined)).toBeUndefined();
  });
});
