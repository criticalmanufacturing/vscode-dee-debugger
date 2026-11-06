import { describe, expect, it, vi } from "vitest";
import { MesApiError, MesClient } from "../src/core/mesClient";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const makeClient = (fetchImpl: typeof fetch, credentials = { accessToken: "tok" }) =>
  new MesClient({
    hostAddress: "http://localhost:8084/",
    credentials: async () => credentials,
    fetchImpl,
  });

describe("MesClient", () => {
  it("posts to /api/DynamicExecutionEngine/{Method} with the contract headers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ Actions: [] }));
    await makeClient(fetchMock as unknown as typeof fetch).getAllActions();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8084/api/DynamicExecutionEngine/GetAllActions");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["cmf_returnfaultexceptions"]).toBe("false");
    expect(headers["cmf_currentculture"]).toBeTruthy();
    expect(init.method).toBe("POST");
  });

  // The forward-auth exchanges the part AFTER the colon (`Split(":")[1]`, 11.0 → 12.0);
  // `PAT:` sends an empty token and gets a login redirect (seen live on 12.0.0-beta.2).
  // The token goes on both sides so either field a parser reads is the PAT.
  it("falls back to Basic auth carrying the PAT in BOTH credential fields when no access token is set", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ Actions: [] }));
    await makeClient(fetchMock as unknown as typeof fetch, {
      personalAccessToken: " pat123 ",
    } as never).getAllActions();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const header = (init.headers as Record<string, string>)["Authorization"]!;
    expect(header).toBe(`Basic ${Buffer.from("pat123:pat123").toString("base64")}`);
    const decoded = Buffer.from(header.replace(/^Basic /, ""), "base64").toString("utf8");
    expect(decoded.split(":")[1]).toBe("pat123"); // what cmf.auth.service reads
    expect(decoded.split(":")[0]).toBe("pat123"); // what a user-field parser would read
  });

  it("throws a configuration error when no credentials exist", async () => {
    const client = makeClient(vi.fn() as unknown as typeof fetch, {} as never);
    await expect(client.getAllActions()).rejects.toThrow(/No credentials configured/);
  });

  it("wraps HTTP failures in MesApiError with status and details", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500, statusText: "Server Error" }));
    const promise = makeClient(fetchMock as unknown as typeof fetch).getAllActions();
    await expect(promise).rejects.toBeInstanceOf(MesApiError);
    try {
      await makeClient(fetchMock as unknown as typeof fetch).getAllActions();
    } catch (error) {
      const apiError = error as MesApiError;
      expect(apiError.status).toBe(500);
      expect(apiError.details).toBe("boom");
    }
  });

  it("flags 401 as auth error", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 401 }));
    try {
      await makeClient(fetchMock as unknown as typeof fetch).getAllActions();
      expect.unreachable();
    } catch (error) {
      expect((error as MesApiError).isAuthError).toBe(true);
    }
  });

  it("resolves $ref metadata in responses", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        Actions: [
          { $id: "1", Name: "A", ActionGroupActions: [{ ActionGroup: { $id: "2", Name: "G" } }] },
          { $id: "3", Name: "B", ActionGroupActions: [{ ActionGroup: { $ref: "2" } }] },
        ],
      }),
    );
    const actions = await makeClient(fetchMock as unknown as typeof fetch).getAllActions();
    expect(actions[1]!.ActionGroupActions![0]!.ActionGroup!.Name).toBe("G");
  });

  it("sends Action and SourceFilePath on ActivateDebugMode", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ Action: { Name: "A", IsInDebugMode: true } }));
    const result = await makeClient(fetchMock as unknown as typeof fetch).activateDebugMode(
      { Name: "A" },
      "/tmp/CriticalManufacturing/dee-debug/A.cs",
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/ActivateDebugMode");
    expect(JSON.parse(init.body as string)).toEqual({
      Action: { Name: "A" },
      SourceFilePath: "/tmp/CriticalManufacturing/dee-debug/A.cs",
    });
    expect(result.IsInDebugMode).toBe(true);
  });
});

describe("MesApiError classification", () => {
  it("flags 409 as a concurrency conflict", async () => {
    const fetchMock = vi.fn(async () => new Response("conflict", { status: 409 }));
    try {
      await makeClient(fetchMock as unknown as typeof fetch).getAllActions();
      expect.unreachable();
    } catch (error) {
      expect((error as MesApiError).isConcurrencyConflict).toBe(true);
      expect((error as MesApiError).isAuthError).toBe(false);
    }
  });
});

describe("M5 endpoints", () => {
  it("sends ActionId + ActionName + Input on ExecuteReadOnlyAction (11.2.5 contract)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ Output: { $typeCMF: "CMFMap", CMFMapData: [["x", 1]] } }));
    await makeClient(fetchMock as unknown as typeof fetch).executeReadOnlyAction(
      { Name: "A", Id: "2608141531140000003" },
      { a: 1 },
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/ExecuteReadOnlyAction");
    expect(JSON.parse(init.body as string)).toEqual({
      ActionId: "2608141531140000003",
      ActionName: "A",
      Input: { a: 1 },
    });
  });

  it("flattens GetActionVersionsAsDataSet rows from Actions.Table1", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ Actions: { Table1: [{ Id: "1", Name: "A", Version: 2, UniversalState: 3 }] } }),
    );
    const rows = await makeClient(fetchMock as unknown as typeof fetch).getActionVersions({ Name: "A" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Version: 2, UniversalState: 3 });
  });

  it("returns an empty version list when the DataSet is absent", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    expect(await makeClient(fetchMock as unknown as typeof fetch).getActionVersions({ Name: "A" })).toEqual([]);
  });
});

describe("login-page detection (rejected token behind forward-auth)", () => {
  it("explains an HTML 200 response as a rejected token, not unparseable JSON", async () => {
    const fetchMock = vi.fn(async () => new Response("<html><head><title>Authentication Portal</title></head></html>", { status: 200 }));
    try {
      await makeClient(fetchMock as unknown as typeof fetch).getAllActions();
      expect.unreachable();
    } catch (error) {
      expect((error as MesApiError).message).toContain("login page");
      expect((error as MesApiError).message).toContain("token was rejected");
    }
  });

  it("still reports genuinely broken JSON as unparseable", async () => {
    const fetchMock = vi.fn(async () => new Response("{not json", { status: 200 }));
    await expect(makeClient(fetchMock as unknown as typeof fetch).getAllActions()).rejects.toThrow(/unparseable JSON/);
  });
});
