import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "dist-e2e/*.test.js",
  // CI runs the minimum supported version (engines.vscode) and stable.
  version: process.env.VSCODE_TEST_VERSION ?? "stable",
  workspaceFolder: "./test-e2e/fixture-workspace",
  installExtensions: ["ms-dotnettools.csharp"],
  mocha: { ui: "tdd", timeout: 60_000 },
});
