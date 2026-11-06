import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "dist-e2e/*.test.js",
  workspaceFolder: "./test-e2e/fixture-workspace",
  installExtensions: ["ms-dotnettools.csharp"],
  mocha: { ui: "tdd", timeout: 60_000 },
});
