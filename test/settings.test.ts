import { beforeEach, describe, expect, it } from "vitest";
import { CredentialStore, migrateLegacyFlatSettings, readSettings, updateSettingInOwningScope } from "../src/vscode/settings";
import { __getConfig, __getScopedConfig, __setConfig, __setInputBox, __setWorkspaceConfig, messages } from "./mocks/vscode";

const b64url = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const patJwt = `${b64url({ alg: "RS256" })}.${b64url({ type: "PAT", sub: "admin" })}.sig`;

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

describe("CredentialStore environment scoping", () => {
  let secrets: FakeSecrets;
  beforeEach(() => {
    secrets = new FakeSecrets();
    messages.length = 0;
  });

  const storeFor = (env: string | undefined): CredentialStore =>
    new CredentialStore(secrets as never, () => env);

  it("stores tokens under environment-suffixed keys", async () => {
    __setInputBox(patJwt);
    await storeFor("cmf-io").promptPersonalAccessToken();
    expect([...secrets.store_.keys()]).toEqual(["deeDebugger.personalAccessToken.cmf-io"]);
    expect(messages[0]).toContain("[environment: cmf-io]");
  });

  it("keeps credentials isolated between environments and the default", async () => {
    __setInputBox(patJwt);
    await storeFor("cmf-io").promptPersonalAccessToken();
    expect((await storeFor("cmf-io").get()).personalAccessToken).toBe(patJwt);
    expect((await storeFor("shared-dev").get()).personalAccessToken).toBeUndefined();
    expect((await storeFor(undefined).get()).personalAccessToken).toBeUndefined();
  });

  it("uses the legacy un-suffixed keys for the default environment", async () => {
    __setInputBox(patJwt);
    await storeFor(undefined).promptPersonalAccessToken();
    expect([...secrets.store_.keys()]).toEqual(["deeDebugger.personalAccessToken"]);
  });

  it("hasCredentials checks a specific environment regardless of the active one", async () => {
    __setInputBox(patJwt);
    await storeFor("cmf-io").promptPersonalAccessToken();
    const store = storeFor("other");
    expect(await store.hasCredentials("cmf-io")).toBe(true);
    expect(await store.hasCredentials("other")).toBe(false);
    expect(await store.hasCredentials(undefined)).toBe(false);
  });

  it("clear() only wipes the active environment's credentials", async () => {
    __setInputBox(patJwt);
    await storeFor("a").promptPersonalAccessToken();
    await storeFor("b").promptPersonalAccessToken();
    await storeFor("a").clear();
    expect((await storeFor("a").get()).personalAccessToken).toBeUndefined();
    expect((await storeFor("b").get()).personalAccessToken).toBe(patJwt);
  });

  it("a PAT pasted into the access-token prompt is re-routed within the same environment", async () => {
    __setInputBox(patJwt);
    await storeFor("cmf-io").promptAccessToken();
    expect(secrets.store_.has("deeDebugger.personalAccessToken.cmf-io")).toBe(true);
    expect(secrets.store_.has("deeDebugger.accessToken.cmf-io")).toBe(false);
  });

  it("setting a PAT clears a pre-existing access token (eng minor-9 regression)", async () => {
    // Seed a stored access token, then set a PAT — the access token must be deleted so it
    // cannot shadow the PAT (mesClient prefers accessToken).
    await secrets.store("deeDebugger.accessToken.cmf-io", "stale-access");
    __setInputBox(patJwt);
    await storeFor("cmf-io").promptPersonalAccessToken();
    expect(secrets.store_.has("deeDebugger.accessToken.cmf-io")).toBe(false);
    expect((await storeFor("cmf-io").get()).personalAccessToken).toBe(patJwt);
    expect((await storeFor("cmf-io").get()).accessToken).toBeUndefined();
  });

  it("clearFor wipes only the named environment's credentials", async () => {
    __setInputBox(patJwt);
    await storeFor("a").promptPersonalAccessToken();
    await secrets.store("deeDebugger.accessToken.a", "acc-a");
    await storeFor("b").promptPersonalAccessToken();
    await storeFor("other").clearFor("a");
    expect(secrets.store_.has("deeDebugger.personalAccessToken.a")).toBe(false);
    expect(secrets.store_.has("deeDebugger.accessToken.a")).toBe(false);
    expect(secrets.store_.has("deeDebugger.personalAccessToken.b")).toBe(true);
  });
});

