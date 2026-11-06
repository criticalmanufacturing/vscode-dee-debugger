# Connect to a MES environment

An **environment** is a named connection profile: the MES API address plus how to reach the
host container (for file delivery and debugger attach). Each environment keeps its own
credentials.

- **Discover Environments** probes this machine for local Docker stacks, docker-in-docker
  devcontainers (`cmf dev local stack up`) and a local host process, and pre-fills everything.
- **Add Environment Manually** covers remote Docker, Kubernetes / OpenShift and custom engine
  commands.

The active environment is shown in the status bar (`MES: <name>`) and at the top of the DEE
Explorer. Click either to switch.

> Development and test environments only — debug mode and attach are privileged operations.
