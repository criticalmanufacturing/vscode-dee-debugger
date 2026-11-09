/**
 * Extension-host smoke tests — run inside a real (headless) VS Code via
 * `npm run test:e2e`. Interactive quick-picks are driven with workbench
 * commands (accept-selected), so only non-modal paths are exercised here;
 * modal dialogs and typed input remain covered by the stubbed unit suite.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function pollUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await delay(200);
  }
  return check();
}

suite("DEE Debugger extension (real VS Code)", () => {
  const clearActiveEnvironment = async (): Promise<void> => {
    // M8 writes to the OWNING scope, which for the fixture is Global (the persistent
    // test profile) — clear both scopes or state leaks across runs.
    const config = vscode.workspace.getConfiguration("deeDebugger");
    await config.update("activeEnvironment", undefined, vscode.ConfigurationTarget.Global);
    await config.update("activeEnvironment", undefined, vscode.ConfigurationTarget.Workspace);
  };

  teardown(async () => {
    // Quick-input flows are launched un-awaited; make sure a leaked open picker from a
    // failed step can never bleed into the next test (QA e2e-flake finding).
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen").then(undefined, () => undefined);
    await clearActiveEnvironment();
    await delay(300);
  });

  test("activates and registers its commands", async function () {
    this.timeout(30_000);
    const extension = vscode.extensions.getExtension("criticalmanufacturing.cm-dee-debugger");
    assert.ok(extension, "extension not found in the test instance");
    await extension.activate();
    assert.ok(extension.isActive, "extension failed to activate");
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      "deeDebugger.refresh",
      "deeDebugger.switchEnvironment",
      "deeDebugger.manageEnvironments",
      "deeDebugger.discoverEnvironments",
      "deeDebugger.syncCompare",
      "deeDebugger.attach",
      "deeDebugger.createAction",
      "deeDebugger.makeVersionEffective",
      "deeDebugger.toggleShowDisabledActions",
      "deeDebugger.enableDebugMode",
      "deeDebugger.disableDebugMode",
      "deeDebugger.openInMesUi",
      "deeDebugger.showOutput",
      "deeDebugger.openGettingStarted",
    ]) {
      assert.ok(commands.includes(id), `command ${id} not registered`);
    }
  });

  test("explorer view is registered", async function () {
    this.timeout(15_000);
    // Focusing the view must not throw — proves the view contribution + provider wiring.
    await vscode.commands.executeCommand("deeDebugger.explorer.focus");
  });

  test("manage environments: Set active updates the workspace configuration", async function () {
    this.timeout(45_000);
    const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration("deeDebugger");
    await clearActiveEnvironment();
    assert.strictEqual(config().get("activeEnvironment", ""), "", "precondition: no active environment");
    const environments = config().get<{ name: string }[]>("environments", []);
    assert.strictEqual(environments[0]?.name, "envA", "fixture workspace settings not loaded");

    // Launch the flow (don't await — it blocks on quick-pick input), then drive the UI:
    // pick 1 (environment list, first = envA) → pick 2 (action list, first = Set active).
    void vscode.commands.executeCommand("deeDebugger.manageEnvironments");
    await delay(1500);
    await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
    await delay(1000);
    await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");

    const activated = await pollUntil(() => config().get("activeEnvironment", "") === "envA", 15_000);
    assert.ok(activated, `activeEnvironment is '${config().get("activeEnvironment", "")}', expected 'envA'`);

    // Cleanup so the fixture settings file stays pristine for the next run.
    await clearActiveEnvironment();
  });

  test("switch environment: accepting the first row activates that environment", async function () {
    this.timeout(45_000);
    const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration("deeDebugger");
    await config().update("activeEnvironment", "envB", vscode.ConfigurationTarget.Workspace);
    // envB has no stored token, so ~150 ms after this change the extension's (debounced)
    // configuration handler opens the Set Credentials chooser — by design. Let it appear and
    // dismiss it first; otherwise it replaces the switcher opened below and the accept lands in
    // the credentials chooser (this is why the test failed on every CI run).
    await delay(1000);
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen").then(undefined, () => undefined);

    void vscode.commands.executeCommand("deeDebugger.switchEnvironment");
    await delay(1500);
    // Rows are the environments in order — first is envA.
    await vscode.commands.executeCommand("workbench.action.focusQuickOpen").then(undefined, () => undefined);
    await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");

    const switched = await pollUntil(() => config().get("activeEnvironment", "") === "envA", 15_000);
    assert.ok(switched, `activeEnvironment is '${config().get("activeEnvironment", "")}', expected 'envA'`);
    await clearActiveEnvironment();
  });
});
