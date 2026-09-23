---
"@fabricorg/cli": minor
"fabric-app": patch
---

`fabric instructions doctor` reports whether a machine is set up the way a project's published coding instructions expect, and the MCP gateway gains a `fabric_instruction_checks` tool that returns the same checks so an agent can self-diagnose at session start.

The CLI command verifies the API key and its scope, project access, the published version against the local lock and its ledger, local file drift, the SessionStart hook configuration for Claude Code and Codex, the environment variable names and tools a project declares in a new `fabric.environment.json` file at the root of its instruction set, and the servers listed in `.mcp.json`. Each finding names a fix. No declared variable's value is read, printed or transmitted, nothing named by the instruction set is executed, and network probes of `.mcp.json` servers run only with `--probe-network`. The MCP tool evaluates what the server can see and labels anything the caller reports (the lock digest, present variable names) as caller-reported evidence that was compared, not independently verified.
