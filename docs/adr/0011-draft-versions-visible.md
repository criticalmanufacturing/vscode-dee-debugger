# ADR 0011 — Draft (non-effective) versions are visible; effectiveness is a badge, not a filter

Status: accepted (2026-10-18). Supersedes the "Enabled + Effective only" default of F2.2.

## Context
The old Visual Studio add-in hid every action that was disabled or whose row was not
`Effective`, and v0.1.0 copied that rule into both the tree (`buildActionTree`) and sync
(`effectiveServerDees`). Test users reported (GitHub #7, #8) that DEEs created in the MES UI
did not appear, and that a DEE created locally and uploaded with Sync "could not be synced".

Host facts (MES 12.0 host):
- `GetAllActions` → `ActionCollection.LoadAll` → `GetAllAsDataSet()` already returns **at most
  one version per action name: the Effective one when it exists, otherwise the highest Active
  one**. The client never sees two versions of the same action from this call.
- `Action.InternalCreate` stores a new action as **`Version = 1`, `UniversalState = Active`**.
  This is what the MES UI "Create DEE Action" wizard (`CreateAction`), `CreateAction` from any
  client, and `CompileAndSave` with `Id == 0` all produce. Nothing makes it effective until
  `MakeActionVersionEffective` / `MakeActionsEffective` runs (and only `Active` versions are
  accepted).
- A missing `IsEnabled` in the request deserializes to `false`: a create payload that omits it
  produces a **disabled** action.

So the filter did not hide "old versions" (the host already de-duplicates) — it hid every
action that had not yet been promoted, which is the normal state of anything just created.

## Decision
1. The tree and sync show **every action name the host returns**, represented by one shared
   rule (`core/actionVersions.selectActionsByName`): Effective wins; otherwise the highest
   non-Terminated version; otherwise the highest version. This mirrors the host's listing rule
   and makes the tree match Administration → DEE Actions.
2. Effectiveness is **state shown on the row** (`not effective (Active)` badge, warning-coloured
   icon, tooltip), with a one-click **Make Version Effective** action wherever a draft can
   surface: the tree row, version history, after a save into a draft, and after a sync upload
   that created actions.
3. `deeDebugger.showDisabledActions` governs **disabled** actions only. When it is off and
   something is hidden, the tree says how many and offers the toggle — nothing is hidden
   silently.
4. Every payload that can create an action (`createAction`, sync upload of a local-only file)
   sets `IsEnabled: true` explicitly and sends empty strings rather than nulls for
   `Description`/`Classification`.

## Consequences
- Users see drafts immediately after creating them (either side) and can finish the job from
  VS Code; "Save Action to MES" into a draft is explained rather than silently inert.
- Sync compare/upload/download include drafts and disabled actions (code is code); the quick
  picks label draft/disabled rows so a user does not mistake a draft's body for what runs.
- The tree can now contain actions the MES does not execute. The badge carries that meaning;
  the training material and FAQ were updated so "tree count ≠ MES UI count" is no longer the
  expected explanation.
- Requirement F2.2 is amended; `effectiveServerDees` was renamed `serverDees`.


## Erratum (2026-10-18)
The host's listing rule is SQL in `SQLStatments/SQLStatementsForAction.cs`
(`ROW_NUMBER() OVER (PARTITION BY Name ORDER BY UniversalState DESC, VERSION DESC)`), not code in
`GetAllAsDataSet`, and it orders by state value, so a Terminated (4) row would outrank an
Effective (3) one. `selectActionsByName` ranks Effective first. The two can only differ when
the client receives several rows per name — which `GetAllActions` never returns — so the
decision and its behaviour are unchanged; "mirrors the host's listing rule" should read
"matches it for every row set the host actually returns".

## Erratum 2 (2026-10-19) — drafts do run when nothing is effective
This ADR (and the 0.2.0 UI text built on it) says a draft is a version "the MES does not
execute". The executable version is chosen by `Dee.P_ActionLoadExecutableActions`: the
Effective version if one exists, otherwise the **highest** version
(`ROW_NUMBER() … ORDER BY (UniversalState = Effective) DESC, Version DESC`). Verified live on
MES 12.0.0-beta.2: a freshly created action (v1, Active) executed; after v1 was made effective
and v2 staged (Active), v1 kept executing. So a draft is skipped only while another version is
effective, and a draft-only action already runs. The decision (drafts visible, badge, Make
Version Effective) stands, and is better motivated than stated: without an effective version, a
version staged later takes over immediately. The tooltip, save message, create and sync prompts
now say which case applies (`core/actionVersions.draftExecutionNote`).

