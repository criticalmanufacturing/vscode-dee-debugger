# Support playbook — Attach Debugger to MES Host

Scope: the `deeDebugger.attach` command ("**Attach Debugger to MES Host**"),
ADR 0008 / ADR 0009 / roadmap M7. This **one** command debugs both DEE Actions and compiled
custom business DLLs (`Cmf.Custom.<tenant>.*.dll`) by attaching the stock coreclr debugger to the
already-running MES host process with a **merged** `sourceFileMap` (DEE temp folder + the
business map, default `/src`). This playbook covers the **custom-business** half — a business breakpoint binds
against the **deployed** DLL and performs **no** `ActivateDebugMode`, no marker codec, no
file-stream, and has **no hot-reload** (DEE-action breakpoints still need *Enable DEE Debug Mode*).

Key implementation touch-points to cite when reading logs:
- `src/vscode/commands.ts` — `deeDebugger.attach` (the whole flow), `deeDebugger.collectSupportBundle`.
- `src/vscode/debugAttach.ts` — `attachDebugger`, `hasVsdbg`, `installVsdbg`, `findHostProcessId`.
- `src/core/hostExec.ts` — `buildAttachConfig`, `findHostPidArgs`, `vsdbgProbeArgs`, `execInHostArgs`, `ptraceProbeArgs`, `decideAttachPrivilege`.
- `src/core/businessAttach.ts` — source-map resolution + `UNBOUND_BREAKPOINT_CAUSES`.
- `src/core/redact.ts` — what is scrubbed from logs and the support bundle.

---

## 0. First questions to ask on a ticket

Ask for the **support bundle first** (`DEE Debugger: Collect Support Bundle` — see §7); it answers
most of these. Then:

