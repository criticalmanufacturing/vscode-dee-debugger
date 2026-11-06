import { describe, expect, it } from "vitest";
import { extractServerMessage, mapErrorsToFile, parseHostErrors } from "../src/core/errorMap";
import { markerPositions, GENERATED_MARKERS } from "../src/core/deeFile";

describe("parseHostErrors", () => {
  it("parses scope, line, column and message", () => {
    const errors = parseHostErrors(
      "[Action Code][RuleEvaluator_QWJj.cs] [Line 3,15] Error: The name 'foo' does not exist in the current context",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ scope: "action", relativeLine: 3, column: 15, severity: "error" });
    expect(errors[0]!.message).toContain("'foo' does not exist");
  });

  it("parses Test Condition scope and warnings", () => {
    const errors = parseHostErrors("[Test Condition][f.cs] [Line 1,2] Warning: unused variable");
    expect(errors[0]).toMatchObject({ scope: "validation", relativeLine: 1, severity: "warning" });
  });

  it("parses multi-line payloads", () => {
    const errors = parseHostErrors(
      [
        "[Action Code][f.cs] [Line 1,1] Error: first",
        "",
        "[Test Condition][f.cs] [Line 2,3] Error: second",
      ].join("\n"),
    );
    expect(errors).toHaveLength(2);
  });

  it("falls back to a single unknown-scope error for unstructured messages", () => {
    const errors = parseHostErrors("Something went terribly wrong");
    expect(errors).toEqual([
      { scope: "unknown", message: "Something went terribly wrong", severity: "error" },
    ]);
  });
});

describe("mapErrorsToFile", () => {
  const file = [
    "using System;",
    "class C {",
    "  void A() {",
    `    ${GENERATED_MARKERS.actionStart}`,
    "    var a = 1;", // action body line 1 → file line index 4
    "    var b = 2;", // action body line 2 → file line index 5
    `    ${GENERATED_MARKERS.actionEnd}`,
    "  }",
    "  bool V() {",
    `    ${GENERATED_MARKERS.validationStart}`,
    "    return true;", // validation body line 1 → file line index 10
    `    ${GENERATED_MARKERS.validationEnd}`,
    "  }",
    "}",
  ].join("\n");

  it("maps method-relative lines to absolute file lines", () => {
    const pos = markerPositions(file);
    const mapped = mapErrorsToFile(
      [
        { scope: "action", relativeLine: 2, column: 5, message: "x", severity: "error" },
        { scope: "validation", relativeLine: 1, column: 1, message: "y", severity: "error" },
      ],
      pos,
    );
    expect(mapped[0]!.fileLine).toBe(5);
    expect(mapped[1]!.fileLine).toBe(10);
  });

  it("clamps lines beyond the body to the region end", () => {
    const pos = markerPositions(file);
    const mapped = mapErrorsToFile(
      [{ scope: "action", relativeLine: 99, column: 1, message: "x", severity: "error" }],
      pos,
    );
    expect(mapped[0]!.fileLine).toBe(pos.actionEnd - 1);
  });

  it("leaves unknown-scope errors unmapped", () => {
    const pos = markerPositions(file);
    const mapped = mapErrorsToFile([{ scope: "unknown", message: "x", severity: "error" }], pos);
    expect(mapped[0]!.fileLine).toBeUndefined();
  });
});

describe("extractServerMessage", () => {
  it("prefers Reason.Text and survives a BOM prefix", () => {
    const fault = "﻿" + JSON.stringify({ Message: "outer", Reason: { Text: "[Action Code][f] [Line 1,1] Error: x" } });
    expect(extractServerMessage(fault)).toBe("[Action Code][f] [Line 1,1] Error: x");
  });

  it("falls back through Message and returns raw text for non-JSON", () => {
    expect(extractServerMessage(JSON.stringify({ Message: "boom" }))).toBe("boom");
    expect(extractServerMessage("plain text")).toBe("plain text");
  });
});
