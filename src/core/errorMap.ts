/**
 * Maps MES host compile errors (returned by CompileAndSave / ValidateAction) to positions
 * in the local DEE file.
 *
 * The host reports errors per scope with line numbers relative to the start of the
 * corresponding method body, formatted like:
 *   [Action Code][<file>] [Line 3,15] Error: The name 'foo' does not exist ...
 *   [Test Condition][<file>] [Line 1,2] Error: ...
 * (format of the host's `Compiler.GetErrorMessage`). Absolute position in our file =
 * body start line + (relative line - 1).
 */

import { MarkerPositions } from "./deeFile";

export type ErrorScope = "action" | "validation" | "unknown";

export interface HostCompileError {
  scope: ErrorScope;
  /** 1-based line relative to the method body, as reported by the host. */
  relativeLine?: number;
  /** 1-based column, as reported by the host. */
  column?: number;
  message: string;
  severity: "error" | "warning";
}

export interface MappedError extends HostCompileError {
  /** 0-based line in the local file, when the scope/line could be resolved. */
  fileLine?: number;
}

const LINE_PATTERN =
  /\[(?<scope>Action Code|Test Condition)\]\s*(?:\[[^\]]*\]\s*)?\[?Line\s+(?<line>\d+)\s*,\s*(?<col>\d+)\]?\s*(?<sev>Error|Warning)?[:\s]*(?<msg>.*)/i;

/** Parse a host error payload (possibly multi-line) into structured errors. */
export function parseHostErrors(message: string): HostCompileError[] {
  const errors: HostCompileError[] = [];
  for (const raw of message.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const match = LINE_PATTERN.exec(line);
    if (match?.groups) {
      errors.push({
        scope: match.groups["scope"]!.toLowerCase() === "action code" ? "action" : "validation",
        relativeLine: Number(match.groups["line"]),
        column: Number(match.groups["col"]),
        severity: match.groups["sev"]?.toLowerCase() === "warning" ? "warning" : "error",
        message: match.groups["msg"]?.trim() || line,
      });
    }
  }
  // Nothing matched the structured format — surface the whole message once.
  if (errors.length === 0 && message.trim().length > 0) {
    errors.push({ scope: "unknown", message: message.trim(), severity: "error" });
  }
  return errors;
}

/**
 * Host error payloads are JSON fault envelopes (often BOM-prefixed — JSON.parse chokes
 * on that) — dig out the human message. Reason.Text carries the compile-error rows.
 */
export function extractServerMessage(details: string): string {
  const cleaned = details.replace(/^﻿/, "");
  try {
    const parsed = JSON.parse(cleaned) as Record<string, any>;
    for (const value of [
      parsed?.["Reason"]?.["Text"],
      parsed?.["Message"],
      parsed?.["message"],
      parsed?.["ExceptionMessage"],
      parsed?.["error"],
    ]) {
      if (typeof value === "string" && value.trim()) return value;
    }
  } catch {
    // not JSON — use as-is
  }
  return cleaned;
}

/** Resolve parsed errors to 0-based lines in the local file. */
export function mapErrorsToFile(errors: HostCompileError[], pos: MarkerPositions): MappedError[] {
  return errors.map((error) => {
    if (error.scope === "unknown" || error.relativeLine === undefined) return { ...error };
    const bodyStart = error.scope === "action" ? pos.actionBodyStart : pos.validationBodyStart;
    const bodyEnd = error.scope === "action" ? pos.actionEnd : pos.validationEnd;
    const fileLine = Math.min(bodyStart + error.relativeLine - 1, Math.max(bodyEnd - 1, bodyStart));
    return { ...error, fileLine };
  });
}
