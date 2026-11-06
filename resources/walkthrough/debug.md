# Debug a DEE action live

1. **Enable DEE Debug Mode** on the action (bug icon on the row). The host now compiles that
   action **from your local file** on every execution — for your user only, in memory.
2. **Attach Debugger to MES Host** — one coreclr attach covers DEE actions and your custom
   `Cmf.Custom.*` DLLs. If `vsdbg` is missing from the host, you are offered a one-click install.
3. Set a breakpoint inside the markers and trigger the action from the MES UI. Edits take
   effect on the next execution without saving to the MES (**hot reload**).

Things the extension checks for you:

- a Linux host that still emits Windows-only symbols (product bug #158143) is detected and you
  are offered **Patch Host for Debugging**;
- breakpoints that do not bind within a few seconds get a notice with the likely causes;
- debug registrations are removed when you close the window, and a host restart that dropped
  them is reported with a one-click re-enable.
