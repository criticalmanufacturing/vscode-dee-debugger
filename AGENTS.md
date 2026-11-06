# AGENTS.md — DEE Debugger for VS Code

## What this project is

A VS Code extension to browse, edit, sync, and debug Critical Manufacturing MES **DEE Actions**
(C# rules stored in the MES database, executed by the MES host process). Successor of the
Critical Manufacturing DEE Explorer add-in for Visual Studio.

**Read first**: `docs/requirements.md`, `docs/architecture.md`, and `docs/adr/*`. The REST
contract is pinned by the payloads captured from live MES instances in `test/fixtures/`; if the
server contradicts a fixture, capture a new payload and update fixture + code together.

## Hard invariants (violating these breaks users)

1. The four marker lines are the file-format contract with the host — byte-exact after `trim()`:
   `/** START OF USER-DEFINED CODE (DO NOT CHANGE OR DELETE THIS LINE!) **/` (+ END, + VALIDATION pair).
   Only the two marker-delimited bodies are user data; usings/class scaffolding are server-generated.
2. All MES calls are `POST {hostAddress}/api/DynamicExecutionEngine/{Method}` with headers
   `Authorization: Bearer <token>` (or `Basic base64(PAT + ":" + PAT)` — the forward-auth reads
   the token from the **right** of the colon; `PAT + ":"` yields a login redirect), `cmf_currentculture`,
   `cmf_returnfaultexceptions: false`. Responses may contain Json.NET `$id`/`$ref`/`$type` —
   always run them through `resolveJsonRefs` before use.
3. Debug mode is **per (tenant, user, action), in-memory on the host** — it dies on host restart
   and only affects executions by the same user identity as the token.
4. `SourceFilePath` sent to `ActivateDebugMode` is a path in the **host process's filesystem**.
   For containerized hosts the file is streamed into the container over exec stdin (never
   `docker cp` — it breaks under docker-in-docker; ADR 0005) and the attach config maps that
   path back to the local file via `sourceFileMap`. All container argv building goes through
   `src/core/hostExec.ts` and must honor `HostTarget.engineCommand`.

## Architecture rules

- `src/core/**` is host-agnostic TypeScript: **no `vscode` imports, no Node-only APIs beyond
  fetch/fs abstractions passed in**. All business logic (client, codec, tree model, sync)
  lives here and is unit-tested with vitest. `src/vscode/**` is the thin VS Code adapter layer.
  This split exists so a future Visual Studio port can reuse the design and the spec.
- No custom Debug Adapter. Debugging = stock `coreclr` attach (C# extension) with generated
  configurations. See `docs/adr/0001-no-custom-debug-adapter.md`.
- Tokens go in `SecretStorage` only — never in settings, never logged.
- Don't replicate the old Visual Studio add-in's bugs:
  - synchronous `.Wait()` on the UI thread for every HTTP call;
  - throwing on an empty marker body — an empty body round-trips as an empty string;
  - matching a file to an action by `SourceFilePath.EndsWith(fileName)` (`Foo.cs` vs `MyFoo.cs` collide);
  - eager start-up that shows an error when the host is unreachable;
  - always overwriting the current action version (no versions, disabled actions, search, execute);
  - tokens in plaintext settings;
  - recomputing the host's temp DEE folder client-side (it uses `string.GetHashCode()`, randomized
    per process) — always use the path you sent or the `SourceFilePath` the server returns.

## Commands

```bash
npm run build      # tsc type-check + esbuild bundle
npm test           # vitest unit tests (core + vscode layer against a vscode stub, headless)
npm run lint       # eslint
npm run package    # vsce package (produces .vsix)
```

## Working agreements (AI-assisted development)

- Keep `docs/` in sync with code changes in the same commit; ADRs for any decision that
  constrains future work (numbered, immutable once accepted — supersede, don't edit).
- Every `src/core` change ships with unit tests. VS Code-layer code is kept thin enough
  that manual F5 verification + core tests are acceptable.
- Reference environment: MES 12.0 local stack (`cmf dev local stack up`), host container
  named `custom_host` (some stacks name it `host`), API via
  Traefik at `http://localhost/api/` (the host container publishes no ports;
  `http://localhost:8084` is only the old VS add-in's example address).
- Conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
