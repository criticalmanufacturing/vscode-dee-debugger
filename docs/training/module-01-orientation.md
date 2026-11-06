# Module 1 — What DEE Actions are and what the extension does

**Duration:** 30 min (self-paced) · 25 min (instructor-led)
**Required reading:** [User guide — index](../user-guide/index.md)
**Prerequisites:** none (first module)

## Learning objectives

After this module you can:

1. **Define** a DEE Action, an Action Group, and the *effective version*, and
   **explain** why DEE code lives in the MES database instead of a customization DLL.
2. **Identify** the four places the extension lives in VS Code: DEE Explorer,
   Command Palette, status bar item, DEE Debugger output channel.
3. **State** the production-safety rule and **justify** it with its two reasons.

## Key concepts

### 1. The DEE execution model

A **DEE Action** (DEE = Dynamic Execution Engine) is a C# business rule stored in the
**MES database**, not compiled into a customization DLL. Actions attach to **Action
Groups** — extension points with dot-delimited names such as
`MaterialManagement.MaterialManagementOrchestration.CreateMaterial.Pre` — and the MES
host **compiles and runs them on the fly** whenever the corresponding operation
happens. Because the code lives in the database:

- it can be changed on a running system without a redeploy;
- the "normal" editor is the small code box in the MES web UI
  (Administration → DEE Actions);
- an action has **versions**, and at most one version is **effective**. The MES runs
  the effective version or, when none is effective, the highest version (versioning is
  covered in Module 4).

One action can belong to **several** groups; it is still one action, appearing under
each group.

### 2. What the extension replaces and adds

The extension replaces the MES web UI's code box with your full VS Code environment,
and adds what the web UI cannot do:

- **Browse** every action in a connected MES as a tree (DEE Explorer).
- **Edit** any action as a real `.cs` file with C# IntelliSense.
- **Upload** with server compile errors mapped onto your file's lines.
- **Debug live**: set breakpoints in action code and hit them while the MES executes
  the action — the headline feature, and the reason the extension exists.
- **Sync** in bulk with a git-tracked Actions project.

It is the successor of the "Critical Manufacturing DEE Explorer" Visual Studio add-in,
rebuilt for VS Code and containerized MES stacks (Docker, docker-in-docker
devcontainers, remote machines, Kubernetes/OpenShift, or a plain local process).

### 3. Where things live in VS Code

Memorize these four — every later module refers to them:

| Surface | What it is |
|---|---|
| **DEE Explorer** | Tree view under the **DEE Debugger** Activity Bar icon; most actions are a right-click away here |
| **Command Palette** | `Ctrl+Shift+P` → type "DEE Debugger" to see the commands (a few tree-row actions, such as *Reload Action from MES*, are only in the tree) |
| **Status bar** | `MES: <environment>` shows the connected environment; click to switch |
| **DEE Debugger output channel** | View → Output → "DEE Debugger" — the first place to look when anything fails |

### 4. The production-safety rule

> Debugging and upload features are for **development and test environments only.**

Two reasons you must be able to recite:

1. A **paused debugger suspends the entire MES host process** — the whole MES stops
   for every user until you continue.
2. **Debug mode changes which code executes** for your user — on live data — and
   attaching a debugger to the host is highly privileged.

