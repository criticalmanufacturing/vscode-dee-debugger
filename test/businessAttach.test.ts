import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUSINESS_SOURCE_MAP,
  resolveBusinessSourceMap,
  shouldWarnUnboundBreakpoints,
  UNBOUND_BREAKPOINT_CAUSES,
  unboundBreakpointCount,
} from "../src/core/businessAttach";

describe("resolveBusinessSourceMap (default /src map for container-built PDBs; custom maps verbatim)", () => {
  it("falls back to the validated default when unset/empty", () => {
    for (const input of [undefined, {}]) {
      const { sourceFileMap, isDefault } = resolveBusinessSourceMap(input);
      expect(sourceFileMap).toEqual({ "/src": "${workspaceFolder}" });
      expect(isDefault).toBe(true);
    }
    expect(DEFAULT_BUSINESS_SOURCE_MAP).toEqual({ "/src": "${workspaceFolder}" });
  });

  it("honors a configured map and reports it is NOT the default", () => {
    const configured = { "/src": "${workspaceFolder}/.." };
    const { sourceFileMap, isDefault } = resolveBusinessSourceMap(configured);
    expect(sourceFileMap).toEqual(configured);
    expect(isDefault).toBe(false);
  });

  it("returns a fresh copy — never the frozen default or the caller's object", () => {
    const configured = { "/src": "/x" };
    expect(resolveBusinessSourceMap(configured).sourceFileMap).not.toBe(configured);
    expect(resolveBusinessSourceMap({}).sourceFileMap).not.toBe(DEFAULT_BUSINESS_SOURCE_MAP);
  });
});

describe("unbound-breakpoint feedback (UX-3)", () => {
  it("counts only breakpoints without a bind signal", () => {
    expect(unboundBreakpointCount(["a", "b", "c"], new Set(["b"]))).toBe(2);
    expect(unboundBreakpointCount(["a"], new Set(["a"]))).toBe(0);
  });

  it("warns only when breakpoints exist and NONE bound", () => {
    expect(shouldWarnUnboundBreakpoints(["a", "b"], new Set())).toBe(true);
    expect(shouldWarnUnboundBreakpoints(["a", "b"], new Set(["a"]))).toBe(false); // one bound → quiet
    expect(shouldWarnUnboundBreakpoints([], new Set())).toBe(false); // no breakpoints → quiet
  });

  it("names the three documented causes, redeploy first", () => {
    expect(UNBOUND_BREAKPOINT_CAUSES).toHaveLength(3);
    expect(UNBOUND_BREAKPOINT_CAUSES[0]).toMatch(/redeploy|cmf dev local stack up/i);
    expect(UNBOUND_BREAKPOINT_CAUSES.join(" ")).toMatch(/portable/i);
    expect(UNBOUND_BREAKPOINT_CAUSES.join(" ")).toMatch(/hostSourceMap/);
  });
});

describe("UNBOUND_BREAKPOINT_CAUSES wording (doc review 2026-10-18)", () => {
  it("never sends business-PDB problems to the host patch, which only affects DEE compiles", () => {
    const pdbCause = UNBOUND_BREAKPOINT_CAUSES.find((c) => /portable/i.test(c))!;
    expect(pdbCause).toMatch(/Rebuild with portable PDBs/);
    expect(pdbCause).not.toMatch(/run it through tools\/host-pdb-patcher/);
  });
});

describe("source-map cause wording (cmf-cli check 2026-10-19)", () => {
  it("explains recorded build paths instead of a /src convention, and says a local cmf build needs no map", () => {
    const mapCause = UNBOUND_BREAKPOINT_CAUSES[2]!;
    expect(mapCause).toMatch(/recorded in the PDB/);
    expect(mapCause).toMatch(/local `cmf build` records your own absolute paths/);
    expect(mapCause).not.toMatch(/sub-folder/);
  });
});
