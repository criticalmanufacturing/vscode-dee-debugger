import { describe, expect, it } from "vitest";
import { buildActionTree } from "../src/core/treeModel";
import { DeeAction, DeeActionGroup, UniversalState } from "../src/core/types";

const group = (name: string): DeeActionGroup => ({ Name: name });
const action = (name: string, groups: string[] = [], extra: Partial<DeeAction> = {}): DeeAction => ({
  Name: name,
  IsEnabled: true,
  UniversalState: UniversalState.Effective,
  ActionGroupActions: groups.map((g) => ({ ActionGroup: { Name: g } })),
  ...extra,
});

describe("buildActionTree", () => {
  it("expands dot-delimited group names into a hierarchy", () => {
    const tree = buildActionTree([group("Rule.RuleOrchestration.CreateRule.Pre")], []);
    const rule = tree.root.groups[0]!;
    expect(rule.name).toBe("Rule");
    expect(rule.groups[0]!.name).toBe("RuleOrchestration");
    expect(rule.groups[0]!.groups[0]!.name).toBe("CreateRule");
    expect(rule.groups[0]!.groups[0]!.groups[0]!.fullName).toBe("Rule.RuleOrchestration.CreateRule.Pre");
  });

  it("merges sibling groups sharing a prefix", () => {
    const tree = buildActionTree([group("A.B"), group("A.C")], []);
    expect(tree.root.groups).toHaveLength(1);
    expect(tree.root.groups[0]!.groups.map((g) => g.name)).toEqual(["B", "C"]);
  });

  // M4: VS Code's TreeView contract allows an element to appear at most once — a
  // multi-group action must be N distinct refs, never one shared instance.
  it("attaches actions to their groups by full dotted name with a DISTINCT ref per attachment", () => {
    const tree = buildActionTree([group("A.B"), group("C")], [action("act", ["A.B", "C"])]);
    const inAB = tree.root.groups[0]!.groups[0]!.actions[0]!;
    const inC = tree.root.groups[1]!.actions[0]!;
    expect(inAB).not.toBe(inC);
    expect(inAB.action).toBe(inC.action);
    expect(inAB.groupPath).toBe("A.B");
    expect(inC.groupPath).toBe("C");
    expect(tree.root.actions).toHaveLength(0);
  });

  it("an action in two groups appears once under each group and stays findable by name", () => {
    const tree = buildActionTree([group("A"), group("B")], [action("multi", ["A", "B"])]);
    const inA = tree.root.groups[0]!.actions;
    const inB = tree.root.groups[1]!.actions;
    expect(inA.map((r) => r.action.Name)).toEqual(["multi"]);
    expect(inB.map((r) => r.action.Name)).toEqual(["multi"]);
    expect(inA[0]).not.toBe(inB[0]);
    expect(tree.actionsByName.get("multi")!.action.Name).toBe("multi");
  });

  it("duplicate memberships of the same group attach only once", () => {
    const tree = buildActionTree([group("A")], [action("dup", ["A", "A"])]);
    expect(tree.root.groups[0]!.actions).toHaveLength(1);
  });

  it("puts ungrouped and unknown-group actions under the root", () => {
    const tree = buildActionTree([], [action("loose"), action("ghost", ["Missing.Group"])]);
    expect(tree.root.actions.map((a) => a.action.Name)).toEqual(["ghost", "loose"]);
  });

  // GitHub #7: a DEE whose only version is not yet effective must be visible.
  it("hides only disabled actions by default — draft (non-effective) versions stay visible", () => {
    const tree = buildActionTree(
      [],
      [
        action("on"),
        action("off", [], { IsEnabled: false }),
        action("draft", [], { UniversalState: UniversalState.Active }),
        action("frozen", [], { UniversalState: UniversalState.Frozen }),
        action("effectiveString", [], { UniversalState: "Effective" }),
      ],
    );
    expect([...tree.actionsByName.keys()].sort()).toEqual(["draft", "effectiveString", "frozen", "on"]);
    expect(tree.hiddenDisabled).toBe(1);
  });

  it("includes disabled actions when asked and reports nothing hidden", () => {
    const tree = buildActionTree([], [action("off", [], { IsEnabled: false })], { includeDisabled: true });
    expect(tree.actionsByName.has("off")).toBe(true);
    expect(tree.hiddenDisabled).toBe(0);
  });

  it("does not count search-excluded disabled actions as hidden", () => {
    const tree = buildActionTree([], [action("off", [], { IsEnabled: false }), action("match")], { search: "mat" });
    expect(tree.hiddenDisabled).toBe(0);
  });

  it("represents each name by its effective version, else the highest live version (not first occurrence)", () => {
    const tree = buildActionTree(
      [],
      [
        action("dup", [], { Id: 1, Version: 1, UniversalState: UniversalState.Active }),
        action("dup", [], { Id: 2, Version: 2, UniversalState: UniversalState.Effective }),
        action("drafts", [], { Id: 3, Version: 1, UniversalState: UniversalState.Active }),
        action("drafts", [], { Id: 4, Version: 2, UniversalState: UniversalState.Active }),
      ],
    );
    expect(tree.actionsByName.get("dup")!.action.Id).toBe(2);
    expect(tree.actionsByName.get("drafts")!.action.Id).toBe(4);
  });

  it("search filters actions and prunes empty groups", () => {
    const tree = buildActionTree(
      [group("A"), group("B")],
      [action("match", ["A"]), action("other", ["B"])],
      { search: "mat" },
    );
    expect(tree.root.groups.map((g) => g.name)).toEqual(["A"]);
    expect(tree.actionsByName.has("other")).toBe(false);
  });

  it("sorts groups and actions alphabetically", () => {
    const tree = buildActionTree([group("Z"), group("A")], [action("b"), action("a")]);
    expect(tree.root.groups.map((g) => g.name)).toEqual(["A", "Z"]);
    expect(tree.root.actions.map((a) => a.action.Name)).toEqual(["a", "b"]);
  });
});
