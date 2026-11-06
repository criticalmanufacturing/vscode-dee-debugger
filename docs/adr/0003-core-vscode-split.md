# ADR 0003 — Platform-agnostic core, thin VS Code adapter

Status: accepted (2026-08-14)

## Context
The goal includes "if possible, also a Visual Studio extension". Duplicating protocol and
file-format logic across two codebases caused drift in the old tooling (client/server had
byte-copied marker parsers with the same bug).

## Decision
All protocol, codec, tree, diff, and error-mapping logic lives in `src/core` with no `vscode`
or direct Node API imports (I/O via injected `FileStore`/`Exec` interfaces), 100% unit-testable.
`src/vscode` only adapts to VS Code APIs. The Visual Studio port, if built, reuses the *spec*
(docs + core test fixtures as contract tests), not the TypeScript.

## Consequences
- Slight indirection cost (injected I/O) — accepted for testability.
- Contract fixtures in `test/fixtures` become the cross-IDE source of truth.

## Amendment (2026-08-15)
The originally envisioned injected `FileStore`/`Exec` interfaces were never built; the
implementation converged on a better split — core exposes **pure argv/payload builders**
(`hostExec.ts` etc.) and the vscode layer owns all process/file I/O (`runCli`, `fs`). The
purity rule stands (enforced by lint: no `vscode` imports in core); `Buffer` usage in core
is explicitly allowed (base64/UTF-8 handling — a portable-in-practice exception, see
engineering review 02's dissent on R8). The contract fixtures promised above were captured
from live MES 11.2.5 on 2026-08-15 (`test/fixtures/` + `test/contracts.test.ts`).
