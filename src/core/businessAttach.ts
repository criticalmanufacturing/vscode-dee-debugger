/**
 * Pure, platform-agnostic helpers for the custom-business half of the unified "Attach
 * Debugger to MES Host" flow (ADR 0008 + ADR 0009 — one command, merged source map).
 * The VS Code layer (src/vscode/commands.ts) supplies the raw configuration
 * and workspace facts; every decision that can be made without `vscode` lives here so it
 * is unit-tested. No `vscode` / Node imports (ADR 0003).
 */

/**
 * Default business map. A portable PDB records each source file's path AT BUILD TIME, and the
 * debugger opens that path. A local `cmf build` records your machine's absolute paths (cmf-cli
 * sets no PathMap — verified on a 11.3.5 project: documents are
 * `/path/to/<project>/Cmf.Custom.Business/...`), so when you debug with the repo at the same
 * path no map is needed. A map is needed only when the recorded root differs from where the
 * source is now: a build in another folder/container, CI, or a `/src` container build (how
 * Critical Manufacturing builds the platform; ADR 0008 §Validation used `PathMap=/src`). This `/src` default covers that
 * last case and is a harmless no-op otherwise. Overridable via `deeDebugger.hostSourceMap`.
 */
export const DEFAULT_BUSINESS_SOURCE_MAP: Readonly<Record<string, string>> = { "/src": "${workspaceFolder}" };

export interface ResolvedBusinessSourceMap {
  /** The map to hand to `buildAttachConfig`. */
  sourceFileMap: Record<string, string>;
  /** True when the built-in default is in effect (the setting was empty/unset). */
  isDefault: boolean;
}

/**
 * Resolve the effective business source map: a non-empty configured map wins; anything
 * empty/undefined falls back to the default. Returning `isDefault` lets the
 * caller log whether the built-in default was used.
 */
export function resolveBusinessSourceMap(
  configured: Record<string, string> | undefined,
): ResolvedBusinessSourceMap {
  if (configured && Object.keys(configured).length > 0) {
    return { sourceFileMap: { ...configured }, isDefault: false };
  }
  return { sourceFileMap: { ...DEFAULT_BUSINESS_SOURCE_MAP }, isDefault: true };
}

/**
 * UX-3: the three likely reasons a business breakpoint stays unbound after attach —
 * surfaced proactively so the user isn't left staring at a hollow breakpoint (user story
 * U4). Ordered most-common-first.
 */
export const UNBOUND_BREAKPOINT_CAUSES: readonly string[] = [
  "The DLL/PDB running in the host is stale — build in Debug (`cmf build --test` or `dotnet build`, which write LocalEnvironment/BusinessTier; a plain Release `cmf build` does not), then `cmf dev local stack up` and re-attach (there is no hot-reload for business code).",
  "The PDB deployed with your Cmf.Custom.* DLL is not portable-format — the Linux debugger reads only portable PDBs. Rebuild with portable PDBs (DebugType portable) and redeploy. (Patch Host for DEE Debugging does not help here: it only changes the symbols the host emits for DEE actions.)",
  "The source paths recorded in the PDB don't exist on this machine — the DLL was built in another folder, container or on CI. Map that build root to your repo with `deeDebugger.hostSourceMap`, e.g. { \"/path/used/at/build\": \"${workspaceFolder}\" }. (A local `cmf build` records your own absolute paths, which need no map.)",
];

/**
 * How many of the currently-set source breakpoints never produced a bind signal
 * (an `onDidChangeBreakpoints` "changed" event) within the grace window. `boundIds`
 * is the set of breakpoint ids observed changing after attach; a bound breakpoint
 * reports a resolved location, which surfaces as a change event.
 */
export function unboundBreakpointCount(sourceBreakpointIds: string[], boundIds: Set<string>): number {
  return sourceBreakpointIds.filter((id) => !boundIds.has(id)).length;
}

/**
 * UX-3 decision: warn only when the user actually set source breakpoints and none of them
 * showed a bind signal — otherwise stay quiet (no breakpoints, or at least one bound).
 */
export function shouldWarnUnboundBreakpoints(sourceBreakpointIds: string[], boundIds: Set<string>): boolean {
  return sourceBreakpointIds.length > 0 && unboundBreakpointCount(sourceBreakpointIds, boundIds) === sourceBreakpointIds.length;
}
