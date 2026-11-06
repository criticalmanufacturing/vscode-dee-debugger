import { describe, expect, it } from "vitest";
import { DEFAULT_CLI_TIMEOUT_MS, md5Hex, runCli } from "../src/vscode/fileBridge";

// Real child processes (this machine's node binary) — the bugs under test live in the
// stream wiring, which stubs cannot exercise.
const node = process.execPath;

describe("runCli", () => {
  it("survives EPIPE when the child exits before consuming stdin (M1)", async () => {
    // Several MB of stdin against a child that exits immediately: the write gets EPIPE
    // on child.stdin, which without an error listener was an uncaught extension-host
    // exception. It must instead resolve/reject via the normal close path.
    const stdin = Buffer.alloc(4 * 1024 * 1024, 120);
    await expect(runCli([node, "-e", "process.exit(0)"], stdin)).resolves.toEqual({ stdout: "", stderr: "" });
  });

  it("rejects (not crashes) when the child fails before consuming stdin (M1)", async () => {
    const stdin = Buffer.alloc(4 * 1024 * 1024, 120);
    await expect(runCli([node, "-e", 'console.error("no stdin for you"); process.exit(2)'], stdin)).rejects.toThrow(
      /exited with 2: no stdin for you/,
    );
  });

  it("decodes multibyte output split across chunk boundaries (M2)", async () => {
    // "é" is two UTF-8 bytes; the child flushes the first byte alone, then the rest.
    // String-concatenating chunks decoded each half to U+FFFD.
    const script =
      'const b = Buffer.from("héllo wörld", "utf8");' +
      "process.stdout.write(b.subarray(0, 2));" +
      "setTimeout(() => process.stdout.write(b.subarray(2)), 30);";
    const { stdout } = await runCli([node, "-e", script]);
    expect(stdout).toBe("héllo wörld");
  });

  it("kills and rejects a hanging child after the timeout (M6)", async () => {
    await expect(runCli([node, "-e", "setInterval(() => undefined, 1000)"], undefined, 250)).rejects.toThrow(
      /timed out after 250ms/,
    );
  });

  it("applies a 30 s default timeout when the caller passes none (M6)", () => {
    expect(DEFAULT_CLI_TIMEOUT_MS).toBe(30_000);
    // The parameter default is the constant — a fast command still completes normally.
    return expect(runCli([node, "-e", 'process.stdout.write("ok")'])).resolves.toEqual({ stdout: "ok", stderr: "" });
  });

  it("reports exit code and stderr on failure", async () => {
    await expect(runCli([node, "-e", 'console.error("boom"); process.exit(3)'])).rejects.toThrow(/exited with 3: boom/);
  });
});

describe("md5Hex", () => {
  it("hashes buffers and strings identically to md5sum's dialect", () => {
    // printf 'abc' | md5sum
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex(Buffer.from("abc"))).toBe(md5Hex("abc"));
  });
});
