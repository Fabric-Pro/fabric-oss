# Temporal guidance

Apply the root `AGENTS.md` first. Read
[Temporal standards](../../fabric/standards/backend/temporal.md) and
[durability guidance](../../docs/workflows/temporal-durability.md) before
changing workflows or activities.

- Workflows orchestrate deterministic control flow; activities own I/O,
  environment reads, wall clocks, randomness, and other side effects.
- Activities must be idempotent because retries are normal.
- Pass `organizationId` through workflow args and every activity/MCP/AI call.
- Preserve request correlation in workflow memo when a request starts the run.
- A workflow control-flow change requires replay validation against
  representative histories.
- If a new workspace package is used at runtime, inspect the Temporal
  container build inputs and dependency manifests together.

Run focused workflow/activity tests and the replay check when workflow history
compatibility can change. Do not restart the worker unless the task requires it
or the user asks.
