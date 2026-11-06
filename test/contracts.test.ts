/**
 * Contract tests: the core codecs against REAL MES 11.2.5 payloads (test/fixtures/).
 * These are the cross-IDE source of truth (ADR 0003) — if a fixture fails to parse,
 * the client broke, not the fixture.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MesClient } from "../src/core/mesClient";
import { extractBodies } from "../src/core/deeFile";
import { decodeCmfValues } from "../src/core/cmfData";
import { extractServerMessage, parseHostErrors } from "../src/core/errorMap";
import { isEffective, UniversalState } from "../src/core/types";
import { canMakeEffective, isDraftVersion, NEW_ACTION_CODE_TEMPLATE, validateActionName } from "../src/core/actionVersions";

// cwd-relative (vitest runs from the project root): import.meta is not allowed in this
// project's CommonJS tsc output (TS1470), which broke `npm run build`.
const fixture = (name: string): string =>
  readFileSync(join(process.cwd(), "test", "fixtures", name), "utf8");

const clientFor = (body: string): MesClient =>
  new MesClient({
    hostAddress: "http://fixture",
    credentials: async () => ({ accessToken: "t" }),
    fetchImpl: vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
  });

describe("MES 11.2.5 contract fixtures", () => {
  it("GetAllActions: string ids, numeric UniversalState, inline group memberships", async () => {
    const actions = await clientFor(fixture("GetAllActions.json")).getAllActions();
    expect(actions.length).toBeGreaterThanOrEqual(3);
    for (const action of actions) {
      expect(typeof action.Id).toBe("string"); // beyond MAX_SAFE_INTEGER — never numbers
      expect(action.Name).toBeTruthy();
    }
    expect(actions.some((a) => isEffective(a.UniversalState))).toBe(true);
    const withGroups = actions.find((a) => (a.ActionGroupActions ?? []).length > 0)!;
    expect(withGroups.ActionGroupActions![0]!.ActionGroup!.Name).toBeTruthy();
  });

  it("GetAllActionGroups: dot-delimited extension-point names", async () => {
    const groups = await clientFor(fixture("GetAllActionGroups.json")).getAllActionGroups();
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((g) => typeof g.Name === "string" && g.Name.includes("."))).toBe(true);
  });

  it("GetActionByName: round-trippable action entity", async () => {
    const action = await clientFor(fixture("GetActionByName.json")).getActionByName("SmokeTestDeeDebugger");
    expect(action.Name).toBe("SmokeTestDeeDebugger");
    expect(typeof action.ActionCode).toBe("string");
    expect(typeof action.Id).toBe("string");
  });

  it("GetActionFullCode: generated wrapper with all four markers, bodies extractable", async () => {
    const fullCode = await clientFor(fixture("GetActionFullCode.json")).getActionFullCode({ Name: "x" });
    const bodies = extractBodies(fullCode);
    expect(bodies.dialect).toBe("generated");
    expect(bodies.actionCode).toContain('Input["touched"]');
    expect(bodies.validationCode.trim().length).toBeGreaterThan(0);
  });

  it("GetActionVersionsAsDataSet: Actions.Table1 rows with per-version ids", async () => {
    const rows = await clientFor(fixture("GetActionVersionsAsDataSet.json")).getActionVersions({ Name: "x" });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(new Set(rows.map((r) => r.Id)).size).toBe(rows.length); // each version has its own Id
    expect(rows.filter((r) => r.UniversalState === 3)).toHaveLength(1); // exactly one Effective
  });

  it("ExecuteAction: CMFMap output decodes to a plain dictionary", async () => {
    const result = await clientFor(fixture("ExecuteAction.json")).executeAction({ Name: "x" }, {});
    const output = decodeCmfValues(result.Output) as Record<string, unknown>;
    expect(output["touched"]).toBe(1);
    expect(JSON.stringify(output)).not.toContain("$typeCMF");
  });

  // --- MES 12.0.0-beta.2 captures (2026-10-18), GitHub #7/#8 lifecycle ---

  it("CreateAction (12.0): a new action is v1 / Active (not effective) / enabled, with the wizard template", async () => {
    const action = await clientFor(fixture("CreateAction.json")).createAction({ Name: "x" });
    expect(typeof action.Id).toBe("string");
    expect(action.Version).toBe(1);
    expect(action.UniversalState).toBe(UniversalState.Active);
    expect(isEffective(action.UniversalState)).toBe(false);
    expect(isDraftVersion(action)).toBe(true);
    expect(canMakeEffective(action)).toBe(true);
    expect(action.IsEnabled).toBe(true);
    expect(action.ActionCode).toBe(NEW_ACTION_CODE_TEMPLATE);
    expect(action.ValidationCode).toBe("return true;");
  });

  it("MakeActionVersionEffective (12.0): same version comes back Effective", async () => {
    const action = await clientFor(fixture("MakeActionVersionEffective.json")).makeActionVersionEffective({ Name: "x" });
    expect(action.Version).toBe(1);
    expect(isEffective(action.UniversalState)).toBe(true);
    expect(isDraftVersion(action)).toBe(false);
  });

  it("CompileAndSave without Id (12.0, sync upload of a new local DEE): created as enabled Active v1", async () => {
    const action = await clientFor(fixture("CompileAndSave.create.json")).compileAndSave({ Name: "x" });
    expect(action.Version).toBe(1);
    expect(action.UniversalState).toBe(UniversalState.Active);
    expect(action.IsEnabled).toBe(true); // only because the payload set it — the host defaults a missing flag to false
    expect(action.ActionCode).toContain("deeDebuggerLive");
  });

  it("MakeActionVersionEffective fault (12.0): a non-Active version is refused with a readable reason", () => {
    const fault = JSON.parse(fixture("MakeActionVersionEffective.error.json"));
    expect(extractServerMessage(JSON.stringify(fault))).toMatch(/is not Active/);
  });

  it("CreateAction fault (12.0): an invalid name is Val50018 — mirrored client-side by validateActionName", () => {
    const fault = JSON.parse(fixture("CreateAction.error.json"));
    expect(fault.Code.Name).toBe("Val50018");
    expect(extractServerMessage(JSON.stringify(fault))).toMatch(/invalid for property Name/);
    expect(validateActionName("1bad name")).toBeDefined();
  });

  it("CompileAndSave fault: Reason.Text parses into structured, mappable errors", () => {
    const fault = JSON.parse(fixture("CompileAndSave.error.json"));
    const errors = parseHostErrors(fault.Reason.Text);
    const structured = errors.filter((e) => e.scope !== "unknown");
    expect(structured).toHaveLength(1);
    expect(structured[0]).toMatchObject({ scope: "action", relativeLine: 1, column: 11, severity: "error" });
  });
});
