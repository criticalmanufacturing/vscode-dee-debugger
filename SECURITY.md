# Security policy

Please do **not** open public issues for security vulnerabilities.

Report them privately to Critical Manufacturing (contact@criticalmanufacturing.com,
or through your regular support channel referencing "DEE Debugger for VS Code").
Include the extension version (`CHANGELOG.md`/marketplace), reproduction steps, and —
if relevant — a support bundle (**DEE Debugger: Collect Support Bundle…**; it never
contains tokens).

Scope notes for researchers: the extension executes user-configured container-engine
commands (`environments[].engineCommand`) by design — reports should focus on paths
where a *workspace or remote party* can influence execution without the user's explicit
configuration. The extension declares that it does not support untrusted workspaces
(`capabilities.untrustedWorkspaces.supported: false`) precisely to prevent this: it does not
run, and so reads no environment profiles, in a workspace the user has not trusted.
