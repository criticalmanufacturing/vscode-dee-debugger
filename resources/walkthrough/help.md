# When something is off

- **Show Output Log** (view `…` menu) — every MES call with status and duration, the host-side
  steps (file pushes, vsdbg, patch, attach), and the generated attach configuration. The first
  thing to check.
- **Collect Support Bundle…** — a redacted JSON (environment, host target, credential
  *metadata*, recent log) to attach to a ticket. Tokens are never included.
- **Test Connection** — proves the address and the token independently of the tree.

Typical causes: an expired token (401 / login page), the host paused by an attached debugger
(every call times out — continue the session), or a stack recreate that reverted the host
patch and the vsdbg install.
