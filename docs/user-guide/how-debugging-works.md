# How DEE debugging works (client + host internals)

You don't need this page to *use* the debugger — [debugging.md](debugging.md) covers
that. Read this when you want to understand *why* it behaves the way it does: why
breakpoints are per-user, why a host restart loses debug mode, why the host sometimes
rewrites your file, and why multi-replica clusters need pinning.

## The moving parts

```mermaid
flowchart TD
    subgraph VSCode["Your VS Code"]
        EXP["DEE Explorer<br/>(tree + badges)"]
        CMD["Commands<br/>(toggle / save hooks)"]
        WATCH["Debug file watcher<br/>(md5 poll, 15 s)"]
        DBG["C# debugger<br/>(coreclr session)"]
        FILE["Local file<br/>DEEs/&lt;Action&gt;.cs"]
    end

    subgraph Engine["Container engine path<br/>(docker / dind / kubectl / …)"]
        PIPE["exec pipe"]
    end

    subgraph Host["MES host container"]
        API["REST API<br/>/api/DynamicExecutionEngine"]
        CACHE["DeeDebugCache<br/>(in-memory, per tenant,<br/>keyed by USER)"]
        COMP["Roslyn Compiler<br/>(debug branch)"]
        HFILE["Registered file<br/>/tmp/CriticalManufacturing/<br/>dee-debug/&lt;workspace path&gt;/&lt;Action&gt;.cs"]
        ASM["&lt;guid&gt;.dll + .pdb<br/>(temp folder)"]
        VSDBG["vsdbg"]
        DB[("MES database<br/>(action versions —<br/>NEVER touched by<br/>debug mode)")]
    end

    CMD -- "1 push file (stdin stream)" --> PIPE --> HFILE
    CMD -- "2 ActivateDebugMode(user, path)" --> API --> CACHE
    DBG -- "3 attach (pipe transport)" --> PIPE --> VSDBG
    HFILE -- "4 compiled on EVERY execution<br/>for the registered user" --> COMP --> ASM
    ASM -- "PDB paths point at the file" --> VSDBG
    WATCH -- "md5 probe / pull rewrites" --> PIPE
    COMP -. "reads code for everyone else" .-> DB
```

Key asymmetry: **the database is never involved in debug mode.** The registration lives
only in the host process's memory, and the code the host runs *for you* comes only from
the registered file.

## The full loop, step by step

```mermaid
sequenceDiagram
    autonumber
    participant U as You (editor)
    participant X as Extension
    participant H as MES host
    participant C as DeeDebugCache<br/>(host memory)
    participant D as vsdbg (attached)

    U->>X: Enable DEE Debug Mode
    X->>H: push file → /tmp/…/Action.cs (exec stream)
    X->>H: ActivateDebugMode(Action, path)
    H->>C: AddToCache(userAccount → path)
    Note over C: keyed by YOUR user —<br/>nothing persisted to the DB

    U->>X: Attach Debugger
    X->>D: start coreclr session (pipe into container,<br/>host PID auto-resolved)

    U->>H: trigger the action (as YOUR user!)
    H->>C: user registered for this action?
    alt registered (you)
        H->>H: read Action.cs → regenerate wrapper<br/>(rewrites the file if usings differ!)
        H->>H: Roslyn compile (Debug, embedded source)<br/>→ guid.dll + guid.pdb
        H->>D: module loaded — PDB documents = your file path
        D-->>U: breakpoint binds and HITS
        Note over H: entire host process is<br/>suspended while paused
    else anyone else
        H->>H: run the Release-compiled DB version
    end

    U->>U: edit + save (Ctrl+S)
    X->>H: re-push file
    Note over H: next trigger compiles the NEW code —<br/>no upload to the DB needed

    U->>X: Toggle off (or close window / switch environment)
    X->>H: DeactivateDebugMode
    H->>C: RemoveFromCache(user, action)
```

## The registration's lifecycle (and why restarts matter)

