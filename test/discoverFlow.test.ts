import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getCommand,
  __getConfig,
  __queueInfoResponse,
  __queueInputBox,
  __queueQuickPick,
  __reset,
  __resetCommands,
  __setConfig,
  messages,
} from "./mocks/vscode";

const { discoverMock } = vi.hoisted(() => ({ discoverMock: vi.fn() }));
vi.mock("../src/vscode/discovery", () => ({ discoverEnvironments: discoverMock }));

import { registerCommands } from "../src/vscode/commands";
import { CredentialStore } from "../src/vscode/settings";
import { SessionStore } from "../src/vscode/session";

const DIND_CANDIDATE = {
  name: "dind-devc",
  kind: "docker",
  containerName: "custom_host",
  engineCommand: ["docker", "exec", "-i", "devc", "docker"],
  hostAddress: "http://172.17.0.2",
  source: "docker-in-docker",
  reachable: true,
};

class FakeSecrets {
  readonly store_ = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.store_.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.store_.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store_.delete(key);
  }
}

function setup(): { secrets: FakeSecrets; refresh: ReturnType<typeof vi.fn> } {
  __reset();
  __resetCommands();
  __setConfig({});
  const secrets = new FakeSecrets();
  const refresh = vi.fn(async () => undefined);
  const explorer = {
    refresh,
    allActions: () => [],
    isLoaded: true,
    rawActions: () => [],
    findAction: () => undefined,
    setFilter: () => undefined,
    currentFilter: undefined,
  };
  registerCommands({ subscriptions: [] } as never, {
    getClient: () => {
      throw new Error("client must not be needed in the discover/connect flow");
    },
    explorer: explorer as never,
    sessions: new SessionStore(),
    diagnostics: { clear: () => undefined, publishServerErrors: () => 0, dispose: () => undefined } as never,
    credentials: new CredentialStore(secrets as never),
    output: { appendLine: () => undefined } as never,
    serverContent: {} as never,
  });
  return { secrets, refresh };
}

describe("discover → connect flow", () => {
  beforeEach(() => discoverMock.mockReset());

  it("single discovered environment: Connect adds and activates it", async () => {
    setup();
    discoverMock.mockResolvedValue([DIND_CANDIDATE]);
    __queueQuickPick((items) => (items as { picked: boolean }[]).filter((i) => i.picked)); // accept preselected
    __queueInfoResponse("Connect"); // added-environment notification

    await __getCommand("deeDebugger.discoverEnvironments")!();

    const config = __getConfig();
    expect(config["environments"]).toEqual([
      {
        name: "dind-devc",
        kind: "docker",
        containerName: "custom_host",
        engineCommand: ["docker", "exec", "-i", "devc", "docker"],
        hostAddress: "http://172.17.0.2",
      },
    ]);
    expect(config["activeEnvironment"]).toBe("dind-devc");
    expect(messages.some((m) => m.includes("Added environment 'dind-devc'"))).toBe(true);
    // Prompting for credentials on activation is centralized in the activation handler
    // (extension.ts config-change listener), so every path — switch, connect, add/remove
    // fall-over, direct settings edits — asks the same way without double-prompting. That
    // handler is verified manually (F5); it is intentionally not exercised by this unit.
  });

  it("declining Connect leaves nothing activated but keeps the profile", async () => {
    setup();
    discoverMock.mockResolvedValue([DIND_CANDIDATE]);
    __queueQuickPick((items) => items);
    __queueInfoResponse(undefined); // dismiss the notification
    await __getCommand("deeDebugger.discoverEnvironments")!();
    expect((__getConfig()["environments"] as unknown[]).length).toBe(1);
    expect(__getConfig()["activeEnvironment"]).toBeUndefined();
  });

  it("multiple discovered environments: Connect… opens the switcher to choose one", async () => {
    setup();
    const second = { ...DIND_CANDIDATE, name: "docker-host", containerName: "host", engineCommand: undefined, hostAddress: "http://localhost" };
    discoverMock.mockResolvedValue([DIND_CANDIDATE, second]);
    __queueQuickPick((items) => items); // add both
    __queueInfoResponse("Connect…");
    __queueQuickPick((items) =>
      (items as { name?: string }[]).find((i) => i.name === "docker-host"),
    ); // switcher pick
    __queueInfoResponse(undefined); // skip token setup for now

    await __getCommand("deeDebugger.discoverEnvironments")!();

    expect((__getConfig()["environments"] as { name: string }[]).map((e) => e.name)).toEqual([
      "dind-devc",
      "docker-host",
    ]);
    expect(__getConfig()["activeEnvironment"]).toBe("docker-host");
  });

  it("already-configured environments are not offered again", async () => {
    setup();
    __setConfig({
      environments: [
        {
          name: "existing",
          hostAddress: "http://172.17.0.2",
          containerName: "custom_host",
          engineCommand: ["docker", "exec", "-i", "devc", "docker"],
        },
      ],
    });
    discoverMock.mockResolvedValue([DIND_CANDIDATE]);
    await __getCommand("deeDebugger.discoverEnvironments")!();
    expect(messages.some((m) => m.includes("already configured"))).toBe(true);
    expect((__getConfig()["environments"] as unknown[]).length).toBe(1);
  });

  it("reports when nothing is found", async () => {
    setup();
    discoverMock.mockResolvedValue([]);
    await __getCommand("deeDebugger.discoverEnvironments")!();
    expect(messages.some((m) => m.includes("No MES environments found"))).toBe(true);
  });
});

