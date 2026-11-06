import { describe, expect, it } from "vitest";
import { buildSyncPlan, codeEquals, localActionName, normalizeCode, serverDees, uploadPayload } from "../src/core/syncPlan";
import { NEW_ACTION_CODE_TEMPLATE } from "../src/core/actionVersions";

const local = (actionName: string, actionCode: string, validationCode = "return true;") => ({
  actionName,
  filePath: `/dees/${actionName}.cs`,
  actionCode,
  validationCode,
});
const server = (actionName: string, actionCode: string, validationCode = "return true;") => ({
  actionName,
  actionCode,
  validationCode,
  effective: true,
  enabled: true,
});

describe("normalizeCode / codeEquals", () => {
  it("ignores line endings, trailing whitespace and outer blank lines", () => {
    expect(normalizeCode("a;  \r\nb;\r\n\r\n")).toBe("a;\nb;");
    expect(codeEquals(local("x", "a;\r\nb;  "), server("x", "a;\nb;"))).toBe(true);
  });

  it("detects real differences", () => {
    expect(codeEquals(local("x", "a;"), server("x", "b;"))).toBe(false);
  });
});

describe("buildSyncPlan", () => {
  it("classifies entries and sorts by name", () => {
    const plan = buildSyncPlan(
      [local("same", "a;"), local("changed", "new;"), local("onlyLocal", "l;")],
      [server("same", "a;"), server("changed", "old;"), server("onlyServer", "s;")],
    );
    expect(plan.map((e) => [e.actionName, e.status])).toEqual([
      ["changed", "modified"],
      ["onlyLocal", "localOnly"],
      ["onlyServer", "serverOnly"],
      ["same", "unchanged"],
    ]);
  });
});

describe("serverDees / localActionName", () => {
  it("uses the effective version per name with defaulted bodies, and flags draft/disabled rows (GitHub #7)", () => {
    const { list, byName } = serverDees([
      { Name: "A", IsEnabled: true, UniversalState: 2, Version: 2, ActionCode: "newer draft;" },
      { Name: "A", IsEnabled: true, UniversalState: 3, Version: 1, ActionCode: "a;" },
      { Name: "B", IsEnabled: false, UniversalState: 3 },
      { Name: "C", IsEnabled: true, UniversalState: 2, Version: 1 },
    ]);
    expect(list).toEqual([
      { actionName: "A", actionCode: "a;", validationCode: "", effective: true, enabled: true },
      { actionName: "B", actionCode: "", validationCode: "", effective: true, enabled: false },
      { actionName: "C", actionCode: "", validationCode: "", effective: false, enabled: true },
    ]);
    expect(byName.get("A")!.Version).toBe(1);
  });

  it("maps sanitized file names back to real action names", () => {
    expect(localActionName("A_B.cs", ["A/B", "Other"])).toBe("A/B");
    expect(localActionName("Plain.cs", ["Other"])).toBe("Plain");
  });
});

describe("uploadPayload (GitHub #8)", () => {
  it("echoes an existing entity with the local bodies on top", () => {
    const existing = { Id: "7", Name: "X", IsEnabled: false, UniversalState: 3, ActionCode: "old;", Classification: "T" };
    expect(uploadPayload(existing, local("X", "new;", "v;"))).toEqual({
      ...existing,
      ActionCode: "new;",
      ValidationCode: "v;",
    });
  });

  it("creates a NEW action enabled, with the local bodies (a missing IsEnabled would be false on the host)", () => {
    const payload = uploadPayload(undefined, local("Fresh", "body;", ""));
    expect(payload.IsEnabled).toBe(true);
    expect(payload.Id).toBeUndefined();
    expect(payload.ActionCode).toBe("body;");
    expect(payload.ActionCode).not.toBe(NEW_ACTION_CODE_TEMPLATE);
    expect(payload.ValidationCode).toBe("return true;");
    expect(payload.Description).toBe("");
  });
});
