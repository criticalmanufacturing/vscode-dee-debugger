/**
 * .NET runtime detection + mismatch reasoning (pure, host-agnostic — no `vscode`, no I/O).
 * The aligned runtime tracks the MES line: v10 hosts run .NET 6, v11 → .NET 8, v12 → .NET 10. If a
 * developer builds their `Cmf.Custom.*` assemblies against a different major than the host
 * actually runs, redeployed DLLs may fail to load or debug — so we detect the host's runtime
 * major and compare it with the local project's target framework. The VS Code layer supplies
 * the raw `dotnet --list-runtimes` output and the csproj text; the parsing/decision is here.
 */

/**
 * Highest `Microsoft.NETCore.App` major from `dotnet --list-runtimes` output, e.g.
 *   Microsoft.NETCore.App 8.0.24 [/usr/lib64/dotnet/shared/Microsoft.NETCore.App]
 * Returns undefined when no runtime line is present.
 */
export function parseHostRuntimeMajor(listRuntimesStdout: string | undefined | null): number | undefined {
  if (!listRuntimesStdout) return undefined;
  let max: number | undefined;
  for (const m of listRuntimesStdout.matchAll(/Microsoft\.NETCore\.App\s+(\d+)\.\d+/g)) {
    const major = Number(m[1]);
    if (Number.isFinite(major) && (max === undefined || major > max)) max = major;
  }
  return max;
}

/**
 * Runtime major from a project's target framework (`<TargetFramework>net8.0</TargetFramework>`
 * or the first entry of `<TargetFrameworks>net8.0;…`). Only `net<major>.<minor>` counts —
 * `netstandard*` / `netframework` have no single runtime major and return undefined (the DEE
 * Actions project is typically netstandard; business projects carry the runtime TFM).
 */
export function parseProjectTfmMajor(csprojXml: string | undefined | null): number | undefined {
  if (!csprojXml) return undefined;
  const single = /<TargetFramework>\s*([^<]+?)\s*<\/TargetFramework>/i.exec(csprojXml);
  const multi = /<TargetFrameworks>\s*([^<]+?)\s*<\/TargetFrameworks>/i.exec(csprojXml);
  const tfms = (single?.[1] ?? multi?.[1] ?? "").split(";").map((t) => t.trim()).filter(Boolean);
  for (const tfm of tfms) {
    const m = /^net(\d+)\.\d+$/i.exec(tfm); // net8.0, net10.0 — not netstandard/netcoreapp/net4x
    if (m) return Number(m[1]);
  }
  return undefined;
}

export interface DotnetMismatch {
  mismatch: boolean;
  hostMajor?: number;
  expectedMajor?: number;
  message?: string;
}

/**
 * Compare the host runtime major with the expected (project/configured) major. Only reports a
 * mismatch when BOTH are known and differ — unknowns are silent (never a false alarm).
 */
export function describeDotnetMismatch(
  hostMajor: number | undefined,
  expectedMajor: number | undefined,
): DotnetMismatch {
  if (hostMajor === undefined || expectedMajor === undefined || hostMajor === expectedMajor) {
    return { mismatch: false, hostMajor, expectedMajor };
  }
  return {
    mismatch: true,
    hostMajor,
    expectedMajor,
    message:
      `The MES host runs .NET ${hostMajor}, but your customization targets .NET ${expectedMajor}. ` +
      `Rebuilt Cmf.Custom.* DLLs may not load or debug against a different runtime major — ` +
      `align your target framework with the host's MES line (v10 → net6.0, v11 → net8.0, v12 → net10.0).`,
  };
}
