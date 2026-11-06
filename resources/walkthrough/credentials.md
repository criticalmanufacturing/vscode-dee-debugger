# Authenticate

Run **Set Credentials…** and choose:

- **Personal Access Token** (recommended) — created in the Security Portal, user page →
  *Personal Access Tokens*. Long-lived; the extension sends it the way the MES forward-auth
  expects.
- **Access Token** — copied from the browser DevTools of a logged-in MES session. Expires
  after about an hour.

Tokens are stored in the OS keychain (VS Code SecretStorage), per environment, and are never
written to settings or logs. A rejected token shows up as a *login page instead of data*
error — just set a new one.
