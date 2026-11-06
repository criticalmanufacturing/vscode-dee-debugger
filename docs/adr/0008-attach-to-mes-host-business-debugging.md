# ADR 0008 — Generalize attach into "Attach to MES Host" for custom business debugging

Status: **accepted** (2026-08-15) — GA target M7 · **§Resolution R2 superseded by [ADR 0009](0009-unify-attach-dee-and-business.md)**

> **Update (2026-08-15):** R2's *two sibling commands* decision is superseded by ADR 0009,
> which unifies DEE and custom-business attach into **one** command (`deeDebugger.attach` =
> "Attach Debugger to MES Host") with a merged `sourceFileMap`. Everything else in this ADR —
> the acceptance, the design analysis, §Validation, and the other resolutions — still stands.

> **Accepted** as the product direction for M7: custom-business attach ships as a **sibling
> feature** of DEE debugging (not a rename), reusing the already-built, unit-tested and
> end-to-end-validated attach infrastructure. The open questions from the proposal — accept vs
> defer, and the "MES host debugger" rename — are resolved in **§Resolution** below, which also
> records which UX recommendations are adopted and which are deferred. The original proposal and
> trade-offs are preserved unedited above that section; **§Resolution is the binding decision**
> and, once accepted, is immutable — future changes supersede this ADR rather than edit it.
>
> **Prototype (2026-08-15):** `buildAttachConfig` takes a caller-supplied `sourceFileMap`
> and config name (unit-tested), `attachDebugger` threads them through, and
> `deeDebugger.attachToHost` runs the existing vsdbg-probe → install → resolve-PID → attach
> sequence with the business source map (setting `deeDebugger.hostSourceMap`, default
> `{ "/src": "${workspaceFolder}" }`) — no DEE action or debug-mode registration. The DEE
> attach path is unchanged (it passes its own DEE-folder map). Exercised end-to-end against a
> live business DLL — see §Validation.

## Validation (2026-08-15) — end-to-end, against the live 11.2.5 stack
The prototype's mechanism was exercised end-to-end with a dummy custom-business assembly
(`Cmf.Custom.cmf.Common.dll`, a portable-PDB build with the tenant in the name — confirming
the naming reality). Every link was verified; **no code changes were needed** — the test
confirmed the prototype and the `/src`→repo-root convention:

- **Portable PDB carries `/src`** — built with `PathMap`, the PDB's document is `/src/Probe.cs`
  (the cmf-cli convention; verified via `MetadataReader`).
- **Deployed + loaded + executed** — streamed into `custom_host` and run by a .NET 8 process;
  the custom method executed (observable output).
- **Attach over the extension's real transport** — vsdbg (freshly installed, as the host image
  ships none) attached to the process via the exact nested-container `pipeTransport`
  (`docker exec … docker exec --privileged -i custom_host /vsdbg/vsdbg`): `attach success=true`.
- **Breakpoint binds, pauses, locals readable** — shown with netcoredbg (MIT; used only as a
  headless harness): a breakpoint in the custom method **hit**, execution paused, and locals
  were read (`x/doubled/result`), repeatedly. Crucially, with the `/src` PDB the breakpoint
  hit **only when `sourceFileMap {/src → local}` was supplied** and not without it — proving the
  source-map is what resolves a `/src`-baked PDB to local source.

Two environment limits split the proof across debuggers (neither is a product defect):
vsdbg cannot be driven headlessly (it requires its licensing **handshake**, which only VS
Code satisfies — under F5 it works normally), and netcoredbg's current build needs a newer
glibc than the UBI8 host provides (so the breakpoint-mechanics half ran locally). vsdbg — the
shipped debugger, used via VS Code — honors `sourceFileMap` per the documented coreclr contract
and Critical Manufacturing's own host attach configuration.

## Context
Customers develop two kinds of MES customization C#:

1. **DEE Actions** — rules stored in the MES database, compiled/run on the fly by the host.
   This extension already debugs them (per-user debug mode + live compile of the local file,
   ADR 0001/0004/0005).
2. **Custom business projects** — `Cmf.Custom.*.Business` (orchestrations, services, IoT
   connectors, …) compiled into DLLs and deployed into the host image by
   `cmf dev local stack up`. The MES host process loads and runs these assemblies.