describe("manage environments", () => {
  const ENVS = [
    { name: "a", hostAddress: "http://a" },
    { name: "b", hostAddress: "http://b" },
  ];

  it("remove deletes the profile, wipes its credentials and falls over to the next environment", async () => {
    const { secrets } = setup();
    __setConfig({ environments: ENVS, activeEnvironment: "a" });
    await secrets.store("deeDebugger.personalAccessToken.a", "tok-a");
    await secrets.store("deeDebugger.personalAccessToken.b", "tok-b");
    __queueQuickPick((items) => (items as { e: { name: string } }[]).find((i) => i.e?.name === "a"));
    __queueQuickPick((items) => (items as { action: string }[]).find((i) => i.action === "remove"));
    __queueInfoResponse("Remove"); // modal confirmation

    await __getCommand("deeDebugger.manageEnvironments")!();

    expect((__getConfig()["environments"] as { name: string }[]).map((e) => e.name)).toEqual(["b"]);
    // Removing the active environment falls over to the next remaining one.
    expect(__getConfig()["activeEnvironment"]).toBe("b");
    expect(secrets.store_.has("deeDebugger.personalAccessToken.a")).toBe(false);
    expect(secrets.store_.get("deeDebugger.personalAccessToken.b")).toBe("tok-b");
  });

  it("edit with rename migrates credentials and keeps the environment active", async () => {
    const { secrets } = setup();
    __setConfig({ environments: ENVS, activeEnvironment: "a", hostAddress: "http://flat" });
    await secrets.store("deeDebugger.personalAccessToken.a", "tok-a");
    __queueQuickPick((items) => (items as { e: { name: string } }[]).find((i) => i.e?.name === "a"));
    __queueQuickPick((items) => (items as { action: string }[]).find((i) => i.action === "edit"));
    __queueInputBox("renamed"); // wizard: name
    __queueInputBox("http://a-new"); // wizard: host address
    __queueQuickPick((items) => (items as { hostKind?: string }[]).find((i) => i.hostKind === "process"));

    await __getCommand("deeDebugger.manageEnvironments")!();

    const envs = __getConfig()["environments"] as { name: string; hostAddress: string }[];
    expect(envs.map((e) => e.name)).toEqual(["renamed", "b"]);
    expect(envs[0]!.hostAddress).toBe("http://a-new");
    expect(__getConfig()["activeEnvironment"]).toBe("renamed");
    expect(secrets.store_.has("deeDebugger.personalAccessToken.a")).toBe(false);
    expect(secrets.store_.get("deeDebugger.personalAccessToken.renamed")).toBe("tok-a");
  });

  it("wizard rejects a duplicate name via validation", async () => {
    setup();
    __setConfig({ environments: ENVS });
    __queueQuickPick((items) => (items as { e: { name: string } }[]).find((i) => i.e?.name === "a"));
    __queueQuickPick((items) => (items as { action: string }[]).find((i) => i.action === "edit"));
    __queueInputBox("b"); // rename 'a' to existing 'b' → validateInput blocks → wizard aborts
    await __getCommand("deeDebugger.manageEnvironments")!();
    expect((__getConfig()["environments"] as { name: string }[]).map((e) => e.name)).toEqual(["a", "b"]);
  });
});

describe("add environment — connection variants", () => {
  it("OpenShift variant produces kind=kubernetes with the oc engine", async () => {
    setup();
    __queueInputBox("ocp-dev"); // name
    __queueInputBox("https://mes.ocp.example"); // host address
    __queueQuickPick((items) => (items as { variant?: string }[]).find((i) => i.variant === "oc"));
    __queueInputBox("deployment/host -n mes-dev"); // oc exec target
    __queueInfoResponse(undefined); // skip token prompt

    await __getCommand("deeDebugger.addEnvironment")!();

    const envs = __getConfig()["environments"] as Record<string, unknown>[];
    expect(envs[0]).toEqual({
      name: "ocp-dev",
      hostAddress: "https://mes.ocp.example",
      kind: "kubernetes",
      engineCommand: ["oc"],
      k8sTarget: "deployment/host -n mes-dev",
    });
    expect(__getConfig()["activeEnvironment"]).toBe("ocp-dev");
  });

  it("remote docker variant maps ssh:// hosts to -H and names to --context", async () => {
    setup();
    __queueInputBox("remote-a");
    __queueInputBox("https://mes.remote.example");
    __queueQuickPick((items) => (items as { variant?: string }[]).find((i) => i.variant === "remote"));
    __queueInputBox("ssh://dev@buildbox"); // daemon address
    __queueInputBox("custom_host"); // container
    __queueInfoResponse(undefined);
    await __getCommand("deeDebugger.addEnvironment")!();
    const envs = __getConfig()["environments"] as { engineCommand?: string[] }[];
    expect(envs[0]!.engineCommand).toEqual(["docker", "-H", "ssh://dev@buildbox"]);
  });
});
