import { describe, expect, it } from "vitest";
import { decodeJwt } from "../src/core/jwt";

const b64url = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const jwt = (payload: unknown): string => `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.sig`;

describe("decodeJwt", () => {
  it("decodes the payload and detects a Security Portal PAT", () => {
    const info = decodeJwt(jwt({ sub: "admin", type: "PAT", tenantName: "cmf", exp: 1789253999 }));
    expect(info?.isPat).toBe(true);
    expect(info?.payload["tenantName"]).toBe("cmf");
    expect(info?.expiresAt).toEqual(new Date(1789253999 * 1000));
  });

  it("classifies a host access token as non-PAT", () => {
    const info = decodeJwt(jwt({ userAccount: "CMF\\admin", iss: "CMFHost", aud: "Applications" }));
    expect(info?.isPat).toBe(false);
    expect(info?.expiresAt).toBeUndefined();
  });

  it("returns undefined for non-JWT strings", () => {
    expect(decodeJwt("not-a-jwt")).toBeUndefined();
    expect(decodeJwt("a.b")).toBeUndefined();
    expect(decodeJwt(`x.${Buffer.from("not json").toString("base64")}.y`)).toBeUndefined();
  });
});
