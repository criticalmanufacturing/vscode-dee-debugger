import { newActionPayload, selectActionsByName } from "./actionVersions";
import { actionFileName } from "./deeFile";
import { DeeAction, isEffective } from "./types";

/**
 * Diff between local DEE files and the actions on the server, for the sync feature.
 * Comparison is on the marker bodies only (the wrapper is server-generated), with
 * normalization of line endings and trailing whitespace so cosmetic differences
 * don't show up as changes.
 */

export interface DeeCodePair {
  actionCode: string;
  validationCode: string;
}

export interface LocalDeeFile extends DeeCodePair {
  actionName: string;
  filePath: string;
}

export interface ServerDee extends DeeCodePair {
  actionName: string;
  /** False when the version the host reports is a draft (not what the MES executes). */
  effective: boolean;
  enabled: boolean;
}

export type SyncStatus = "unchanged" | "modified" | "localOnly" | "serverOnly";

export interface SyncEntry {
  actionName: string;
  status: SyncStatus;
  local?: LocalDeeFile;
  server?: ServerDee;
}

export function normalizeCode(code: string): string {
  return code
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

export function codeEquals(a: DeeCodePair, b: DeeCodePair): boolean {
  return (
    normalizeCode(a.actionCode) === normalizeCode(b.actionCode) &&
    normalizeCode(a.validationCode) === normalizeCode(b.validationCode)
  );
}

/**
 * Server side of a sync: one row per action name using the same representative-version
 * rule as the tree (effective, else highest live version — GitHub #7: a freshly created
 * action is Active v1 and must still take part in compare/upload/download), with bodies
 * defaulted to empty strings. Disabled actions are included: sync mirrors code, and a
 * disabled action's code is still code worth versioning (R6: eligibility rules in core).
 */
export function serverDees(actions: DeeAction[]): { list: ServerDee[]; byName: Map<string, DeeAction> } {
  const byName = selectActionsByName(actions);
  const list = [...byName.values()].map((a) => ({
    actionName: a.Name,
    actionCode: a.ActionCode ?? "",
    validationCode: a.ValidationCode ?? "",
    effective: isEffective(a.UniversalState),
    enabled: a.IsEnabled !== false,
  }));
  return { list, byName };
}

/**
 * Map a local file's base name back to the real action name: server names can contain
 * characters that were sanitized when the file was written.
 */
export function localActionName(fileBaseName: string, serverNames: Iterable<string>): string {
  for (const name of serverNames) {
    if (actionFileName(name) === fileBaseName) return name;
  }
  return fileBaseName.replace(/\.cs$/, "");
}

export function buildSyncPlan(local: LocalDeeFile[], server: ServerDee[]): SyncEntry[] {
  const byName = new Map<string, SyncEntry>();
  for (const file of local) {
    byName.set(file.actionName, { actionName: file.actionName, status: "localOnly", local: file });
  }
  for (const dee of server) {
    const entry = byName.get(dee.actionName);
    if (!entry) {
      byName.set(dee.actionName, { actionName: dee.actionName, status: "serverOnly", server: dee });
    } else {
      entry.server = dee;
      entry.status = codeEquals(entry.local!, dee) ? "unchanged" : "modified";
    }
  }
  return [...byName.values()].sort((a, b) => a.actionName.localeCompare(b.actionName));
}

/**
 * Entity to send to CompileAndSave for one plan entry. An existing action is echoed back
 * with the local bodies (keeps its concurrency token and flags); a local-only entry becomes
 * a CREATE payload — explicitly enabled, because the host reads a missing IsEnabled as
 * false (GitHub #8: uploads of new local DEEs used to create disabled, invisible actions).
 */
export function uploadPayload(existing: DeeAction | undefined, entry: LocalDeeFile): DeeAction {
  if (existing) {
    return { ...existing, ActionCode: entry.actionCode, ValidationCode: entry.validationCode };
  }
  return newActionPayload({
    name: entry.actionName,
    actionCode: entry.actionCode,
    validationCode: entry.validationCode,
  });
}