Debugging (2) today is under-served: the CMF getting-started guide documents only a plain
local-Docker attach (`{"type":"docker","request":"attach",…,"sourceFileMap":{"/src":"…"}}`),
and its Windows-containers guide literally says *"Process To be Documented"*. Yet debugging a
deployed business DLL is fundamentally the same operation the extension already performs for
DEE: **attach the stock `coreclr` debugger to the MES host process, over the right container
transport, with a source map and working PDBs.**

The reusable machinery already exists and is host-agnostic:
- `core/hostExec.ts` — reach the host across docker / docker-in-docker / remote / WSL /
  Kubernetes / OpenShift via `engineCommand` (the CMF docs only cover local Docker).
- `vscode/debugAttach.ts` — vsdbg probe + install (host image ships none), host-PID
  resolution, unprivileged-first `SYS_PTRACE` capability probe.
- `core/hostExec.ts:buildAttachConfig` — generates the `pipeTransport` coreclr attach with
  `justMyCode:false` and a `sourceFileMap`; it is already named "Attach to MES Host".

What is DEE-specific — and NOT needed for business code — is the `ActivateDebugMode` REST
registration, the single-file stream into the container, the marker codec, and hot-reload.
Business debugging is therefore a *simpler* case layered on the same infrastructure: attach
to the already-loaded, already-deployed binary.

## Decision (proposed)
Expose the existing attach path as a **standalone `Attach to MES Host` command**, independent
of the DEE-action / debug-mode flow, and make the source mapping configurable so it can point
at a business project instead of the DEE temp folder.

1. **Standalone command** — run the same probe → install-vsdbg → resolve-PID → `startDebugging`
   sequence in `attachDebugger`, without requiring a selected DEE action or a debug-mode toggle.
2. **Configurable `sourceFileMap`** — today `buildAttachConfig` hardcodes
   `{ [target.sourcePathInHost]: localDeesFolder }`. Generalize to accept caller-supplied
   mappings. For business code the map is `{ "/src": "<local customization repo root>" }` —
   the **cmf-cli convention verified against Critical Manufacturing's own host `launch.json`**
   (`"sourceFileMap": { "/src": "${workspaceFolder}/.." }`),
   where `/src` is the build-source root inside the host container and the local side is the
   repo root that was built into it (usually `${workspaceFolder}` when the customization repo
   is the open folder). Note the custom assemblies are `Cmf.Custom.<tenant>.*.dll`;
   `Cmf.Custom.Business` is only the folder holding `Business.sln`, not an assembly name — so
   the map targets the source **root**, never a per-project/assembly path. DEE keeps its
   existing mapping as one caller.
3. **No new debug mechanics** — still stock `coreclr` attach via the Microsoft C# extension
   (ADR 0001 stands: no custom debug adapter). Reuse `hostExec`/`debugAttach` unchanged apart
   from the source-map parameterization.
