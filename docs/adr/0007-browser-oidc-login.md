# ADR 0007 — Tiered authentication: browser OIDC sign-in with DevTools-capture fallback

Status: **proposed / deferred** (2026-08-15)

> **Deferred — kept as a design record for a future improvement.** A working implementation
> of the browser OIDC sign-in tier was built and then **removed** on 2026-08-15: against the
> real MES stacks it cannot complete (the Security Portal has no public loopback client, and
> its forward-auth sends the loopback redirect into an unbounded 431 loop — see
> `docs/upstream/workitem-3-securityportal-public-client.md`), so it delivered no user value
> while adding a network/loopback surface to maintain. The design below stands as the plan to
> revisit **once upstream work item 3 lands** (a public PKCE client with loopback redirects).
> Until then the extension ships only the two existing credential methods (PAT and
> browser-copied access token), offered through the *Set Credentials* chooser.

## Context
Authentication today has two entry points (ADR 0002): a Personal Access Token (long-lived,
sent as Basic auth) or an access token the user copies by hand out of the browser's DevTools
Network tab (sent as Bearer). The DevTools copy is the only option on stacks without a PAT
page, and on Security Portal stacks that access token expires after ~1 hour — the single
most common support issue. Neither is a real "sign in" experience.

The Security Portal exposes standards-compliant, tenant-scoped OIDC discovery on every
version we tested (11.2.5 local and 12.0 dev), advertising auth-code + PKCE `S256`:

```
{host}/SecurityPortal/tenant/{tenant}/.well-known/openid-configuration
```

This makes an RFC 8252 native-app flow (open the system browser, catch the redirect on a
loopback listener, exchange the code with PKCE) technically possible — *if* a suitable
client exists. It does not yet: the only known client (`MES`) is confidential (token
endpoint advertises only `client_secret_*`) with a fixed redirect URI, so a distributed
desktop tool cannot use it. That gap is filed upstream (`docs/upstream/workitem-3-*`).

A VS Code extension also *cannot* observe the user's browser traffic or read cross-origin
responses inside a webview, so "embed the login page and scrape the header" is not an
option — capture is always a manual DevTools step, and proper sign-in must be a real
loopback OIDC flow, not interception.

## Decision
Authentication is a **tier ladder**; the extension picks the highest tier the environment
supports and always leaves the lower tiers reachable.

1. **Browser OIDC sign-in (preferred).** Fetch the tenant discovery document, open the
   `authorization_endpoint` in the system browser with auth-code + PKCE `S256` and a
   `http://127.0.0.1:<ephemeral-port>` redirect, receive the code on a one-shot loopback
   listener, and exchange it at the `token_endpoint`. Persist the refresh token (when the
   client issues one) to silently renew — killing the 1-hour-expiry problem. **Gated on
   upstream work item 3** (a public/native client with loopback redirects). The extension
   does **not** probe for that client up front: **Sign in with Browser…** is always offered,
   and where no public client is registered the flow runs to the token exchange and fails
   there with an actionable message ("no public client registered for loopback sign-in yet")
   that steers the user to the fallback tiers. (A future refinement could pre-read the
   discovery document's grant/PKCE metadata to hide the option when it cannot succeed.)
2. **Guided browser + DevTools capture (universal fallback).** Used for 11.x/below, when
   discovery is absent or fails, or when no public client is available. The extension opens
   the MES login URL for the user and walks them through copying the bearer token from the
   Network tab — the existing "Set Access Token…" flow, surfaced as an explicit
   **"Sign in via browser"** action rather than a manual chore.
3. **Personal Access Token.** Unchanged; the long-lived option for daily work and for
   automation-adjacent use.

Discovery is attempted at the tenant-scoped well-known path; the tenant is taken from the
environment (already present in the host login redirect, promptable otherwise). All tokens
continue to live in `SecretStorage` per environment (ADR 0002) — OIDC adds a refresh-token
slot alongside the existing access-token and PAT slots. Precedence and redaction rules are
unchanged. No custom protocol handler is introduced; the loopback listener is the redirect
target, consistent with the no-extra-moving-parts posture.

## Implementation status — built, then removed (deferred)
A full implementation existed briefly (`core/oidc.ts`, `vscode/oidcLogin.ts` with a loopback
listener, a `deeDebugger.signIn` command, a `CredentialStore` refresh-token slot with silent
renewal, and `signIn.*` settings) and was **removed on 2026-08-15** because it could not
complete against any available MES stack:

- The Security Portal token endpoint is a **confidential client** (`client_secret_*` only) and
  no public/loopback client is registered — the code exchange fails (verified 11.2.5 and 12.0).
- With a loopback `redirect_uri`, the portal's `/iis/` forward-auth enters an **unbounded
  redirect-wrapping loop that terminates in HTTP 431**; the login is SPA/SSO-mediated and can't
  be driven by a plain client. (Both captured in work item 3.)
- A live robustness note worth keeping for the revival: the tenant-scoped discovery endpoint is
  sometimes itself behind forward-auth and 302s to a login page whose headers overflow Node's
  HTTP parser, so any future `fetchDiscovery` must not follow redirects.

Reviving this tier is gated on **upstream work item 3** (a public PKCE client with loopback
redirects, exempted from the forward-auth wrapping). The removed code is recoverable from git
history (feature commit `77e4c04`).

## Consequences (if/when revived)
- The good experience (real sign-in, no expiry pain) is unlocked only once upstream work item 3
  lands; before that the extension ships the two existing credential methods only.
- One more secret slot per environment (refresh token); it must follow the same never-logged,
  never-in-settings rules as the others.
- Tenant must be known before discovery — acceptable, it is already part of connecting.
- The loopback listener binds a short-lived localhost port during sign-in only; it accepts
  exactly one request (the redirect) and closes. State/PKCE verifier guard against a
  cross-site or replayed callback.
- Supersedes nothing: ADR 0002 still governs storage; this ADR governs how a token is
  *obtained*.
