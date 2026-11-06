# ADR 0009 — One unified "Attach to MES Host" for DEE and custom-business debugging

Status: **accepted** (2026-08-15) — supersedes ADR 0008 §Resolution R2

## Context
ADR 0008 accepted custom-business debugging and (R2) shipped it as a **second, sibling
command** (`deeDebugger.attachToHost` = "Attach to MES Host (Custom Business)…") beside the
DEE attach (`deeDebugger.attach`). Both commands do the *same* operation — attach the stock
`coreclr` debugger to the *same* MES host process — and differ only in which `sourceFileMap`
entries they pass:

- DEE attach → `{ <sourcePathInHost> : <DEEs folder> }` (actions the host compiles from your
  local file while Debug Mode is on).
- Business attach → `{ "/src" : <repo root> }` (deployed `Cmf.Custom.*` DLLs).

Two commands for one operation is exactly the collision the UX review flagged, and it forces
the user to pick the "right" attach before they know which breakpoints they'll set.

## Decision
Collapse the two into **one command** — `deeDebugger.attach` = **"Attach Debugger to MES
Host"** — that attaches once with a **merged `sourceFileMap`** containing *both* maps:

```jsonc
"sourceFileMap": {
  "/tmp/CriticalManufacturing/dee-debug": "<DEEs folder>",   // DEE actions (Debug Mode on)
  "/src": "${workspaceFolder}"                                // deployed Cmf.Custom.* DLLs
}
```

`coreclr`'s `sourceFileMap` takes many entries; each breakpoint resolves against whichever
PDB/document matches, so one session debugs **DEE actions and custom business DLLs together**.
Unused entries are harmless no-ops, so both maps are always included (the DEE entry is added
best-effort — skipped when no workspace/DEEs folder resolves). `deeDebugger.attachToHost` and
its "(Custom Business)…" title are removed.

**Unchanged / still separate:** *Toggle DEE Debug Mode* remains its own action — it does the
`ActivateDebugMode` registration + streams your `.cs` into the host + hot-reload. This ADR only
unifies the *attach*; live-compiling DEE actions is orthogonal. Business breakpoints still bind
against the deployed binary with **no hot-reload**. Stock coreclr only (ADR 0001 stands); the
already-parameterized `buildAttachConfig`/`attachDebugger` (caller supplies map + session name)
need no change. The `deeDebugger.hostSourceMap` setting and its `/src`→repo-root default
(validated in ADR 0008 §Validation) are unchanged; all UX hardening from ADR 0008 (C#-extension
pre-check, Switch-Environment button, one-time prerequisites primer, single progress
notification, unbound-breakpoint watcher, success toast) is retained and generalized to cover
both modes.

## Consequences
- **Simpler mental model & smaller surface:** one command, one config; the user attaches once
  and sets breakpoints wherever they need them. No "which attach?" decision.
- **No regression:** the DEE path keeps its DEE source map (now merged in), and Debug Mode /
  hot-reload behave exactly as before.
- **Naming:** the DEE-specific and business-specific session-name strings are replaced by a
  single "Attach to MES Host". Docs (user guide, support, training), the roadmap, and the
  product spec are updated to describe one attach with two kinds of breakpoints.
- ADR 0008's analysis, validation, and all resolutions **except R2** stand; R2 (two commands)
  is superseded by this ADR.


## Erratum (2026-10-19)
The business entry `{ "/src": <repo root> }` is a default for `/src` container builds, not what
makes cmf-cli builds bind: those PDBs record absolute local paths and bind without a map when
debugged at their build path. See the ADR 0008 erratum of the same date. The unified-attach
decision is unaffected.
