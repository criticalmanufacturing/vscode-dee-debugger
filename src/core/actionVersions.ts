/**
 * Action lifecycle rules shared by the explorer, sync, and the create/make-effective
 * commands (GitHub #7 / #8).
 *
 * Host facts these rules rest on (MES host, `ActionCollection.GetAllAsDataSet`,
 * `Action.InternalCreate`, `ActionCollection.MakeEffective`):
 * - `GetAllActions` already returns at most ONE version per action name: the Effective
 *   version when one exists, otherwise the highest Active version. A brand-new action
 *   (MES UI wizard, `CreateAction`, or `CompileAndSave` with no Id) is created as
 *   **version 1 in state Active — not Effective** — until someone makes it effective.
 * - Which version RUNS is a different rule (`P_ActionLoadExecutableActions`, verified live
 *   2026-10-19): the Effective version if one exists, otherwise the HIGHEST version. So a
 *   draft-only action (just created, v1 Active) already runs; a draft is skipped only while
 *   another version is effective. Corollary: with no effective version, a version staged
 *   later (Save as New Version) takes over immediately — the reason to make one effective.
 * - `MakeActionVersionEffective` only accepts an Active version.
 * - `Action.Name` must match `^[a-zA-Z][a-zA-Z0-9_]*$` (it becomes a C# identifier part)
 *   and is truncated server-side at 100 characters.
 * - A missing `IsEnabled` deserializes to `false` on the host — a created action must
 *   send it explicitly or it is born disabled.
 */

import { DeeAction, isEffective, UniversalState } from "./types";

/** Human-readable state name for numeric or string UniversalState values. */
export function stateName(state: unknown): string {
  if (typeof state === "number") return UniversalState[state] ?? String(state);
  if (typeof state === "string" && state.length > 0) return state;
  return "unknown";
}

function isTerminated(state: unknown): boolean {
  return state === UniversalState.Terminated || state === "Terminated";
}

/**
 * Pick the row to represent each action name. Mirrors the host's own listing rule so
 * the tree matches Administration → DEE Actions: Effective wins; otherwise the highest
 * non-Terminated version; otherwise the highest version at all. Input order is irrelevant.
 */
export function selectActionsByName(actions: DeeAction[]): Map<string, DeeAction> {
  const byName = new Map<string, DeeAction>();
  for (const action of actions) {
    if (!action?.Name) continue;
    const current = byName.get(action.Name);
    if (!current || rank(action) > rank(current)) byName.set(action.Name, action);
  }
  return byName;
}

/** Comparable score: effective > live (non-terminated) > terminated; then version. */
function rank(action: DeeAction): number {
  const tier = isEffective(action.UniversalState) ? 2 : isTerminated(action.UniversalState) ? 0 : 1;
  return tier * 1_000_000 + (action.Version ?? 0);
}

/**
 * Not marked Effective (Active/Created/Frozen). Whether the MES runs it depends on whether
 * another version is effective — see draftExecutionNote.
 */
export function isDraftVersion(action: DeeAction): boolean {
  return !isEffective(action.UniversalState);
}

/**
 * Sentence explaining what a draft version means for execution. `effectiveVersion` is the
 * action's effective version number, or undefined when none is effective (a draft shown as
 * the action's tree row always means none is: the host lists Effective above Active).
 */
export function draftExecutionNote(draftVersion: number | undefined, effectiveVersion: number | undefined): string {
  const v = draftVersion !== undefined ? `v${draftVersion}` : "this version";
  if (effectiveVersion !== undefined && effectiveVersion !== draftVersion) {
    return `The MES keeps running v${effectiveVersion} (effective) until ${v} is made effective.`;
  }
  return `No version is effective, so the MES already runs its highest version (${v}). Make it effective so that a version staged later cannot take over.`;
}

/** Only Active versions can be promoted (host validation in ActionCollection.MakeEffective). */
export function canMakeEffective(action: DeeAction): boolean {
  return action.UniversalState === UniversalState.Active || action.UniversalState === "Active";
}

export const ACTION_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;
export const ACTION_NAME_MAX_LENGTH = 100;

/** Validate a new action name the way the host will; undefined = valid. */
export function validateActionName(name: string, existingNames: Iterable<string> = []): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Name is required.";
  if (!ACTION_NAME_PATTERN.test(trimmed)) {
    return "Use a C# identifier: start with a letter, then letters, digits or underscores (no spaces or dots).";
  }
  if (trimmed.length > ACTION_NAME_MAX_LENGTH) return `Name is longer than ${ACTION_NAME_MAX_LENGTH} characters.`;
  for (const existing of existingNames) {
    if (existing.toLowerCase() === trimmed.toLowerCase()) return `An action named '${existing}' already exists on this MES.`;
  }
  return undefined;
}

/** Same starter body the MES UI "Create DEE Action" wizard writes. */
export const NEW_ACTION_CODE_TEMPLATE = [
  'UseReference("", "Cmf.Foundation.Common.Exceptions");',
  "//Please start code here",
  '//var serviceProvider = (IServiceProvider)Input["ServiceProvider"]; <-- uncomment, if needed',
].join("\n");

/** The host substitutes this itself when the validation body is blank. */
export const NEW_ACTION_VALIDATION_CODE = "return true;";

export interface NewActionSpec {
  name: string;
  description?: string;
  classification?: string;
  actionCode?: string;
  validationCode?: string;
}

/**
 * Payload for creating an action (CreateAction / CompileAndSave without Id). Always sets
 * IsEnabled so the new action is not born disabled, and never sends nulls for the string
 * columns the host copies straight into a DataRow.
 */
export function newActionPayload(spec: NewActionSpec): DeeAction {
  return {
    Name: spec.name.trim(),
    Description: spec.description?.trim() ?? "",
    Classification: spec.classification?.trim() ?? "",
    IsEnabled: true,
    ActionCode: spec.actionCode ?? NEW_ACTION_CODE_TEMPLATE,
    ValidationCode: spec.validationCode?.trim() ? spec.validationCode : NEW_ACTION_VALIDATION_CODE,
  };
}

/** Distinct, sorted classifications in use (for the create-action picker). */
export function knownClassifications(actions: DeeAction[]): string[] {
  const set = new Set<string>();
  for (const action of actions) {
    const value = action.Classification?.trim();
    if (value) set.add(value);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
