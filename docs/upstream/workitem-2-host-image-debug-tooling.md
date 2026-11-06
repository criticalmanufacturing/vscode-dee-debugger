# Work item 2 — Host image lacks debugger tooling (no vsdbg, no curl/wget)

**Title:** Provide a debug-capable host image variant: include vsdbg (or at minimum a
downloader) so .NET debugger attach works out of the box in dev/test stacks

**Area:** Platform / Host / container images (+ cmf-cli local stack)
**Severity:** Medium — debugging works, but requires per-container provisioning that is
lost on every stack recreate.
**Affects:** `criticalmanufacturing/host` (verified 11.2.5, RHEL 8 based; the 12.0 image is
a RHEL 9-family base and still ships no vsdbg).

## Description

Attaching a .NET debugger to the containerized host (business-code debugging per the
getting-started guide on the [Developer Portal](https://developer.criticalmanufacturing.com),
and DEE debug mode) requires `vsdbg` inside the
container. Today:

1. The host image does **not** ship `/vsdbg` (other MES images, such as the Automation
   Manager Controller, already have a debug stage that installs it).
2. The 11.2.5 image also ships **no curl and no wget**, so the standard one-liner
   (`curl -sSL https://aka.ms/getvsdbgsh | bash …`) cannot even run *inside* the
   container — tooling must download vsdbg externally and stream it in. (12.0 may
   differ: its image build runs `curl` and the host health check uses `curl -f` — not
   verified on a live 12.0 container.)
3. Anything installed lands in the container's writable layer and disappears on
   `cmf dev local stack down && up`.

Additionally, cmf-cli scaffolded local stacks do not grant `CAP_SYS_PTRACE` to the host
container (the MES host's own development compose overrides do), forcing tools to fall back
to `docker exec --privileged` for the debugger process.

## Proposal

Any of the following, in order of preference:

1. A `debug` stage in the host image build mirroring the Automation Manager Controller
   pattern (`curl -sSL https://aka.ms/getvsdbgsh | bash /dev/stdin -v latest -l /vsdbg`),
   published as a `-debug` tag or enabled for the local-stack image build; **and**
   `cap_add: [SYS_PTRACE]` on the host service in the cmf-cli local-stack compose
   template (dev/test only).
2. Failing that, include `curl` in the image so in-container provisioning works.
3. For Kubernetes/OpenShift dev deployments, ship (or document) a **debug profile**:
   `replicas: 1` and `securityContext.capabilities.add: ["SYS_PTRACE"]` on the host
   container. The DEE debug registration and the debug source file live in a single
   replica's memory/filesystem, so any load-balanced fan-out makes debugging
   non-deterministic (breakpoints "randomly" hit, file-not-found compiles when
   activation and file land on different replicas) — single-replica is the only
   sane debugging posture, and pausing at a breakpoint suspends the whole host anyway.

## Field impact today

The DEE Debugger for VS Code extension works around all of this (external download +
stdin streaming through arbitrarily nested container engines, `--privileged` exec with
an unprivileged-first capability probe) — but every stack recreate silently removes
vsdbg, and the workaround adds minutes and moving parts to first-run setup for every
developer. Details: DEE Debugger repo, ADR 0005.
