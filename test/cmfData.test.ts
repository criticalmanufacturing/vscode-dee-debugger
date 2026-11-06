import { describe, expect, it } from "vitest";
import { decodeCmfValues } from "../src/core/cmfData";

describe("decodeCmfValues", () => {
  it("decodes a CMFMap into a plain object (live 11.2.5 shape)", () => {
    expect(decodeCmfValues({ $typeCMF: "CMFMap", CMFMapData: [["touched", 1], ["name", "x"]] })).toEqual({
      touched: 1,
      name: "x",
    });
  });

  it("decodes nested maps and arrays", () => {
    const decoded = decodeCmfValues({
      $typeCMF: "CMFMap",
      CMFMapData: [
        ["inner", { $typeCMF: "CMFMap", CMFMapData: [["a", true]] }],
        ["list", [1, { $typeCMF: "CMFMap", CMFMapData: [["b", 2]] }]],
      ],
    });
    expect(decoded).toEqual({ inner: { a: true }, list: [1, { b: 2 }] });
  });

  it("passes through scalars, plain objects and null", () => {
    expect(decodeCmfValues(null)).toBeNull();
    expect(decodeCmfValues(42)).toBe(42);
    expect(decodeCmfValues({ plain: "object" })).toEqual({ plain: "object" });
  });
});
