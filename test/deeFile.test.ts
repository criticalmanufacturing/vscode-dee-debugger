import { describe, expect, it } from "vitest";
import {
  actionFileName,
  extractBodies,
  GENERATED_MARKERS,
  LEGACY_MARKERS,
  markerPositions,
  replaceBodies,
  validateMarkers,
} from "../src/core/deeFile";

const generatedFile = (actionBody: string, validationBody: string): string =>
  [
    "using System;",
    "using System.Collections.Generic;",
    "",
    "namespace Cmf.Foundation.Common.DynamicExpressionEvaluator.Runtime",
    "{",
    "    public class RuleEvaluator_QWJj : Cmf.Foundation.Common.DynamicExecutionEngine.RuleEvaluatorAdapter",
    "    {",
    "        public override Dictionary<string, Object> EvaluateRule(Dictionary<string, Object> Input)",
    "        {",
    `            ${GENERATED_MARKERS.actionStart}`,
    ...(actionBody ? actionBody.split("\n") : []),
    `            ${GENERATED_MARKERS.actionEnd}`,
    "            return Input;",
    "        }",
    "        public override Boolean ValidateAction(Dictionary<string, Object> Input)",
    "        {",
    `            ${GENERATED_MARKERS.validationStart}`,
    ...(validationBody ? validationBody.split("\n") : []),
    `            ${GENERATED_MARKERS.validationEnd}`,
    "        }",
    "    }",
    "}",
  ].join("\n");

describe("validateMarkers", () => {
  it("accepts a well-formed generated file", () => {
    expect(validateMarkers(generatedFile("var x = 1;", "return true;"))).toEqual([]);
  });

  it("reports a file without markers", () => {
    expect(validateMarkers("public class Foo {}")).toHaveLength(1);
  });

  it("reports missing and duplicated markers", () => {
    const text = generatedFile("code", "return true;").replace(GENERATED_MARKERS.actionEnd, "");
    expect(validateMarkers(text).some((i) => i.includes("action code end"))).toBe(true);

    const dup = generatedFile("code", "return true;") + "\n" + GENERATED_MARKERS.actionStart;
    expect(validateMarkers(dup).some((i) => i.includes("Duplicated"))).toBe(true);
  });

  it("matches markers whole-line after trim only", () => {
    const inline = generatedFile("code", "return true;").replace(
      GENERATED_MARKERS.actionStart,
      `${GENERATED_MARKERS.actionStart} // trailing comment`,
    );
    expect(validateMarkers(inline).some((i) => i.includes("action code start"))).toBe(true);
  });
});

describe("extractBodies", () => {
  it("round-trips both bodies", () => {
    const bodies = extractBodies(generatedFile("var x = 1;\nreturn Input;", "return true;"));
    expect(bodies.dialect).toBe("generated");
    expect(bodies.actionCode).toBe("var x = 1;\nreturn Input;");
    expect(bodies.validationCode).toBe("return true;");
  });

  it("round-trips empty bodies as empty strings (old tool crashed here)", () => {
    const bodies = extractBodies(generatedFile("", ""));
    expect(bodies.actionCode).toBe("");
    expect(bodies.validationCode).toBe("");
  });

  it("handles CRLF files", () => {
    const bodies = extractBodies(generatedFile("var a = 2;", "return true;").replace(/\n/g, "\r\n"));
    expect(bodies.actionCode).toBe("var a = 2;");
  });

  it("supports the legacy cmf-cli dialect", () => {
    const text = [
      "public class MyDee : DeeDevBase",
      "{",
      LEGACY_MARKERS.validationStart,
      "return true;",
      LEGACY_MARKERS.validationEnd,
      LEGACY_MARKERS.actionStart,
      "Input[\"x\"] = 1;",
      LEGACY_MARKERS.actionEnd,
      "}",
    ].join("\n");
    const bodies = extractBodies(text);
    expect(bodies.dialect).toBe("legacy");
    expect(bodies.actionCode).toBe('Input["x"] = 1;');
    expect(bodies.validationCode).toBe("return true;");
  });
});

describe("markerPositions", () => {
  it("locates body start lines for diagnostics mapping", () => {
    const text = generatedFile("line1\nline2", "return true;");
    const pos = markerPositions(text);
    const lines = text.split("\n");
    expect(lines[pos.actionBodyStart]).toBe("line1");
    expect(lines[pos.validationBodyStart]).toBe("return true;");
  });
});

describe("replaceBodies", () => {
  it("swaps bodies and preserves the wrapper", () => {
    const original = generatedFile("old;", "return false;");
    const updated = replaceBodies(original, "new1;\nnew2;", "return true;");
    const bodies = extractBodies(updated);
    expect(bodies.actionCode).toBe("new1;\nnew2;");
    expect(bodies.validationCode).toBe("return true;");
    expect(updated).toContain("RuleEvaluator_QWJj");
  });

  it("can empty a body", () => {
    const updated = replaceBodies(generatedFile("old;", "return true;"), "", "return true;");
    expect(extractBodies(updated).actionCode).toBe("");
  });
});

describe("actionFileName", () => {
  it("sanitizes characters invalid in file names", () => {
    expect(actionFileName("A/B:C")).toBe("A_B_C.cs");
    expect(actionFileName("Plain")).toBe("Plain.cs");
  });
});
