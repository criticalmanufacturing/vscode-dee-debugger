# Work item 3 — No public OIDC client for developer tooling (blocks browser sign-in)

**Title:** Register a public/native Security Portal OIDC client with loopback redirect
URIs (and refresh tokens) for developer tools

**Area:** Platform / Security Portal (IdentityServer/OIDC configuration)
**Severity:** Medium — developer tools can authenticate today only via long-lived PATs
or manually-copied browser bearer tokens; there is no supported first-party sign-in flow.
**Affects:** Security Portal, verified against MES 11.2.5 (local `cmf dev local stack`)
and 12.0 (`dev-120-mes.apps.rhos.cm-mes.dev`).

## Description

The Security Portal already exposes standards-compliant OIDC discovery, tenant-scoped:

```
{host}/SecurityPortal/tenant/{tenant}/.well-known/openid-configuration
```

Both versions we tested advertise the pieces a desktop tool needs for the standard
"sign in with your browser" pattern (RFC 8252 native-app auth-code + PKCE loopback):

| Field | 12.0 (`MesDevelopment`) | 11.2.5 local (`cmf`) |
| --- | --- | --- |
| `authorization_endpoint` | `…/tenant/{t}/login` | `…/tenant/{t}/login` |
| `token_endpoint` | `…/api/tenant/{t}/oauth2/token` | `…/api/tenant/{t}/oauth2/token` |
| `response_types_supported` | `code`, `token` | `code`, `token` |
| `code_challenge_methods_supported` | `S256`, `plain` | `S256`, `plain` |
| `token_endpoint_auth_methods_supported` | `client_secret_basic`, `client_secret_post` | `client_secret_post` |
| `introspection_endpoint` | present | absent |

The blocker: the only known registered client (`client_id=MES`, the one the MES UI uses)
is a **confidential client** — the token endpoint advertises *only* `client_secret_*`
authentication, and the UI client has a **fixed redirect URI** back into the portal's own
`/iis/authentication/success` flow. A desktop tool (a VS Code extension) cannot use it:
embedding a client secret in a distributed application is not a secret, and the tool cannot
register its own dynamic `http://127.0.0.1:<port>` loopback redirect against a client whose
redirect URIs are fixed.

Result: developers authenticating a local tool are pushed onto either a long-lived PAT
(where the Security Portal offers a PAT page at all) or hand-copying the bearer token out
of the browser's DevTools Network tab — the latter expiring after ~1 hour on Security
Portal stacks.

## Proposal

Register a dedicated **public / native OIDC client** for first-party developer tooling:

1. **Public client** (no secret), auth-code grant with **PKCE `S256` required**.
2. **Loopback redirect URIs** allowed per RFC 8252 §7.3 — accept `http://127.0.0.1:*`
   and `http://localhost:*` with an arbitrary port (the tool picks a free port at runtime).
3. **Refresh tokens** issued to this client, so a signed-in developer is not forced to
   re-authenticate every hour — this is the single biggest day-to-day pain the current
   bearer-copy flow imposes.
4. A stable, well-known `client_id` (e.g. `MES-DevTools`) documented alongside the
   discovery endpoint, so tools need only the host + tenant to bootstrap.

Scope this to **development/test** environments if production posture is a concern; the
extension's primary use case is a developer's own local or shared dev stack.

## Live findings (11.2.5 local stack, 2026-08-15)

Driving the flow against a real stack surfaced two portal-side behaviours that a public
client registration alone does not fix — both should be addressed as part of this ask:

1. **The loopback (external) `redirect_uri` triggers an unbounded forward-auth redirect
   loop.** Requesting `…/tenant/{t}/login?…&redirect_uri=http://127.0.0.1:<port>/callback`
   302s to `…/login?…redirect_uri=http://<host>/iis/authentication/success?redirect_uri=<base64>`,
   and each hop re-wraps the previous URL into a new base64 blob. The request headers grow
   every hop until the server returns **HTTP 431 (Request Header Fields Too Large)**; a
   plain HTTP client (and Node's `fetch`, which the extension uses) never reaches a login
   form. The loopback redirect must be recognised and **exempted from the `/iis/`
   forward-auth SSO wrapping**, not funnelled through it.
2. **The login is SPA/SSO-mediated, not a linear form flow.** The `/iis/authentication/success`
   SSO probe is meant to be short-circuited client-side by the SecurityPortal Angular app;
   followed linearly it loops indefinitely and sets no session cookie. This is expected for
   an interactive browser, but it means the authorize step genuinely requires a real browser
   (which the extension's design already assumes) — and it is why the loopback client must
   be registered such that the browser, after login, is redirected **straight to the
   loopback with `?code=…`** rather than back into the SSO wrapper.

The token endpoint's confidential-only auth (`client_secret_*`, verified on 11.2.5 and
12.0) remains the primary blocker: even with a captured code, exchange fails without a
public (PKCE-only) client. Items 1–2 above ensure the *authorize* half also works once
that client exists.

## Field impact today

The DEE Debugger for VS Code extension designed a tiered auth model (repo ADR 0007, status
proposed/deferred; the prototype was removed 2026-08-15): browser-based OIDC sign-in where a
suitable public client exists, falling back to guided browser + DevTools bearer capture, with
PAT as the long-lived option. Tier 1 — the good experience — is gated entirely on this client
registration; the extension currently ships only PAT and browser-copied access token. Until it lands, every
developer either manages a PAT by hand or re-copies a bearer token from DevTools roughly
once an hour. Evidence and endpoint details: DEE Debugger repo, ADR 0007 and this file.
