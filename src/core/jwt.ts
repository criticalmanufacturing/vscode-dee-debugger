/**
 * Minimal, verification-free JWT payload decoding — used only to classify tokens the
 * user pastes (access token vs PAT) and to read expiry for friendlier messages.
 * Security Portal PATs are JWTs carrying `"type": "PAT"` and must be sent as
 * Basic auth, while access tokens go as Bearer; users routinely paste one into the
 * other prompt, so the prompts auto-route based on this.
 */

export interface JwtInfo {
  payload: Record<string, unknown>;
  /** True when the token declares itself a Personal Access Token. */
  isPat: boolean;
  /** Expiry as a Date when the `exp` claim is present. */
  expiresAt?: Date;
}

export function decodeJwt(token: string): JwtInfo | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json);
    if (typeof payload !== "object" || payload === null) return undefined;
    const exp = (payload as Record<string, unknown>)["exp"];
    return {
      payload,
      isPat: (payload as Record<string, unknown>)["type"] === "PAT",
      expiresAt: typeof exp === "number" ? new Date(exp * 1000) : undefined,
    };
  } catch {
    return undefined;
  }
}
