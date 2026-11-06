import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { vscode: new URL("./test/mocks/vscode.ts", import.meta.url).pathname },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
