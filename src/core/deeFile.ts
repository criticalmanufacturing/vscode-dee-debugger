/**
 * Codec for DEE .cs files. Two on-disk dialects exist:
 *
 * - "generated": the server-generated wrapper (GetActionFullCode / 12.0 Master Data Export),
 *   delimited by the four /** START|END OF USER-DEFINED [VALIDATION] CODE ... markers.
 * - "legacy": the cmf-cli authoring dialect (class : DeeDevBase) with
 *   //---Start DEE Code--- / //---Start DEE Condition Code--- markers.
 *
 * The markers are the file-format contract with the MES host: matching is whole-line
 * equality after trim. Only the marker-delimited bodies are user data — everything else
 * (usings, class scaffolding) is regenerated server-side on save.
 */

export interface MarkerSet {
  actionStart: string;
  actionEnd: string;
  validationStart: string;
  validationEnd: string;
}

export const GENERATED_MARKERS: MarkerSet = {
  actionStart: "/** START OF USER-DEFINED CODE (DO NOT CHANGE OR DELETE THIS LINE!) **/",
  actionEnd: "/** END OF USER-DEFINED CODE (DO NOT CHANGE OR DELETE THIS LINE!) **/",
  validationStart: "/** START OF USER-DEFINED VALIDATION CODE (DO NOT CHANGE OR DELETE THIS LINE!) **/",
  validationEnd: "/** END OF USER-DEFINED VALIDATION CODE (DO NOT CHANGE OR DELETE THIS LINE!) **/",
};

export const LEGACY_MARKERS: MarkerSet = {
  actionStart: "//---Start DEE Code---",
  actionEnd: "//---End DEE Code---",
  validationStart: "//---Start DEE Condition Code---",
  validationEnd: "//---End DEE Condition Code---",
};

export type DeeDialect = "generated" | "legacy";

export interface DeeBodies {
  actionCode: string;
  validationCode: string;
  dialect: DeeDialect;
}

export interface MarkerPositions {
  dialect: DeeDialect;
  /** 0-based line index of each marker line. */
  actionStart: number;
  actionEnd: number;
  validationStart: number;
  validationEnd: number;
  /** 0-based line index of the first line of each body (== marker line + 1). */
  actionBodyStart: number;
  validationBodyStart: number;
}

export class DeeFileError extends Error {
  constructor(message: string, public readonly issues: string[] = []) {
    super(message);
    this.name = "DeeFileError";
  }
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function findMarkerLines(lines: string[], markers: MarkerSet): Map<keyof MarkerSet, number[]> {
  const hits = new Map<keyof MarkerSet, number[]>();
  for (const key of Object.keys(markers) as (keyof MarkerSet)[]) hits.set(key, []);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    for (const key of Object.keys(markers) as (keyof MarkerSet)[]) {
      if (trimmed === markers[key]) hits.get(key)!.push(index);
    }
  });
  return hits;
}

function detectDialect(lines: string[]): DeeDialect | undefined {
  const generated = findMarkerLines(lines, GENERATED_MARKERS);
  if ([...generated.values()].some((v) => v.length > 0)) return "generated";
  const legacy = findMarkerLines(lines, LEGACY_MARKERS);
  if ([...legacy.values()].some((v) => v.length > 0)) return "legacy";
  return undefined;
}

/**
 * Validate marker integrity. Returns a list of problems (empty = valid).
 * Rules: each of the four markers appears exactly once; start precedes end;
 * the two regions do not overlap.
 */
export function validateMarkers(text: string): string[] {
  const lines = splitLines(text);
  const dialect = detectDialect(lines);
  if (!dialect) return ["No DEE code markers found in the file."];
  const markers = dialect === "generated" ? GENERATED_MARKERS : LEGACY_MARKERS;
  const hits = findMarkerLines(lines, markers);
  const issues: string[] = [];
  const labels: Record<keyof MarkerSet, string> = {
    actionStart: "action code start",
    actionEnd: "action code end",
    validationStart: "validation code start",
    validationEnd: "validation code end",
  };
  for (const key of Object.keys(markers) as (keyof MarkerSet)[]) {
    const count = hits.get(key)!.length;
    if (count === 0) issues.push(`Missing ${labels[key]} marker: "${markers[key]}"`);
    else if (count > 1) issues.push(`Duplicated ${labels[key]} marker (${count} occurrences).`);
  }
  if (issues.length > 0) return issues;
  const pos = {
    actionStart: hits.get("actionStart")![0]!,
    actionEnd: hits.get("actionEnd")![0]!,
    validationStart: hits.get("validationStart")![0]!,
    validationEnd: hits.get("validationEnd")![0]!,
  };
  if (pos.actionStart >= pos.actionEnd) issues.push("Action code start marker appears after its end marker.");
  if (pos.validationStart >= pos.validationEnd) issues.push("Validation code start marker appears after its end marker.");
  const overlaps =
    Math.max(pos.actionStart, pos.validationStart) < Math.min(pos.actionEnd, pos.validationEnd);
  if (issues.length === 0 && overlaps) issues.push("Action and validation code regions overlap.");
  return issues;
}

/** Locate the markers. Throws DeeFileError when the file is not a valid DEE file. */
export function markerPositions(text: string): MarkerPositions {
  const issues = validateMarkers(text);
  if (issues.length > 0) throw new DeeFileError("Invalid DEE file markers.", issues);
  const lines = splitLines(text);
  const dialect = detectDialect(lines)!;
  const markers = dialect === "generated" ? GENERATED_MARKERS : LEGACY_MARKERS;
  const hits = findMarkerLines(lines, markers);
  const actionStart = hits.get("actionStart")![0]!;
  const validationStart = hits.get("validationStart")![0]!;
  return {
    dialect,
    actionStart,
    actionEnd: hits.get("actionEnd")![0]!,
    validationStart,
    validationEnd: hits.get("validationEnd")![0]!,
    actionBodyStart: actionStart + 1,
    validationBodyStart: validationStart + 1,
  };
}

/**
 * Extract the two user-code bodies. Empty bodies are valid and round-trip as "".
 * (The old VS add-in and the host both crashed on empty bodies — do better.)
 */
export function extractBodies(text: string): DeeBodies {
  const pos = markerPositions(text);
  const lines = splitLines(text);
  const slice = (from: number, to: number): string => lines.slice(from, to).join("\n");
  return {
    actionCode: slice(pos.actionBodyStart, pos.actionEnd),
    validationCode: slice(pos.validationBodyStart, pos.validationEnd),
    dialect: pos.dialect,
  };
}

/** Replace the two bodies in an existing DEE file, preserving everything else. */
export function replaceBodies(text: string, actionCode: string, validationCode: string): string {
  const pos = markerPositions(text);
  const lines = splitLines(text);
  const before = lines.slice(0, pos.actionBodyStart);
  const between = lines.slice(pos.actionEnd, pos.validationBodyStart);
  const after = lines.slice(pos.validationEnd);
  const body = (code: string): string[] => (code.length === 0 ? [] : splitLines(code));
  return [...before, ...body(actionCode), ...between, ...body(validationCode), ...after].join("\n");
}

/** Sanitize an action name into a safe file name (actions are stored as <Name>.cs). */
export function actionFileName(actionName: string): string {
  return `${actionName.replace(/[\\/:*?"<>|]/g, "_")}.cs`;
}