4. **Prerequisites are the same ones already characterized by DEE work**, surfaced to the user:
   the DLLs+PDBs must be in the host image (`cmf dev local stack up`), and PDBs must be
   portable-format — the identical product bug the DEE flow hit (upstream work item 1 /
   #158143, worked around by `tools/host-pdb-patcher`).

## Consequences
- **Small, mostly-plumbing effort** (a command + a config parameter + docs), because the hard
  infrastructure (multi-topology reach, vsdbg provisioning, coreclr attach, PDB fix) is built
  and tested. No new host protocol.
- **No hot-reload for business code** — you attach to the deployed binary; changing code means
  rebuild + `cmf dev local stack up` + re-attach. This is classic attach debugging and must be
  set against the DEE live-compile loop in the docs so users aren't surprised.
- **Positioning shift** — it broadens the product from "DEE Debugger" toward a general "MES host
  debugger". Architecturally clean (the core is already DEE-agnostic at the attach layer), but a
  naming/scope decision for the maintainers; could ship as a sibling feature rather than a rename.
- **Testability** — `buildAttachConfig` is pure core and unit-tested; the source-map
  generalization is covered there. The command wiring is thin VS Code layer (F5-verified per
  ADR 0003).

## Resolution (accepted 2026-08-15) — binding decisions

This section resolves the proposal's open questions, folds in the product-owner positioning and
UX review, and is the authoritative spec for the developer. Where it refines the proposal above,
this section governs.

### R1 — Accept as a sibling feature, not a rename (PO positioning)
Ship custom-business attach as a **sibling** of DEE debugging under the existing **"DEE Debugger"**
identity and command category. **Do not** rename the product to "MES host debugger" — defer that
larger bet until adoption justifies it (the core is already DEE-agnostic at the attach layer, so a
future rename costs nothing we forfeit now). The positioning-shift note in §Consequences stands as
context; the decision is: sibling now, rename later if warranted.

### R2 — Command surface: two target-named standalone commands (adopt UX-1)
The v1 entry point is a **standalone command** — zero-config, workspace-shape-agnostic. The two
existing attach commands attach the *same* coreclr debugger to the *same* host process and differ
only by `sourceFileMap`; left as-is their titles collide. **Adopt UX-1** and rename **by target**,
both keeping the **DEE Debugger** category:

| Command id                  | Old title                              | Accepted title                          | `sourceFileMap` source                            |
|-----------------------------|----------------------------------------|-----------------------------------------|---------------------------------------------------|
| `deeDebugger.attach`        | Attach Debugger to MES Host            | **Attach Debugger to DEE Action**       | `{ [sourcePathInHost]: <DEE folder> }` (unchanged)|
| `deeDebugger.attachToHost`  | Attach to MES Host (Business Debugging)…| **Attach to MES Host (Custom Business)…**| `deeDebugger.hostSourceMap` (default `/src`→ws)   |

The debug-config `name` fields (`"Attach to MES Host (DEE)"` / `"Attach to MES Host (Business)"`)
stay as-is — they name the running session, not the command. **Defer** the launch.json snippet
generator and the env-name-in-config-name (UX-7 / PO "later"): F5 power users are a smaller v1
audience and a generated snippet is additive. **Defer** any tree affordance — business DLLs are not
tree nodes (PO), so a tree entry would be misleading.

### R3 — `sourceFileMap` default & override (validated)
Keep the validated default `{ "/src": "${workspaceFolder}" }` — the cmf-cli / PathMap convention
proven in §Validation (breakpoints bind **only** with this map; AC2). The map is **load-bearing**,
not cosmetic. Override via the existing `deeDebugger.hostSourceMap` setting (empty ⇒ default). The
map targets the **source root**, never a per-assembly path (assemblies are `Cmf.Custom.<tenant>.*.dll`;
`Cmf.Custom.Business` is only the `Business.sln` folder). Document the sub-folder case
(`{ "/src": "${workspaceFolder}/.." }`) for users who open a sub-folder rather than the repo root.

### R4 — Multi-topology support (already delivered)
No new topology work. `core/hostExec.ts` already builds the nested `engineCommand` pipe for
docker / docker-in-docker / remote / WSL / Kubernetes / OpenShift, and `buildAttachConfig` emits the
`pipeTransport` from it — so DinD/remote/WSL/k8s attach with **no manual `pipeTransport`** (AC4). The
business path reuses this unchanged; the only per-call difference from DEE is the source map and the
session name.

### R5 — Coexistence with DEE attach (no regression)
Both commands call the same `attachDebugger`/`buildAttachConfig`; the source map and name are
**caller-supplied parameters** (already implemented and unit-tested). The DEE path keeps passing its
own DEE-folder map, so it is behaviorally unchanged. The business path runs **registration-free**
(no `ActivateDebugMode`, no marker codec, no file-stream, no hot-reload — AC9). ADR 0001 stands:
stock `coreclr` attach via `ms-dotnettools.csharp`, no custom debug adapter.

### R6 — UX recommendations adopted / deferred
| UX rec | Disposition | Notes |
|--------|-------------|-------|
| UX-1 rename commands by target | **Adopt** | See R2. |
| UX-2 one-time first-run prerequisites primer | **Adopt** | Before the first business attach, show a one-shot modal listing the 3 invisible prereqs (deployed via `cmf dev local stack up`; portable-PDB / #158143; correct `hostSourceMap`). Gate on a `globalState` flag; offer "Open guide"/"Don't show again". |
| UX-3 proactive unbound-breakpoint feedback | **Adopt** | After a successful business attach, subscribe to `vscode.debug.onDidChangeBreakpoints`; if breakpoints stay `!verified` after a short grace window, surface the 3 likely causes with **Show Log** / **Open guide** actions (satisfies user story U4). Dispose the subscription on session end. |
| UX-4 "no environment" as a **[Switch Environment…]** button + success-toast note | **Adopt** | Replace the plain info message with an actionable button matching the codebase pattern; the success toast already notes no-hot-reload — add that business attach needs **no MES sign-in** (it is lower-privilege than DEE — attach only, no REST token required for the attach itself). |
| UX-5 detect C# extension **not installed** (vs disabled) + **[Install C# extension]**, pre-checked; single wrapping progress notification | **Adopt** | Pre-check `vscode.extensions.getExtension("ms-dotnettools.csharp")` before probing; if absent, offer install and stop. Wrap the whole probe→install-vsdbg→resolve-PID→attach run in one `withProgress` so the non-vsdbg steps also show progress. |
| UX-6 cheap workspace-shape pre-check | **Adopt (light)** | When the default `/src`→`${workspaceFolder}` map is in effect and no `Cmf.Custom.*` entry exists at the workspace root, warn (with a proceed option) before attaching — catches the "opened a sub-folder" case. Keep it a non-blocking heuristic (custom `hostSourceMap` ⇒ skip the check). |
| UX-7 launch.json snippet generator; env name in config name; "DEE vs Business" guide page | **Defer** (snippet + env-name) / **Adopt** (guide page) | Snippet + env-name align with PO "later". **Do** ship the short "DEE vs Business debugging" user-guide page contrasting the two edit loops (live-compile vs rebuild+redeploy) — it is the anchor target for the UX-2/UX-3 "Open guide" actions, so it is required for M7, not deferred. |

### R7 — Out of scope (explicit, per PO)
No hot-reload for business DLLs; no DEE-style live-compile / marker-codec / `ActivateDebugMode`
registration; no custom debug adapter; no auto build/deploy; no per-assembly mapping; Windows
containers not guaranteed in v1. Portable-PDB remains a hard prerequisite (#158143, mitigated by
`tools/host-pdb-patcher`), and DLLs+PDBs must be deployed via `cmf dev local stack up`.

## Alternatives considered
- **Document the raw VS Code `docker` attach instead of building a command.** Rejected as the
  status quo: it only works for local Docker, leaves docker-in-docker / k8s / remote users
  (the common cmf-cli case) to hand-craft `pipeTransport`, and duplicates the vsdbg/PDB
  problems the extension already solves.
- **A separate extension for business debugging.** Rejected — it would re-implement
  `hostExec`/`debugAttach`; the whole point is that this extension already owns that code.


## Erratum (2026-10-18)
This ADR states that business-DLL breakpoints need "portable PDBs — the identical product bug
#158143, worked around by `tools/host-pdb-patcher`". That conflates two things. #158143 and
the patcher concern only the PDB format the **host's DEE compiler** emits for DEE actions
(`Cmf.Foundation.Common.dll`). The PDBs of `Cmf.Custom.*` DLLs come from the customization
build; they must be portable for the Linux debugger, and the host patch does not change them.
The decision (one unified attach, merged source map) is unaffected. The extension's primer and
unbound-breakpoint causes were corrected accordingly.

## Erratum (2026-10-19) — the `/src` map is not a cmf-cli convention
§Validation and R3 call `{ "/src": "${workspaceFolder}" }` "the cmf-cli / PathMap convention" and
"load-bearing". The validation was real, but its probe DLL was built with an explicit
`PathMap=/src`. cmf-cli itself sets no `PathMap` (checked in `criticalmanufacturing/cli` main
@ `1d8652d`), and real `cmf build` PDBs record the build machine's absolute paths (verified on an
11.3.5 project: `/path/to/<project>/Cmf.Custom.Business/…`). Such PDBs bind with **no** map when
the repo is debugged at its build path, and need a map only when built elsewhere (another
folder/container, CI) — keyed by that build root, not `/src`. The `/src` default stays (it serves
`/src` container builds, as in Critical Manufacturing's own host attach configuration, and is otherwise a no-op); the
workspace-shape warning (UX-6), which assumed the default map was load-bearing, was removed.