| # | Question | Why it matters |
|---|----------|----------------|
| 1 | What exactly fails — no attach at all, attach succeeds but breakpoint stays **hollow/unbound**, or "no symbols loaded"? | Splits the failure into §1–§6; a hollow breakpoint is almost never an attach problem. |
| 2 | Host topology: local docker, docker-in-docker/devcontainer, remote, WSL, or Kubernetes/OpenShift? Which `kind`/`engineCommand`? | Reach failures (§4) and the multi-replica case (§5) are topology-specific. |
| 3 | After the last code change, was the solution built in **Debug** (`cmf build --test` or `dotnet build`, which write `LocalEnvironment/BusinessTier`) and then deployed with `cmf dev local stack up`? | Stale binary is the #1 unbound-breakpoint cause. `stack up` only copies `LocalEnvironment/BusinessTier` into the image; a plain `cmf build` (Release → `Cmf.Custom.Business/Release/`) never reaches it. No hot-reload (§6). |
| 4 | Is `ms-dotnettools.csharp` **installed and enabled**? | The command hard-stops if it is absent (§3). |
| 5 | Where (machine/container and path) was the DLL built with `cmf build`, and is the repo at that same path in the window they debug from? What is `deeDebugger.hostSourceMap`? | The PDB records build-time paths; if they don't exist on the debugging machine, nothing binds without a map (§1). |
| 6 | Were the DLLs built with `cmf build` (portable PDBs)? For DEE breakpoints in the same session: is the host patched (**Patch Host for DEE Debugging**, or MES 12 with the fix built in)? | Non-portable business PDB = "no symbols" (§2); the host patch (#158143) only affects DEE compiles. |
| 7 | From the output channel: the sanitized **attach config** line and the **host process candidates** line. | The two most useful lines in any attach ticket (see §7). |

> Note: business attach needs **no MES sign-in / no token** for the attach itself (it is
> attach-only, lower-privilege than DEE). A 401/credential angle is a red herring here — do not
> chase it unless the user is also using DEE features.

---

## 1. Breakpoint stays unbound (hollow) — source-map / PDB-path mismatch

The most common ticket. Attach succeeds; the breakpoint shows as a **hollow circle** and never hits.
The extension itself flags this: after a successful attach `watchUnboundBreakpoints` waits an
8 s grace window (`UNBOUND_BREAKPOINT_GRACE_MS`) and, if **every** enabled source breakpoint failed
to bind, shows a warning with **Show Log** / **Open guide** (plus **Patch Host for Debugging** when
the host is known to be unpatched) and logs `UNBOUND_BREAKPOINT_CAUSES`. DEE breakpoints whose
action has not run yet also count as unbound, so the warning can fire in a pure DEE session.

Causes, in the order the code lists them (`src/core/businessAttach.ts`):

| Rank | Cause | Diagnose | Fix |
|------|-------|----------|-----|
| 1 | **Stale DLL/PDB in the host** (no hot-reload) | Compare the timestamps of `LocalEnvironment/BusinessTier/*.dll` with the last edit, and with `/opt/app` in the container. A Release-only `cmf build` leaves `BusinessTier` untouched. | Debug build (`cmf build --test` or `dotnet build`), `cmf dev local stack up`, then re-attach (§6). |
| 2 | **PDB not portable-format** | See §2 — usually surfaces as "no symbols", but can also just fail to bind. | Rebuild with portable PDBs, redeploy (the host patch does not change business PDBs — §2). |
| 3 | **Recorded source paths don't resolve** | A portable PDB stores each document's path at build time. A local `cmf build` stores the repo's **absolute** path (cmf-cli sets no `PathMap`; e.g. `/path/to/<proj>/Cmf.Custom.Business/…`), so building and debugging at the same path needs no map. It breaks when the DLL was built elsewhere (another folder/container, CI) or the user debugs a copy of the repo. | Map the build root: `deeDebugger.hostSourceMap` = `{ "<path used at build>": "${workspaceFolder}" }` (see below). |

The map matters only when paths differ. ADR 0008 §Validation proved the mechanism with a PDB
deliberately built with `PathMap=/src`: there the breakpoint bound *only* with `{ "/src" → repo }`.
Real cmf-cli builds carry absolute local paths instead (verified on an 11.3.5 project's
`BusinessTier` PDBs).

Source-map resolution (`resolveBusinessSourceMap`):

| `deeDebugger.hostSourceMap` | Effective map | `isDefault` |
|----------------------------|---------------|-------------|
| empty `{}` / unset | `{ "/src": "${workspaceFolder}" }` (the default — covers `/src` container builds, no-op otherwise) | `true` |
| non-empty (custom) | the configured map verbatim | `false` |

Diagnosis steps:
1. Read the output line `[debug] attach sourceFileMap=… (businessDefault=…)`.
2. Establish the **recorded** root: the repo's path on the machine or container that ran
   `cmf build` (for a CI build, the agent's work folder; for a `PathMap` build, the mapped root).
3. If it equals the repo's path in the debugging window, no map is needed — look at causes 1–2
   instead. Otherwise set `{ "<recorded root>": "${workspaceFolder}" }` and re-attach.
4. Opening a sub-folder of the same repo is **not** a cause: the recorded paths are absolute.

---

## 2. "No symbols loaded" / portable-PDB (#158143)

Distinct from §1: the debugger reports **no symbols for the module** (rather than a bound-then-missed
breakpoint). vsdbg on Linux reads only **portable** PDBs; a DLL deployed with a non-portable
(Windows/full) PDB has no usable symbols. ADR 0008 groups this with the DEE-flow bug #158143, but
the extension's host patch does **not** fix it: **Patch Host for DEE Debugging** (and
`tools/host-pdb-patcher`) only flips the PDB format the host's DEE compiler emits, inside
`Cmf.Foundation.Common.dll` (`src/core/hostPatch.ts`). It never touches the customization's PDBs.

| Symptom | `Cmf.Custom.<tenant>.*.dll` loads but "Module was built without symbols" / "no symbols loaded"; all breakpoints in it stay unbound. |
|---|---|
| Root cause | The business PDB is not portable-format. |
| Fix | Rebuild the DLLs with portable PDBs (`cmf build` emits them by default — the .NET SDK default, unless the customer's project overrides `DebugType`), then redeploy. |
| Confirm the fix took | After redeploy + re-attach, the module shows symbols and breakpoints bind. |

This is a **hard prerequisite**, called out in the one-time primer (§8) and in ADR 0008 R7.

### 2a. "No source available" when stepping into `Cmf.Foundation.*` / other product code — EXPECTED, not a bug

The host makes **every `Cmf.*` assembly** debuggable (it deploys PDBs for product *and*
customization). The customer only has **source for their `Cmf.Custom.<tenant>.*`** code, so:

| Symptom | Stepping (`F11`) or an exception lands in a **product** `Cmf.*` frame and VS Code shows "no source available" / disassembly. Breakpoints set in product code never bind. |
|---|---|
| Root cause | Not a defect. Attach uses `justMyCode: false`, so the debugger enters product frames — but there is no local source for them, and the customer's map (or their own absolute build paths) only resolves the customer's own files. |
| Guidance | Set breakpoints inside `Cmf.Custom.*`; use **Step Over** (`F10`) to stay in customer code. Only if the customer has a product source tree checked out can they add its build root to `hostSourceMap`. This is **not** the unbound-breakpoint problem of §1 (that's a breakpoint in *their* code failing to bind). |

---

## 3. C# extension missing → command hard-stops

The attach command pre-checks `vscode.extensions.getExtension("ms-dotnettools.csharp")`. If the
extension is **absent**, it shows an error with an **[Install C# extension]** button
(`workbench.extensions.installExtension`) and **returns** — no probe, no attach.

| Symptom | Command shows "The C# extension (ms-dotnettools.csharp) is required … but it is not installed" and stops. |
|---|---|
| Note | This detects *not installed*. If it is installed but **disabled**, this check passes but `startDebugging` later returns false → the "C# extension rejected it" warning in `attachDebugger` (check it is enabled). |
| Fix | Install (or enable) `ms-dotnettools.csharp`, reload window, retry. |

---

## 4. vsdbg missing / install fails, or the host can't be reached

The host image ships **no vsdbg**; the extension provisions it. `hasVsdbg` runs a probe
(`vsdbgProbeArgs`) that exits 0 whenever the exec **reached** the container and prints
`present`/`missing`. This deliberately separates two very different failures:

| Observed | Meaning | What the code does | Fix |
|----------|---------|--------------------|-----|
| Probe printed `missing` | Reached the container; vsdbg not at `vsdbgPath` | Prompts **[Install vsdbg]**; on accept, installs with a progress toast | Accept the install. If install fails, see below. |
| Probe **rejected** (non-zero exit / spawn error) | The **engine command itself failed** — docker/kubectl not on PATH, wrong container name, dead daemon, timeout | Throws "Could not reach the MES host {container/pod} … verify the engine command / container name" — it does **not** offer to install into an unreachable container | This is §4-reach, not a vsdbg problem — fix reach first. |

**Install path** (`installVsdbg`): tries an **in-container** download first (needs `curl`/`wget`
inside the host — MES 12 images have `curl`, MES 11.x images have **neither**), then falls back to a **local download + tar stream
over the exec pipe** (needs local `bash`+`tar`, i.e. Linux/WSL/macOS; the download/install steps time out at 10 min). Both
fallbacks are logged with `[attach] … falling back to local download + exec stream`.

| Install symptom | Likely cause | Fix |
|-----------------|--------------|-----|
| "vsdbg extraction in the host failed …" | Truncated stream / no write perm in `vsdbgDir` | Check container disk/perms; retry; run `DEE Debugger: Install vsdbg in Host Container` standalone. |
| Local-download fallback errors on Windows (no bash/tar) | getvsdbg.sh needs a POSIX shell | Run VS Code inside WSL/remote, or pre-bake vsdbg into the image. |
| `Failed to download getvsdbg.sh (HTTP …)` | The machine running VS Code has no outbound access to `aka.ms` (the local fallback downloads there) | Provide network egress or pre-install vsdbg. |

**Reach checklist** for the "engine command failed" case:
1. Support bundle `engineProbe` field — "host container reachable" vs "NOT reachable: …".
2. `hostTarget.kind` + `engineCommand` + `containerName` (docker) / `k8sTarget` (kubernetes).
3. For docker-in-docker/devcontainers the `engineCommand` must nest
   (e.g. `["docker","exec","-i","<devcontainer>","docker"]`) — `execInHostArgs` wraps every argv
   through it.

---

## 5. Attach can't find the host process / k8s multi-replica

`findHostProcessId` scans `/proc` inside the container (`findHostPidArgs`) for a **managed** process
whose argv0 is `dotnet` (or `*/dotnet`) **and** whose command line contains
`Cmf.Foundation.Services.HostService.dll` (`HOST_PROCESS_MARKER`). It deliberately **excludes the
native `CmfEntrypoint` wrapper (PID 1)** — attaching to the wrapper fails with **`0x80131c08`**
(no managed-attachable CoreCLR).

| Case | Log signal | Behaviour | Fix |
|------|-----------|-----------|-----|
| Exactly one candidate | `[attach] host process candidates: <pid> dotnet … HostService.dll` | Attaches to that PID automatically | — |
| Zero candidates | `host process candidates: none` | Warns; falls back to the **interactive process picker** | Confirm the host is actually running; check the process name is standard. |
| Multiple candidates | Two+ entries, separated by ` \| `, on the candidates line | Falls back to the picker; warns "pick the 'dotnet … HostService.dll' entry (**NOT** the CmfEntrypoint wrapper)" | User picks the managed dotnet PID. |
| User picked the wrapper | Attach fails `0x80131c08` | — | Re-attach, pick the dotnet process, not PID 1. |

**Kubernetes / OpenShift multi-replica:** `execInHostArgs` runs `kubectl exec … <k8sTarget> -- …`.
The environment's `k8sTarget` field **must be set** (empty throws `deeDebugger.host.k8sTarget is
not configured.` — the message still names the legacy flat setting). If
`k8sTarget` selects a Deployment/label rather than a **single pod**, exec lands on one arbitrary
replica — you may PID-resolve and attach to a **different** replica than the one serving the request
you want to hit, so the breakpoint never fires even though everything "worked".

| k8s symptom | Fix |
|-------------|-----|
| `deeDebugger.host.k8sTarget is not configured.` | Set the environment's `k8sTarget` via **Manage Environments…** (e.g. `pod/<name>` or `-n <ns> <pod>`). |
| Attach succeeds but breakpoint never hits on a multi-replica deployment | Pin `k8sTarget` to **one specific pod**; scale to 1 replica while debugging; or route traffic to the debugged pod. |
| Modal warning "The host pod grants no CAP_SYS_PTRACE …" (**Attach Anyway** or cancel) | k8s has **no exec-level `--privileged`** — the **pod spec** must grant `SYS_PTRACE`; for a non-root container also `runAsUser: 0` or node `ptrace_scope=0` (see §6 note). The preflight reports this before the debug session starts. |

---

## 6. "No hot-reload" confusion

Frequent non-bug ticket: user edits code, expects the running debugger to pick it up (as DEE
live-compile does), and the breakpoint stops binding or hits **old** code. Business attach binds
against the **deployed binary** — there is no live-compile.

| Expectation | Reality |
|-------------|---------|
| Edit `.cs` → breakpoint hits new code (DEE behaviour) | **No.** Edit → **Debug build** (`cmf build --test` or `dotnet build`) → `cmf dev local stack up` (copies `LocalEnvironment/BusinessTier` into the image) → **re-attach**. |
| Source map alone makes edits live | No; the map only resolves the *deployed* PDB's paths to local files. |

This is stated up front in the one-time primer (§8) and repeated in the success toast
("custom-business breakpoints bind against the deployed Cmf.Custom.* DLLs (no hot-reload)"). If the user says the
breakpoint "worked yesterday and stopped", suspect an edit-without-redeploy (§1 rank 1).

> ptrace note: cmf-dev's MES 12 stack template grants no `CAP_SYS_PTRACE` to `host` (its 10.x–11.x templates add `SYS_PTRACE`, older generated 11.x stacks may not). Without it the
> extension attaches with `--privileged -u 0` (a one-exec preflight, `ptraceProbeArgs`, downgrades
> to unprivileged only when the exec user already holds `CAP_SYS_PTRACE`). The `-u 0` is required
> because the product host image runs as uid 1001 and a non-root privileged exec has **no**
> effective capabilities — only stacks that override `user: root` ever worked without it. The
> Output channel logs `[attach] ptrace probe: CAP_SYS_PTRACE=… uid=… yama=…`. Kubernetes has no
> `--privileged` exec equivalent: a missing capability is reported before attaching with the pod
> fix (`securityContext.capabilities.add: ["SYS_PTRACE"]`, plus `runAsUser: 0` or node
> `ptrace_scope=0` for non-root containers, since added capabilities are dropped on exec for
> non-root users). `kernel.yama.ptrace_scope=3` on the node blocks attach entirely and is reported.

---

## 7. What the support bundle shows for this scenario

`DEE Debugger: Collect Support Bundle` (`deeDebugger.collectSupportBundle`) opens an **unsaved JSON
doc**. Everything is redacted (see §9). Fields most relevant to a business-attach ticket:

| Field | What to read it for |
|-------|---------------------|
| `engineProbe` | "reachable" vs "NOT reachable: …" — the §4 reach split, run at collection time. |
| `hostTarget` | `kind`, `containerName`, `k8sTarget`, `vsdbgPath`, `engineCommand` (argv-redacted) — topology + where vsdbg is expected (§4/§5). |
| `activeEnvironment` / `hostAddress` | Which env; whether it is local (affects the non-local attach confirm). |
| `environments` | All profiles (each `engineCommand` argv-redacted) — spot a mis-configured profile. |
| `remote` / `platform` | `vscode.env.remoteName` + `os/arch` — needed for the WSL/devcontainer local-download fallback (§4). |
| `recentLog` | The pre-redacted output ring: look for the **attach config** line (`[attach] pid=… privileged=… config=…`), **host process candidates**, the **sourceFileMap** line, **vsdbg probe/install fallback** lines, and the **unbound-breakpoint** warning. |
| `extension` / `vscode` | Versions. |
| `credential` | Metadata only (present y/n, kind, expiry, `sub`). **Not relevant to business attach** (no token needed) — ignore unless DEE is also in play. |

The bundle does **not** capture PDB format, the deployed DLL build timestamp, or breakpoint bind
state — ask for those (§0 Q3/Q6) or have the user reproduce with the output channel open.

---

## 8. The one-time prerequisites primer

Before the **first** attach (DEE or business — it is the same command), a modal lists the
prerequisites for both kinds of breakpoint: for DEE, enable Debug Mode first; for business, the
three invisible prereqs (deployed via `cmf dev local stack up`; portable PDBs — the primer text
says "per #158143 / tools/host-pdb-patcher", see §2; correct `hostSourceMap`) and the
no-hot-reload fact. Buttons: **[Attach]** / **[Open guide]**. It is gated on the `globalState` key
`deeDebugger.businessAttachPrimerShown`, set by either button, so it shows **once** (dismissing it
with Esc cancels the attach and leaves it to show again).

| Ticket implication | Detail |
|--------------------|--------|
| "I never saw the prereqs warning" | It fires once per profile/globalState; a returning user won't see it again. Point them at the guide URL (`docs/user-guide/dee-vs-business-debugging.md`). |
| "Clicking Open guide didn't attach" | By design — Open guide opens the guide and **aborts** the attach so the user can read first; it won't re-show next run. Re-run the command to actually attach. |

---

## 9. Redaction guarantees (what is safe to share)

`src/core/redact.ts` scrubs everything that leaves the process toward a human — output lines, error
toasts, and the support bundle. Safe to ask users to paste logs/bundles.

| Redactor | Catches |
|----------|---------|
| `redactSecrets` (string) | JWTs (access tokens **and** PATs are JWTs), `Authorization`/`Proxy-Authorization` header values, `bearer`/`basic <blob>`, `key=value` secrets (`access_token`, `client_secret`, `password`, `api_key`, …), OAuth `code`, URL userinfo (`scheme://user:pass@`, `scheme://token@`), CLI password flags (`--password`, `sshpass -p`). |
| `redactArgvSecrets` (argv array) | Element-wise password/token flags in `engineCommand` arrays (`sshpass -p PW`, `--token X`, `--password=X`) — applied to `hostTarget.engineCommand` and every `environments[].engineCommand` before the bundle is serialized. |

Redaction is applied **defense-in-depth**: the log ring is pre-redacted, engine-command argv is
scrubbed element-wise, and the whole bundle JSON is run through `redactSecrets` once more before it
opens. Tokens never appear in settings and are never logged. Replacement token: `«redacted»` — if a
user reports seeing that string, that is redaction working, not corruption.

> Not redacted (and fine to share): host addresses (minus embedded credentials), container/pod
> names, `vsdbgPath`, source-map paths, PIDs, action names. If a customer treats hostnames as
> sensitive, have them scrub manually before attaching to the ticket.
