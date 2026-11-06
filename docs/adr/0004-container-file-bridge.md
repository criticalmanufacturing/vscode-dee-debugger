# ADR 0004 — Debug source files reach the host via a file bridge (docker cp), not bind mounts

Status: superseded by ADR 0005 (2026-08-14) — the bridge concept stands, but the transport
changed from `docker cp` to stdin/stdout streaming after first contact with a real
docker-in-docker devcontainer environment.

## Context
`ActivateDebugMode.SourceFilePath` must be readable by the host *process*. With containerized
hosts the developer's file isn't in the container. Options: (a) require a bind mount in
compose, (b) copy files in/out (`docker cp`/`kubectl cp`), (c) exec-write via shell.

## Decision
Default to (b): the extension pushes the file to a configurable container path
(`deeDebugger.host.sourcePathInHost`, default `/tmp/CriticalManufacturing/dee-debug`) on debug
activation and on every local save while debug mode is on, and detects host-side rewrites
(the host regenerates the file when its wrapper differs) by polling mtime/hash after executions
fail-safe. If the user *has* a bind mount (e.g. devcontainer sharing a volume with `host`),
setting `sourcePathInHost` to the mounted path and marking the bridge as `mount` skips copying.

## Consequences
- Zero changes required to the product compose files — works out of the box.
- Small window where local file and container copy diverge (between save and push) — acceptable;
  push is triggered by save, and the host reads the file only when the action executes.
- `docker`/`kubectl` CLIs are runtime dependencies for container host kinds.
- Never guess the host's own temp folder (its name is hash-randomized per process); we always
  choose the path and tell the host about it.
