# Contract fixtures

Real request/response payloads captured from a live **MES 11.2.5** host (cmf-cli local
stack, 2026-08-14/15), slimmed to representative entries. They are the cross-IDE source
of truth promised by ADR 0003: any future client (e.g. the Visual Studio port) must parse
these exact shapes. `contracts.test.ts` asserts the core codecs against every file.

Notable wire facts they lock in: `$id`/`$type` metadata with plain arrays (no `$values`
in these payloads, though the resolver tolerates them), entity `Id`s as **strings** beyond
`MAX_SAFE_INTEGER`, `UniversalState` as numbers (3 = Effective), `ActionGroupActions`
inline with nested `ActionGroup.Name`, DataSet responses as `Actions.Table1` rows, CMFMap
(`$typeCMF`/`CMFMapData`) execute outputs, and the `Val50012` compile-error fault envelope
with method-relative `[Action Code][SourceFile] [Line n,m]` rows.

Captured from a scratch tenant; contains no production data. Re-capture procedure: the
curl calls in docs/smoke-test.md Phase 0/5 with `Authorization: Basic base64(":" + PAT)` —
the forward-auth reads the token from the **right** of the colon (`PAT + ":"` gets a login
redirect; the extension sends `PAT:PAT`).

## MES 12.0.0-beta.2 captures (2026-10-18, GitHub #7/#8)

Taken with the extension's own `MesClient` against an MES 12.0.0-beta.2 local stack (tenant
`mes120beta2`), scratch actions removed afterwards:

- `CreateAction.json` — what *New DEE Action…* gets back: **v1, `UniversalState` 2 (Active),
  not effective**, `IsEnabled` true, the MES UI wizard's starter template.
- `MakeActionVersionEffective.json` — the same version promoted to 3 (Effective).
- `MakeActionVersionEffective.error.json` — promoting a non-Active version: "is not Active".
- `CompileAndSave.create.json` — sync upload of a new local DEE (no `Id`, `IsEnabled: true`):
  created as enabled Active v1. The same call **without** `IsEnabled` was observed to create a
  *disabled* action (the 0.1.0 bug).
- `CreateAction.error.json` — invalid name (`1bad name`) is `Val50018`.
