import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getCommand,
  __queueInputBox,
  __queueQuickPick,
  __reset,
  __resetCommands,
  __setConfig,
  messages,
} from "./mocks/vscode";

vi.mock("../src/vscode/discovery", () => ({ discoverEnvironments: vi.fn() }));

import { registerCommands } from "../src/vscode/commands";
import { CredentialStore } from "../src/vscode/settings";
import { SessionStore } from "../src/vscode/session";

const b64url = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const patJwt = `${b64url({ alg: "RS256" })}.${b64url({ type: "PAT", sub: "admin" })}.sig`;
const accessJwt = `${b64url({ alg: "RS256" })}.${b64url({ sub: "admin" })}.sig`;

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

function setup(): FakeSecrets {
  __reset();
  __resetCommands();
  const secrets = new FakeSecrets();
  registerCommands({ subscriptions: [] } as never, {
    getClient: () => ({}) as never,
    explorer: { refresh: vi.fn(async () => undefined), rebuild: () => undefined } as never,
    sessions: new SessionStore(),
    diagnostics: { clear: () => undefined, publishServerErrors: () => 0, dispose: () => undefined } as never,
    credentials: new CredentialStore(secrets as never),
    output: { appendLine: () => undefined } as never,
    serverContent: {} as never,
  });
  return secrets;
}

describe("Set Credentials chooser (deeDebugger.setCredentials)", () => {
  beforeEach(() => {
    __reset();
    __setConfig({ environments: [{ name: "local", hostAddress: "http://localhost" }], activeEnvironment: "local" });
  });

  it("offers exactly two methods — PAT and access token, no browser sign-in", async () => {
    const secrets = setup();
    __setConfig({ environments: [{ name: "local", hostAddress: "http://localhost" }], activeEnvironment: "local" });
    let offered: { id?: string; label?: string }[] = [];
    __queueQuickPick((items) => {
      offered = items as { id?: string; label?: string }[];
      return undefined; // user dismisses
    });
    await __getCommand("deeDebugger.setCredentials")!();
    expect(offered.map((i) => i.id)).toEqual(["pat", "access"]);
    expect(offered.some((i) => /sign in/i.test(i.label ?? ""))).toBe(false);
    expect([...secrets.store_.keys()]).toEqual([]); // dismissed → nothing stored
  });

  it("routes the PAT choice to the PAT slot for the active environment", async () => {
    const secrets = setup();
    __setConfig({ environments: [{ name: "local", hostAddress: "http://localhost" }], activeEnvironment: "local" });
    __queueQuickPick((items) => (items as { id?: string }[]).find((i) => i.id === "pat"));
    __queueInputBox(patJwt);
    await __getCommand("deeDebugger.setCredentials")!();
    expect(secrets.store_.get("deeDebugger.personalAccessToken.local")).toBe(patJwt);
    expect(secrets.store_.has("deeDebugger.accessToken.local")).toBe(false);
  });

  it("routes the access-token choice to the access-token slot", async () => {
    const secrets = setup();
    __setConfig({ environments: [{ name: "local", hostAddress: "http://localhost" }], activeEnvironment: "local" });
    __queueQuickPick((items) => (items as { id?: string }[]).find((i) => i.id === "access"));
    __queueInputBox(accessJwt);
    await __getCommand("deeDebugger.setCredentials")!();
    expect(secrets.store_.get("deeDebugger.accessToken.local")).toBe(accessJwt);
  });

  it("tells the user to select an environment first when none is active", async () => {
    const secrets = setup();
    __setConfig({ environments: [], activeEnvironment: "" });
    let quickPickShown = false;
    __queueQuickPick(() => {
      quickPickShown = true;
      return undefined;
    });
    await __getCommand("deeDebugger.setCredentials")!();
    expect(quickPickShown).toBe(false);
    expect(messages.some((m) => /select a mes environment first/i.test(m))).toBe(true);
    expect([...secrets.store_.keys()]).toEqual([]);
  });
});