describe("readSettings environment resolution", () => {
  it("resolves the active environment with built-in defaults for omitted fields", () => {
    __setConfig({
      environments: [
        { name: "cmf-io", hostAddress: "http://172.17.0.2", containerName: "custom_host" },
      ],
      activeEnvironment: "cmf-io",
    });
    const settings = readSettings();
    expect(settings.envName).toBe("cmf-io");
    expect(settings.hostAddress).toBe("http://172.17.0.2");
    expect(settings.hostTarget.containerName).toBe("custom_host");
    expect(settings.hostTarget.vsdbgPath).toBe("/vsdbg/vsdbg");
  });

  it("reports not-connected when no environment is active or the name is unknown", () => {
    __setConfig({ activeEnvironment: "ghost", environments: [] });
    const settings = readSettings();
    expect(settings.envName).toBeUndefined();
    expect(settings.hostAddress).toBe("");
  });
});

describe("migrateLegacyFlatSettings", () => {
  it("wraps legacy flat settings + Default credentials into a 'default' environment", async () => {
    const secrets = new FakeSecrets();
    await secrets.store("deeDebugger.personalAccessToken", "legacy-tok");
    __setConfig({
      hostAddress: "http://172.17.0.2",
      "host.containerName": "custom_host",
      "host.engineCommand": ["docker", "exec", "-i", "dc", "docker"],
      environments: [],
    });
    const store = new CredentialStore(secrets as never, () => undefined);
    const migrated = await migrateLegacyFlatSettings(store);
    expect(migrated).toBe("default");
    expect(__getConfig()["activeEnvironment"]).toBe("default");
    expect((__getConfig()["environments"] as Record<string, unknown>[])[0]).toMatchObject({
      name: "default",
      hostAddress: "http://172.17.0.2",
      containerName: "custom_host",
      engineCommand: ["docker", "exec", "-i", "dc", "docker"],
    });
    expect(secrets.store_.get("deeDebugger.personalAccessToken.default")).toBe("legacy-tok");
    expect(secrets.store_.has("deeDebugger.personalAccessToken")).toBe(false);
  });

  it("does nothing when environments already exist or no legacy state is present", async () => {
    const secrets = new FakeSecrets();
    const store = new CredentialStore(secrets as never, () => undefined);
    __setConfig({ environments: [{ name: "x" }] });
    expect(await migrateLegacyFlatSettings(store)).toBeUndefined();
    __setConfig({ environments: [] });
    expect(await migrateLegacyFlatSettings(store)).toBeUndefined();
  });
});

describe("updateSettingInOwningScope (M8)", () => {
  it("writes back to the scope that defines the value", async () => {
    __setConfig({ environments: [{ name: "g" }] }); // global-defined
    await updateSettingInOwningScope("environments", [{ name: "g2" }]);
    expect(__getScopedConfig().global["environments"]).toEqual([{ name: "g2" }]);
    expect(__getScopedConfig().workspace["environments"]).toBeUndefined();

    __setConfig({});
    __setWorkspaceConfig({ environments: [{ name: "w" }] }); // workspace-defined
    await updateSettingInOwningScope("environments", [{ name: "w2" }]);
    expect(__getScopedConfig().workspace["environments"]).toEqual([{ name: "w2" }]);
    expect(__getScopedConfig().global["environments"]).toBeUndefined();
  });

  it("defaults new values to Global (environments are per-machine)", async () => {
    __setConfig({});
    await updateSettingInOwningScope("activeEnvironment", "x");
    expect(__getScopedConfig().global["activeEnvironment"]).toBe("x");
  });
});
