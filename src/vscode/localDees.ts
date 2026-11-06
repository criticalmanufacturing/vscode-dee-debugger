import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { extractBodies } from "../core/deeFile";
import { localActionName } from "../core/syncPlan";
import { IndexedDee, WORKING_COPY_FOLDER, WORKING_COPY_GITIGNORE } from "../core/localDees";
import { LocalDeeFile } from "../core/syncPlan";

/**
 * Index of the DEE files in every DEE folder (recursively, subfolders included). Shared by
 * open/debug (which file to use for an action) and sync (what to compare). DeeDevBase.cs,
 * build output and the working-copy folder are skipped; unparseable files are logged.
 */
export interface LocalDeeIndex {
  files: (LocalDeeFile & IndexedDee)[];
  skipped: string[];
}

export async function indexLocalDees(
  folders: string[],
  serverNames: string[],
  output: { appendLine(value: string): void },
): Promise<LocalDeeIndex> {
  const files: (LocalDeeFile & IndexedDee)[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const pattern = new vscode.RelativePattern(folder, "**/*.cs");
    const uris = await vscode.workspace.findFiles(pattern, `**/{bin,obj,node_modules,${WORKING_COPY_FOLDER}}/**`);
    for (const uri of uris) {
      if (seen.has(uri.fsPath)) continue;
      seen.add(uri.fsPath);
      const base = path.basename(uri.fsPath);
      if (base === "DeeDevBase.cs") continue;
      try {
        const text = await fs.readFile(uri.fsPath, "utf8");
        const bodies = extractBodies(text);
        files.push({
          actionName: localActionName(base, serverNames),
          filePath: uri.fsPath,
          actionCode: bodies.actionCode,
          validationCode: bodies.validationCode,
          format: bodies.dialect,
        });
      } catch (error) {
        skipped.push(uri.fsPath);
        // L11: per-file skip reason, so "why isn't my file in the plan" is answerable.
        output.appendLine(`[dees] skipped ${path.relative(folder, uri.fsPath) || base}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  return { files, skipped };
}

/** Create the self-ignoring working-copy folder (its own .gitignore, never packaged). */
export async function ensureWorkingCopyFolder(workspaceRoot: string): Promise<void> {
  const dir = path.join(workspaceRoot, WORKING_COPY_FOLDER);
  await fs.mkdir(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  try {
    await fs.access(ignore);
  } catch {
    await fs.writeFile(ignore, WORKING_COPY_GITIGNORE, "utf8");
  }
}
