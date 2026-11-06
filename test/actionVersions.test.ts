import { describe, expect, it } from "vitest";
import {
  canMakeEffective,
  draftExecutionNote,
  isDraftVersion,
  knownClassifications,
  NEW_ACTION_CODE_TEMPLATE,
  NEW_ACTION_VALIDATION_CODE,
  newActionPayload,
  selectActionsByName,
  stateName,
  validateActionName,
} from "../src/core/actionVersions";
import { DeeAction, UniversalState } from "../src/core/types";

const a = (name: string, extra: Partial<DeeAction> = {}): DeeAction => ({ Name: name, IsEnabled: true, ...extra });

describe("selectActionsByName (GitHub #7 — the host's representative-version rule)", () => {
  it("keeps a draft-only action (the MES UI wizard creates v1 Active, not Effective)", () => {
    const byName = selectActionsByName([a("New", { Version: 1, UniversalState: UniversalState.Active })]);
    expect(byName.get("New")?.Version).toBe(1);
  });

  it("prefers the Effective version regardless of order or version number", () => {
    const byName = selectActionsByName([
      a("X", { Version: 3, UniversalState: UniversalState.Active }),
      a("X", { Version: 2, UniversalState: "Effective" }),
      a("X", { Version: 1, UniversalState: UniversalState.Terminated }),
    ]);
    expect(byName.get("X")?.Version).toBe(2);
  });

  it("falls back to the highest live (non-Terminated) version, then to the highest at all", () => {
    expect(
      selectActionsByName([
        a("Y", { Version: 1, UniversalState: UniversalState.Active }),
        a("Y", { Version: 4, UniversalState: UniversalState.Terminated }),
        a("Y", { Version: 2, UniversalState: UniversalState.Frozen }),
      ]).get("Y")?.Version,
    ).toBe(2);
    expect(
      selectActionsByName([
        a("Z", { Version: 1, UniversalState: UniversalState.Terminated }),
        a("Z", { Version: 2, UniversalState: UniversalState.Terminated }),
      ]).get("Z")?.Version,
    ).toBe(2);
  });

  it("ignores rows without a name and tolerates missing Version/State", () => {
    const byName = selectActionsByName([{ Name: "" } as DeeAction, a("Bare")]);
    expect([...byName.keys()]).toEqual(["Bare"]);
  });
});

describe("state helpers", () => {
  it("names numeric and string states", () => {
    expect(stateName(3)).toBe("Effective");
    expect(stateName("Active")).toBe("Active");
    expect(stateName(undefined)).toBe("unknown");
  });

  it("draft = anything not effective; only Active can be promoted", () => {
    expect(isDraftVersion(a("x", { UniversalState: UniversalState.Effective }))).toBe(false);
    expect(isDraftVersion(a("x", { UniversalState: UniversalState.Active }))).toBe(true);
    expect(isDraftVersion(a("x"))).toBe(true);
    expect(canMakeEffective(a("x", { UniversalState: UniversalState.Active }))).toBe(true);
    expect(canMakeEffective(a("x", { UniversalState: "Active" }))).toBe(true);
    expect(canMakeEffective(a("x", { UniversalState: UniversalState.Frozen }))).toBe(false);
    expect(canMakeEffective(a("x", { UniversalState: UniversalState.Effective }))).toBe(false);
  });
});

describe("validateActionName (host regex ^[a-zA-Z][a-zA-Z0-9_]*$, 100 chars, unique)", () => {
  it("accepts identifiers and rejects what the host would reject", () => {
    expect(validateActionName("MyAction_2")).toBeUndefined();
    expect(validateActionName("")).toMatch(/required/);
    expect(validateActionName("2fast")).toMatch(/identifier/);
    expect(validateActionName("Has Space")).toMatch(/identifier/);
    expect(validateActionName("Dotted.Name")).toMatch(/identifier/);
    expect(validateActionName("a".repeat(101))).toMatch(/100/);
  });

  it("rejects names already on the MES, case-insensitively", () => {
    expect(validateActionName("dup", ["Dup"])).toMatch(/already exists/);
    expect(validateActionName("fresh", ["Dup"])).toBeUndefined();
  });
});

describe("newActionPayload (GitHub #8)", () => {
  it("is enabled, uses the MES UI starter template, and never sends null strings", () => {
    const payload = newActionPayload({ name: " Fresh " });
    expect(payload).toEqual({
      Name: "Fresh",
      Description: "",
      Classification: "",
      IsEnabled: true,
      ActionCode: NEW_ACTION_CODE_TEMPLATE,
      ValidationCode: NEW_ACTION_VALIDATION_CODE,
    });
    expect(NEW_ACTION_CODE_TEMPLATE).toContain("//Please start code here");
  });

  it("keeps caller-provided bodies and metadata; blank validation falls back to 'return true;'", () => {
    const payload = newActionPayload({
      name: "X",
      description: "d",
      classification: "Tenant",
      actionCode: "Input[\"a\"] = 1;",
      validationCode: "   ",
    });
    expect(payload.Description).toBe("d");
    expect(payload.Classification).toBe("Tenant");
    expect(payload.ActionCode).toBe("Input[\"a\"] = 1;");
    expect(payload.ValidationCode).toBe("return true;");
  });
});

describe("knownClassifications", () => {
  it("returns distinct, trimmed, sorted values", () => {
    expect(knownClassifications([a("1", { Classification: "B " }), a("2", { Classification: "A" }), a("3"), a("4", { Classification: "B" })])).toEqual([
      "A",
      "B",
    ]);
  });
});

describe("draftExecutionNote (host rule: Effective if any, else the highest version — verified live)", () => {
  it("says a draft runs when no version is effective, and why to promote it anyway", () => {
    const note = draftExecutionNote(1, undefined);
    expect(note).toMatch(/already runs its highest version \(v1\)/);
    expect(note).toMatch(/staged later cannot take over/);
  });
  it("says the effective version keeps running while a staged draft exists", () => {
    expect(draftExecutionNote(3, 2)).toBe("The MES keeps running v2 (effective) until v3 is made effective.");
  });
});
