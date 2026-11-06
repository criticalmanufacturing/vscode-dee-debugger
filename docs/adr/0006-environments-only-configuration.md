# ADR 0006 — Environments are the only connection configuration

Status: accepted (2026-08-15)

## Context
The original design layered named environment profiles on top of flat `deeDebugger.*`
connection settings, with a pseudo-environment "Default" representing the flat values.
Live use showed the hybrid confused more than it helped: the switcher's Default row needed
jargon to describe itself, "connected to Default" was ambiguous, credentials lived in a
scope users couldn't see, and every connection field existed in two places.

## Decision
Environments (self-contained named profiles) are the sole connection configuration unit;
`deeDebugger.activeEnvironment` selects one, and none selected means "not connected"
(welcome view with Discover/Switch actions). Omitted profile fields fall back to built-in
constants (`DEFAULT_HOST_TARGET` / `DEFAULT_HOST_ADDRESS` in `core/env.ts`), not to user
settings. Credentials are stored per environment only. The flat `hostAddress`/`host.*`
settings were removed from the manifest; a one-time startup migration wraps any legacy
values plus their Default-scoped tokens into an environment named `default` and activates
it. Workspace-level (non-connection) settings — `deesFolder`, `showDisabledActions` —
remain flat.

## Consequences
- One mental model: create/discover environments, pick one, each carries its token.
- Removing the active environment falls over to the next remaining one, or to a clean
  "not connected" state when none remain.
- Pre-0.2 settings keep working via migration; the legacy keys are read only by the
  migration path (unregistered settings remain readable from settings files).
