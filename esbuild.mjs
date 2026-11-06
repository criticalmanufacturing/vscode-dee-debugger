import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const e2e = process.argv.includes("--e2e");

if (e2e) {
  await esbuild.build({
    entryPoints: ["test-e2e/suite.ts"],
    bundle: true,
    outfile: "dist-e2e/suite.test.js",
    external: ["vscode", "mocha"],
    format: "cjs",
    platform: "node",
    target: "node20",
    sourcemap: true,
    logLevel: "info",
  });
  process.exit(0);
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/vscode/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
