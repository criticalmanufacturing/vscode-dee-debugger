/**
 * Builds the DEE Explorer hierarchy from the flat GetAllActionGroups/GetAllActions results.
 *
 * Action-group names are dot-delimited paths ("Rule.RuleOrchestration.CreateRule.Pre") that
 * expand into nested group nodes. Actions attach to the node whose *full dotted name* matches
 * one of their ActionGroupActions[].ActionGroup.Name; an action in N groups appears N times,
 * as N DISTINCT ActionRef instances — VS Code's TreeView contract allows an element to appear
 * at most once, so attachments must never share one ref (M4). Actions with no group
 * membership go under the root.
 *
 * Visibility (GitHub #7): every action name the host reports is shown — including ones whose
 * only version is a not-yet-effective draft (the state is a badge, not a filter; ADR 0011).
 * Disabled actions are the one thing hidden by default, and the tree reports how many so the
 * explorer can offer to reveal them.
 */

import { selectActionsByName } from "./actionVersions";
import { DeeAction, DeeActionGroup } from "./types";

export interface ActionRef {
  action: DeeAction;
  /**
   * Full dotted path of the group this ref hangs under (undefined = root). Combined with
   * the action name it uniquely identifies the tree row for TreeItem.id.
   */
  groupPath?: string;
}

export interface GroupNode {
  /** Last dot-segment, e.g. "CreateRule". */
  name: string;
  /** Full dotted path of this node, e.g. "Rule.RuleOrchestration.CreateRule". */
  fullName: string;
  groups: GroupNode[];
  actions: ActionRef[];
}

export interface TreeFilter {
  /** Include disabled actions (default false). Draft (non-effective) versions are always shown. */
  includeDisabled?: boolean;
  /** Case-insensitive substring filter on action names (applied to actions only). */
  search?: string;
}

export interface ActionTree {
  root: GroupNode;
  /** All distinct actions that made it into the tree, by name. */
  actionsByName: Map<string, ActionRef>;
  /** Disabled actions dropped because includeDisabled was off (search still applied). */
  hiddenDisabled: number;
}

export function buildActionTree(
  groups: DeeActionGroup[],
  actions: DeeAction[],
  filter: TreeFilter = {},
): ActionTree {
  const root: GroupNode = { name: "All Actions", fullName: "", groups: [], actions: [] };
  const byPath = new Map<string, GroupNode>();

  for (const group of groups) {
    if (!group?.Name) continue;
    const parts = group.Name.split(".");
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join(".");
      if (byPath.has(path)) continue;
      const node: GroupNode = { name: parts[i]!, fullName: path, groups: [], actions: [] };
      byPath.set(path, node);
      const parentPath = parts.slice(0, i).join(".");
      (i === 0 ? root : byPath.get(parentPath)!).groups.push(node);
    }
  }

  // One row per action name — the host's own representative version (effective, else the
  // highest live one), never "first occurrence wins".
  const actionsByName = new Map<string, ActionRef>();
  const search = filter.search?.toLowerCase();
  let hiddenDisabled = 0;
  for (const action of selectActionsByName(actions).values()) {
    if (search && !action.Name.toLowerCase().includes(search)) continue;
    if (!filter.includeDisabled && action.IsEnabled === false) {
      hiddenDisabled++;
      continue;
    }
    const ref: ActionRef = { action };
    actionsByName.set(action.Name, ref);

    // A distinct ActionRef per group attachment (M4) — the lookup map keeps the first
    // (group-less) ref; duplicate memberships of the same group attach only once.
    const attachedTo = new Set<string>();
    for (const aga of action.ActionGroupActions ?? []) {
      const groupName = aga?.ActionGroup?.Name;
      const node = groupName ? byPath.get(groupName) : undefined;
      if (node && !attachedTo.has(node.fullName)) {
        attachedTo.add(node.fullName);
        node.actions.push({ action, groupPath: node.fullName });
      }
    }
    if (attachedTo.size === 0) root.actions.push(ref);
  }

  sortNode(root);
  for (const node of byPath.values()) sortNode(node);
  if (search) pruneEmptyGroups(root);
  return { root, actionsByName, hiddenDisabled };
}

function sortNode(node: GroupNode): void {
  node.groups.sort((a, b) => a.name.localeCompare(b.name));
  node.actions.sort((a, b) => a.action.Name.localeCompare(b.action.Name));
}

function pruneEmptyGroups(node: GroupNode): boolean {
  node.groups = node.groups.filter((child) => pruneEmptyGroups(child));
  return node.groups.length > 0 || node.actions.length > 0;
}