```mermaid
flowchart TD
    START(( )) --> OFF
    OFF["<b>Off</b><br/>stored DB version runs"]
    ACTIVE["<b>Active</b><br/>your file compiled on every trigger<br/>(each save re-pushes · each trigger recompiles)"]
    LOST["<b>Lost</b><br/>in-memory registration gone"]

    OFF -->|"Toggle on — ActivateDebugMode<br/>(push file + cache entry)"| ACTIVE
    ACTIVE -->|"Toggle off — DeactivateDebugMode"| OFF
    ACTIVE -->|"host restart / redeploy"| LOST
    LOST -->|"'Re-enable Debug Mode' button"| ACTIVE
    LOST -->|"decline / ignore"| OFF
```

The extension detects the **Lost** state by comparing its local badge with the server's
per-user `IsInDebugMode` after every refresh — the host itself never announces it.

## What the host actually does (for the curious)

1. **Registration** is four lines in the host: build an `ActionDebugInfo{Id, Name, path}`
   and put it in a per-tenant in-memory dictionary keyed by your user account. The
   `IsInDebugMode`/`SourceFilePath` you see in API responses are *computed from that
   dictionary*, not database columns.
2. **Every execution** checks that dictionary for the calling user. Hit → unconditional
   recompile from your file. Miss → the cached Release build of the database version.
3. **The debug compile** re-extracts your two marker bodies from the file and
   regenerates the full wrapper (usings come from your `UseReference(...)` calls, never
   from the file's `using` lines). If the regenerated wrapper differs from your file,
   **the host rewrites your file**; the extension's watcher pulls that back into your
   editor.
   Then Roslyn compiles the file with a *file-backed* syntax tree, embedded source, and
   emits `<guid>.dll` + `<guid>.pdb` whose document paths are your file — which is
   exactly what lets the attached debugger bind your breakpoints.
4. **Pausing at a breakpoint suspends every thread of the host** — all users, the UI,
   everything — until you continue. This is normal .NET debugging, and the core reason
   debug mode is a development/test-only feature.

## Multi-replica clusters: why pinning is mandatory

Because the registration is one replica's memory and the file is one pod's filesystem,
**four things must land on the same replica**: the ActivateDebugMode call, the pushed
file, the triggering execution, and the attached debugger. A load balancer scatters
them:

```mermaid
flowchart TB
    LB["Service / ingress<br/>(load balancer)"]
    A["Replica A<br/>file ✓ (kubectl exec)<br/>debugger ✓ (attached)"]
    B["Replica B<br/>registration ✓ (API landed here)<br/>file ✗ → read error!"]
    C2["Replica C<br/>nothing → runs DB code"]
    X["Extension API calls"] --> LB
    T["Triggers (UI / Execute)"] --> LB
    LB -->|"?"| A
    LB -->|"?"| B
    LB -->|"?"| C2
```

With N replicas you get roughly a 1-in-N chance per trigger that everything aligns —
experienced as "debugging randomly works", plus file-not-found compile errors when the
registration and the file land on different replicas.

**Fix, in order of preference:**

1. **Scale the host to one replica in the dev/test namespace** while debugging:
   `kubectl scale deployment/host --replicas=1 -n <namespace>`. (A hit breakpoint
   freezes the whole host anyway — multi-replica debugging has no upside.)
2. **Pin everything to one pod**: `kubectl port-forward pod/<host-pod> 8080:8080`, set
   the environment's `hostAddress` to `http://localhost:8080`, and set `k8sTarget` to
   that same pod. Then trigger via **Execute Action…** (which uses your pinned address)
   rather than the MES UI, whose requests still go through the ingress.

The same applies to any classic load-balanced deployment — the original Visual Studio
add-in documentation carried the equivalent warning.

## Related pages

- [Debugging guide](debugging.md) — the practical how-to
- [Environments — per-type setup notes](environments.md#per-type-setup-notes)
- [Troubleshooting](troubleshooting.md) — symptom-first fixes
