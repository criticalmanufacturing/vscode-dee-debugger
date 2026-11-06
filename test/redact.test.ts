import { describe, expect, it } from "vitest";
import { REDACTED, redactArgvSecrets, redactSecrets } from "../src/core/redact";

const jwt =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsInR5cGUiOiJQQVQifQ.N-reBkXOMyNZksXrPJeD6frCm0h6DEwP";

describe("redactSecrets", () => {
  it("redacts bare JWTs (access tokens and PATs)", () => {
    const out = redactSecrets(`token=${jwt} used`);
    expect(out).not.toContain(jwt.slice(0, 30));
    expect(out).toContain(REDACTED);
  });

  it("redacts Authorization header values in JSON and header dumps", () => {
    expect(redactSecrets('"Authorization": "Bearer abcdefghijklmnop1234"')).not.toContain("abcdefghijklmnop1234");
    expect(redactSecrets("authorization: Basic YWJjZGVmZ2hpamtsbW5vcDEyMzQ=")).not.toContain("YWJjZGVmZ2hpamtsbW5vcDEyMzQ");
  });

  it("redacts bearer/basic values appearing in prose", () => {
    expect(redactSecrets("sent Basic YWJjZGVmZ2hpamtsbW5vcDEyMzQ= to host")).toContain(`Basic ${REDACTED}`);
  });

  it("leaves ordinary text, urls and short ids alone", () => {
    const text = "POST http://172.17.0.2/api/DynamicExecutionEngine/GetAllActions id=2608141531140000003 Basic auth";
    expect(redactSecrets(text)).toBe(text);
  });

  it("redacts opaque refresh tokens, auth codes and client secrets (non-JWT)", () => {
    const rt = "def50200a1b2c3d4e5f60718293a4b5c6d7e8f90";
    expect(redactSecrets(`grant_type=refresh_token&refresh_token=${rt}&client_id=MES`)).not.toContain(rt);
    expect(redactSecrets(`{"refresh_token":"${rt}","expires_in":3600}`)).not.toContain(rt);
    const code = "AQABAAIAAAABCDEF0123456789abcdef";
    expect(redactSecrets(`GET /callback?code=${code}&state=xyz`)).not.toContain(code);
    expect(redactSecrets(`GET /callback?code=${code}&state=xyz`)).toContain("state=xyz"); // state is not secret
    expect(redactSecrets('client_secret="s3cr3t-value-1234"')).not.toContain("s3cr3t-value-1234");
  });

  it("redacts URL userinfo and command-line passwords in engine commands", () => {
    expect(redactSecrets("connecting to https://admin:hunter2pass@mes.example.com/api")).not.toContain("hunter2pass");
    expect(redactSecrets("connecting to https://admin:hunter2pass@mes.example.com/api")).toContain("admin:");
    expect(redactSecrets("sshpass -p S3cr3tPw ssh host docker")).not.toContain("S3cr3tPw");
    expect(redactSecrets("mysql --password=topSecret99 -h db")).not.toContain("topSecret99");
  });

  it("does not over-redact docker port mappings or short codes", () => {
    // Bare -p is a docker port flag, not a password — must survive.
    expect(redactSecrets("docker run -p 8080:8080 host")).toBe("docker run -p 8080:8080 host");
    expect(redactSecrets("status code: 200 ok")).toBe("status code: 200 ok");
  });

  it("redacts a token embedded as URL userinfo without a colon", () => {
    const out = redactSecrets("git remote: https://ghp_abcdef1234567890@github.com/x/y");
    expect(out).not.toContain("ghp_abcdef1234567890");
    expect(out).toContain("@github.com");
  });

  it("does not hang on adversarial whitespace (bounded backtracking)", () => {
    const evil = `password${" ".repeat(50000)}x`; // no separator after the run
    const start = Date.now();
    redactSecrets(evil);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe("redactArgvSecrets (element-wise argv)", () => {
  it("redacts the token after sshpass -p in an argv array", () => {
    const out = redactArgvSecrets(["sshpass", "-p", "S3cr3tPw", "ssh", "host", "docker"]);
    expect(out).toEqual(["sshpass", "-p", REDACTED, "ssh", "host", "docker"]);
  });

  it("redacts --password / --token values, inline and separated", () => {
    expect(redactArgvSecrets(["mysql", "--password", "topSecret99", "-h", "db"])).toEqual([
      "mysql",
      "--password",
      REDACTED,
      "-h",
      "db",
    ]);
    expect(redactArgvSecrets(["cli", "--token=abc123def456"])).toEqual(["cli", `--token=${REDACTED}`]);
  });

  it("leaves a bare docker -p port flag alone", () => {
    expect(redactArgvSecrets(["docker", "run", "-p", "8080:8080", "host"])).toEqual([
      "docker",
      "run",
      "-p",
      "8080:8080",
      "host",
    ]);
  });
});
