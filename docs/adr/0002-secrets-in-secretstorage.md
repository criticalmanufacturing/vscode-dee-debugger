# ADR 0002 — Tokens live in SecretStorage, set via commands

Status: accepted (2026-08-14)

## Context
The old add-in stored the Bearer token and PAT in plaintext Visual Studio settings. Tokens grant
full MES API access for up to 14 days.

## Decision
Access Token and Personal Access Token are stored per-environment in VS Code `SecretStorage`
(OS keychain), written only via explicit commands ("DEE Debugger: Set Access Token…" /
"…Set Personal Access Token…" / "…Clear Credentials"). Settings hold only non-secret config.
Tokens are never logged; error output redacts Authorization headers.

## Consequences
- No token sharing via settings sync/repo — acceptable (tokens are personal and short-lived).
- Headless/CI usage would need env-var fallback; out of scope for v1.
