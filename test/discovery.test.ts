import { describe, expect, it } from "vitest";
import {
  isDevcontainer,
  isMesHostContainer,
  parseDockerPs,
  sameEnvironment,
  uniqueName,
} from "../src/core/discovery";

describe("parseDockerPs", () => {
  it("parses name/image lines and skips blanks", () => {
    const entries = parseDockerPs("host\tdev.criticalmanufacturing.io/criticalmanufacturing/host:12.0\n\n c1 \t img \n");
    expect(entries).toEqual([
      { name: "host", image: "dev.criticalmanufacturing.io/criticalmanufacturing/host:12.0" },
      { name: "c1", image: "img" },
    ]);
  });
});

describe("isMesHostContainer", () => {
  it("matches canonical names and product host images", () => {
    expect(isMesHostContainer({ name: "host", image: "whatever" })).toBe(true);
    expect(isMesHostContainer({ name: "custom_host", image: "x" })).toBe(true);
    expect(isMesHostContainer({ name: "h1", image: "dev.criticalmanufacturing.io/criticalmanufacturing/host:11.2.5" })).toBe(true);
    expect(isMesHostContainer({ name: "h2", image: "criticalmanufacturing/core-host:12" })).toBe(true);
  });

  it("rejects the rest of the stack", () => {
    for (const name of ["traefik", "db", "securityportal", "messagebus", "custom_ui"]) {
      expect(isMesHostContainer({ name, image: `something/${name}:1` })).toBe(false);
    }
    expect(isMesHostContainer({ name: "hosting", image: "nginx" })).toBe(false);
  });
});

describe("isDevcontainer", () => {
  it("matches vsc-* images only", () => {
    expect(isDevcontainer({ name: "romantic_curran", image: "vsc-cmf-io-abc123-uid" })).toBe(true);
    expect(isDevcontainer({ name: "x", image: "ubuntu" })).toBe(false);
  });
});

describe("uniqueName", () => {
  it("suffixes on collision", () => {
    expect(uniqueName("dind-dc", [])).toBe("dind-dc");
    expect(uniqueName("dind-dc", ["dind-dc"])).toBe("dind-dc-2");
    expect(uniqueName("dind-dc", ["dind-dc", "dind-dc-2"])).toBe("dind-dc-3");
  });
});

describe("sameEnvironment", () => {
  it("compares address, container and engine command", () => {
    const a = { name: "x", hostAddress: "http://1.2.3.4", containerName: "custom_host",
      engineCommand: ["docker", "exec", "-i", "dc", "docker"] };
    expect(sameEnvironment(a, { ...a, name: "y" })).toBe(true);
    expect(sameEnvironment(a, { ...a, hostAddress: "http://other" })).toBe(false);
    expect(sameEnvironment(a, { ...a, engineCommand: ["docker"] })).toBe(false);
  });
});
