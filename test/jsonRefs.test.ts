import { describe, expect, it } from "vitest";
import { resolveJsonRefs } from "../src/core/jsonRefs";

describe("resolveJsonRefs", () => {
  it("resolves $ref to the same object instance", () => {
    const payload = {
      Actions: [
        { $id: "1", Name: "A", Group: { $id: "2", Name: "G" } },
        { $id: "3", Name: "B", Group: { $ref: "2" } },
      ],
    };
    const resolved = resolveJsonRefs(payload);
    expect(resolved.Actions[1]!.Group).toBe(resolved.Actions[0]!.Group);
    expect((resolved.Actions[1]!.Group as { Name: string }).Name).toBe("G");
  });

  it("removes $id keys and keeps $type", () => {
    const resolved = resolveJsonRefs<Record<string, unknown>>({
      $id: "1",
      $type: "Cmf.Foundation.X",
      Name: "A",
    });
    expect(resolved).not.toHaveProperty("$id");
    expect(resolved["$type"]).toBe("Cmf.Foundation.X");
  });

  it("handles cyclic references without infinite loops", () => {
    const payload = {
      Action: {
        $id: "1",
        Name: "A",
        ActionGroupActions: [{ $id: "2", Action: { $ref: "1" }, ActionGroup: { $id: "3", Name: "G" } }],
      },
    };
    const resolved = resolveJsonRefs(payload);
    expect(resolved.Action.ActionGroupActions[0]!.Action).toBe(resolved.Action);
  });

  it("unwraps Json.NET $values collection wrappers", () => {
    const resolved = resolveJsonRefs<{ Items: unknown }>({
      Items: { $id: "1", $values: [{ $id: "2", Name: "A" }] },
    });
    expect(Array.isArray(resolved.Items)).toBe(true);
    expect((resolved.Items as { Name: string }[])[0]!.Name).toBe("A");
  });

  it("leaves unknown $ref targets untouched", () => {
    const resolved = resolveJsonRefs<{ X: unknown }>({ X: { $ref: "99" } });
    expect(resolved.X).toEqual({ $ref: "99" });
  });
});
