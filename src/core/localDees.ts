/**
 * Where a DEE action's local file lives, and which file is opened, uploaded and debugged
 * (DEE files in subfolders / several Data packages — ADR 0012).
 *
 * Facts this rests on:
 * - The MES host's debug compile reads ONLY the generated markers
 *   (`/** START OF USER-DEFINED CODE … **\/`) from the registered file and REWRITES that file
 *   when its regenerated wrapper differs (host `Compiler`, `ExtractSourceCodeFromFile`).
 *   A cmf-cli `DeeDevBase`-format file (`//---Start DEE Code---`) registered directly would
 *   compile empty bodies and be overwritten — so such a file is never registered or rewritten;
 *   a generated-format working copy is debugged instead.
 * - The cmf-cli Data package ships everything under `DEEs/` except `bin`, `obj`,
 *   `ProcessRules` and `*.csproj` — so working copies must live OUTSIDE the DEE folders.
 *
 * Pure: no `vscode`, no Node APIs. Paths may use `/` or `\`; results keep the input's style.
 */

import { actionFileName } from "./deeFile";

export type LocalDeeFormat = "generated" | "legacy";

/** A parseable DEE file found in one of the DEE folders. */
export interface IndexedDee {
  actionName: string;
  filePath: string;
  format: LocalDeeFormat;
}

/** The working-copy folder at the workspace root (self-ignoring: it carries its own `.gitignore`). */
export const WORKING_COPY_FOLDER = ".dee-debug";
/** Content of the `.gitignore` written into the working-copy folder. */
export const WORKING_COPY_GITIGNORE = "# DEE Debugger working copies — not source, never packaged.\n*\n";

export type LocalFilePlan =
  /** A generated-format file exists: open, upload and debug it in place. */
  | { kind: "inPlace"; editPath: string }
  /**
   * A `DeeDevBase`-format file exists: it stays untouched; a generated working copy (its bodies
   * in the MES wrapper) is opened and debugged. "Write back" copies bodies into `sourcePath`.
   */
  | { kind: "workingCopy"; editPath: string; sourcePath: string }
  /** No local file: create `<primary DEE folder>/<ActionName>.cs`. */
  | { kind: "create"; editPath: string };

function sep(p: string): string {
  return p.includes("\\") && !p.includes("/") ? "\\" : "/";
}

function trimTrailing(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

/** Join path segments using the separator style of `base`. */
export function joinPath(base: string, ...parts: string[]): string {
  const s = sep(base);
  return [trimTrailing(base), ...parts.map((x) => x.replace(/^[\\/]+|[\\/]+$/g, ""))].filter(Boolean).join(s);
}

/**
 * `child` relative to `root` with `/` separators, or undefined when `child` is not inside
 * `root`. Case-insensitive on Windows-style (drive-letter) paths.
 */
export function relativeInside(root: string, child: string): string | undefined {
  const norm = (p: string): string => trimTrailing(p.replace(/\\/g, "/"));
  const windows = /^[a-zA-Z]:/.test(root);
  const r = norm(root);
  const c = norm(child);
  const [rc, cc] = windows ? [r.toLowerCase(), c.toLowerCase()] : [r, c];
  if (cc === rc || !cc.startsWith(`${rc}/`)) return undefined;
  return c.slice(r.length + 1);
}

/** Pick the file to use for an action (see LocalFilePlan). */
export function planLocalFile(
  actionName: string,
  indexed: IndexedDee | undefined,
  primaryFolder: string,
  workspaceRoot: string,
): LocalFilePlan {
  if (indexed?.format === "generated") return { kind: "inPlace", editPath: indexed.filePath };
  if (indexed?.format === "legacy") {
    return { kind: "workingCopy", editPath: workingCopyPath(workspaceRoot, indexed.filePath), sourcePath: indexed.filePath };
  }
  return { kind: "create", editPath: joinPath(primaryFolder, actionFileName(actionName)) };
}

/**
 * Working copy for a source file: the source's workspace-relative path mirrored under
 * `.dee-debug/`, so copies of same-named files in different packages never collide.
 */
export function workingCopyPath(workspaceRoot: string, sourcePath: string): string {
  const rel = relativeInside(workspaceRoot, sourcePath);
  const tail = rel ?? `_external/${sourcePath.replace(/\\/g, "/").split("/").pop() ?? "dee.cs"}`;
  return joinPath(workspaceRoot, WORKING_COPY_FOLDER, ...tail.split("/"));
}

/**
 * Path to register with ActivateDebugMode inside the host: the local file's path relative to
 * `localRoot`, mirrored under `sourcePathInHost`. One `sourceFileMap` entry
 * `{ sourcePathInHost: localRoot }` then maps every subfolder back to the right file.
 * Undefined when the file is outside `localRoot` (caller decides how to fail).
 */
export function hostDebugPath(sourcePathInHost: string, localRoot: string, localPath: string): string | undefined {
  const rel = relativeInside(localRoot, localPath);
  if (rel === undefined) return undefined;
  return `${sourcePathInHost.replace(/\/+$/, "")}/${rel}`;
}

/** Folder part of a POSIX path (host side). */
export function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/**
 * Find the indexed file for an action. Files are matched by their `<ActionName>.cs` name (the
 * convention both cmf-cli and the extension use); several matches are a conflict the caller
 * must report rather than guess.
 */
export function findIndexed(index: IndexedDee[], actionName: string): { match?: IndexedDee; conflicts: IndexedDee[] } {
  const fileName = actionFileName(actionName);
  const hits = index.filter(
    (e) => e.actionName === actionName || e.filePath.replace(/\\/g, "/").split("/").pop() === fileName,
  );
  return hits.length === 1 ? { match: hits[0], conflicts: [] } : { match: undefined, conflicts: hits };
}
