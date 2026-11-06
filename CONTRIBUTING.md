# Contributing

Thanks for your interest in improving the DEE Debugger for VS Code.

## Development setup

Two dev containers are provided (**Dev Containers: Reopen in Container** → pick one):

- **DEE Debugger — Extension Dev** — Node 22, .NET 8 SDK, docker access, and `xvfb` for the
  e2e suite; runs `npm install` on create. Use this for building/testing the extension and F5.
- **DEE Debugger — Docs (MkDocs)** — MkDocs Material + plugins (`pip install -r docs/requirements.txt`)
  and the mermaid CLI (`npm install -g @mermaid-js/mermaid-cli`). Diagrams are **pre-rendered to
  images** at build time, so preview with a full build rather than `mkdocs serve` (which skips the
  diagram plugin): `mkdocs build && (cd site && python -m http.server 8000)`.

Or work locally:

```bash
npm install
npm run build        # tsc type-check + esbuild bundle
npm test             # unit/integration tests (vitest, headless — no VS Code needed)
npm run test:e2e     # extension-host tests in a real headless VS Code (Linux/WSL: needs xvfb)
npm run lint         # eslint
npm run package      # produce the .vsix
```

Open the folder in VS Code and press `F5` for a live Extension Development Host.
Manual verification against a real MES follows `docs/smoke-test.md`.

## Architecture ground rules

- `src/core/**` is platform-agnostic: no `vscode` imports (lint-enforced), no process/file
  I/O — pure codecs and argv/payload builders; every change ships with unit tests.
- `src/vscode/**` is the thin adapter layer; testable flows use the stubbed `vscode`
  module in `test/mocks/vscode.ts`.
- Wire-format knowledge is pinned by the contract fixtures in `test/fixtures/` —
  captured from live MES instances. If the server
  contradicts a fixture, capture a new payload and update fixture + code together.
- Architecture decisions are recorded as ADRs in `docs/adr/` — numbered, immutable
  once accepted (supersede, don't edit).

## Reading the review codes in comments and internal docs

Code comments, `docs/architecture.md`, `docs/roadmap.md` and the test plan cite short codes
such as `R7`, `C1`, `M4`, `L7`, `UX-3`, `SUP-2`, `AC2`. They are finding ids from the internal
design reviews that shaped the extension, kept for traceability:

| Prefix | Review | Example |
|---|---|---|
| `R` | architecture / security review | `R7` privilege only when needed |
| `C` | correctness review | `C1` save-push vs watcher race |
| `M` | engineering milestones / regressions | `M4` one tree element per group attachment |
| `L` | logging & supportability | `L7` log the sanitized attach config |
| `UX` | usability review | `UX-3` unbound-breakpoint notice |
| `SUP` | support review | `SUP-2` engine failure ≠ "vsdbg missing" |
| `AC` | acceptance criteria of an ADR | `AC2` in ADR 0008 |
| `F`, `N` | requirement ids in `docs/requirements.md` | `F4.7`, `N2` |

User-facing documentation (`docs/user-guide/`, `docs/training/`, README) does not use them.

## Pull requests

- Branch from `main`; use conventional commit messages (`feat:`, `fix:`, `docs:`,
  `test:`, `chore:`).
- Keep `docs/` in sync with behavior changes in the same PR (user guide lives in
  `docs/user-guide/`).
- CI must be green: lint, typecheck, unit, package, and e2e.
- Update `CHANGELOG.md` under an `Unreleased` heading.

## Reporting problems

Attach a support bundle: run **DEE Debugger: Collect Support Bundle…** in VS Code,
review it (tokens are never included), and paste it into the issue. See
`SECURITY.md` for reporting security issues privately.
