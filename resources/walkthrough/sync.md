# Keep your Actions project in sync

Your customization repo keeps `.cs` copies of the DEEs for code review and source control.
The three **Sync** commands (view `…` menu) compare marker bodies only, so generated wrapper
noise never shows up:

- **Sync: Compare Local DEEs with MES** — in sync / differs / local-only / MES-only, with a
  diff editor per entry.
- **Sync: Download Changes from MES** — new files get the full generated wrapper; existing
  files keep their layout.
- **Sync: Upload Local Changes to MES** — compiles each file on the host; a local-only file
  **creates** the action (enabled, as a version-1 draft) and you are offered to make it
  effective.