The extension warns before attaching to non-local addresses, but the real safeguard is
you: keep production environments out of your list entirely
([FAQ](../user-guide/faq.md#can-i-use-this-against-production)).

## Demo script (instructor variant)

*Setup: instructor's stack running, extension installed and already connected; the MES
web UI open in a browser tab.*

1. **Start in the MES web UI** (2 min). Open Administration → DEE Actions, open any
   action. *Say:* "This is how DEE development worked until now — a plain text box, no
   IntelliSense, no debugger, no diff, no source control. Everything you see this
   week replaces this box."
2. **Show the same action in VS Code** (3 min). Switch to VS Code, click the DEE
   Debugger Activity Bar icon, expand the tree to the same action, click it. *Show:*
   the group hierarchy mirrors the dot-delimited names; the action opens as a real
   `.cs` file. Hover a variable to prove IntelliSense. *Say:* "Same database row, real
   editor. Notice the file has generated code around two regions of 'your' code —
   Module 4 is entirely about that boundary."
3. **Tour the four surfaces** (3 min). Point at the tree header ("Connected · …" row),
   open the Command Palette and type "DEE Debugger" ("almost every capability is a
   command — if you forget where a button is, look here"), click the `MES:` status bar item and
   cancel the switcher, then View → Output → DEE Debugger. *Say:* "When you come to me
   saying 'it doesn't work', my first question will be: what does this channel say?"
4. **The 30-second teaser** (2 min). With a breakpoint already set in a prepared
   action and debug mode on, trigger it and let it hit. *Say:* "A breakpoint inside
   code that lives in a database, executed by a container. Friday-afternoon-you will
   do this without thinking. But note my browser tab —" (switch to the MES UI, click
   anything, show it hanging) "— while I'm paused, the MES is frozen for *everyone* on
   this instance. That's why rule one of this course is: dev and test environments
   only, never production." Press F5 to release.
5. **Close** (1 min): "Today: connect (Module 2–3), edit safely (4), debug (5), sync
   with git (6), fix it yourself (7), then you do the whole loop alone as your
   assessment."

## Hands-on exercise

No stack interaction yet — this is a reading-and-orientation exercise.

1. Open the [user guide index](../user-guide/index.md) and skim the page table.
2. In the MES web UI of **your own** stack, open Administration → DEE Actions and
   find any existing action. Note its name and whether it belongs to a group.
3. Write down (notes file, LMS text box):
   a. the difference between a DEE Action and code in a customization DLL,
   b. the four VS Code surfaces of the extension,
   c. the two reasons for the never-on-production rule.

**Success criteria:**

- [ ] You located Administration → DEE Actions in your stack's MES UI.
- [ ] Your three notes match the Key concepts section above.

## Common mistakes to preempt

- **"It's just an editor plugin."** No — debug mode changes *which code the host
  executes for you* (Module 5). Treat the tool as something that touches a live
  system.
- **Misreading the `not effective` badge.** The tree lists every action like
  Administration → DEE Actions does. A row with a `not effective` badge is a **draft**
  (an action created in the MES UI starts that way); it runs while no version is
  effective, but a version staged later would take over. Disabled actions are hidden
  behind a visible "N disabled actions hidden — click to show" row
  ([FAQ](../user-guide/faq.md#why-dont-i-see-all-actions-in-the-tree-or-in-sync)).
  Covered properly in Module 7 — plant the seed now.
- **Skipping the output channel.** Learners who never open View → Output → DEE
  Debugger get stuck in every later module. Build the reflex on day one.
- **"Production is fine if I'm careful."** It is not: a single breakpoint pause stops
  the MES for the whole plant. No exceptions.

## Knowledge check

**Q1.** Where does the source code of a DEE Action live?
- A. In the customization project's compiled DLL
- B. In the MES database, compiled on the fly by the MES host ✔
- C. In a `.cs` file inside the host container image
- D. In the extension's workspace storage

*Rationale: DEE actions are database-stored rules the host compiles at execution time — that is what makes web-UI editing (and this extension) possible.*

**Q2.** What is an Action Group?
- A. A folder of `.cs` files in the customization project
- B. A set of users allowed to edit an action
- C. An extension point (e.g. `…CreateMaterial.Pre`) to which actions are attached and executed by the MES ✔
- D. A VS Code workspace concept

*Rationale: groups are the MES-side hook points; their dot-delimited names become the tree hierarchy.*

**Q3.** Which of these is NOT one of the four extension surfaces in VS Code?
- A. The DEE Explorer tree view
- B. The `MES: <environment>` status bar item
- C. The DEE Debugger output channel
- D. A dedicated "DEE" panel in the terminal area ✔

*Rationale: the four surfaces are the tree, Command Palette commands, the status bar item, and the output channel — there is no terminal panel.*

**Q4.** Why must debug mode and debugger attach never be used against production? (pick the BEST answer)
- A. The extension is not licensed for production
- B. A paused debugger suspends the entire MES host, and debug mode alters which code executes for your user on live data ✔
- C. Production databases reject the CompileAndSave call
- D. Breakpoints cannot bind on production builds

*Rationale: the guide gives exactly these two reasons — whole-host suspension and privileged, behavior-altering access.*

**Q5.** An action appears twice in the DEE Explorer tree, under two different groups. What does that mean?
- A. There are two copies of the action; edit each separately
- B. It is one action that belongs to both groups — editing or toggling debug from either entry affects both ✔
- C. A rendering bug — refresh the tree
- D. One entry is the effective version, the other is a draft

*Rationale: an action can belong to several groups and is listed under each; it remains a single action ([FAQ](../user-guide/faq.md#why-does-the-same-action-appear-more-than-once)).*

---

Next: [Module 2 — Install, connect, authenticate](module-02-getting-started.md)
