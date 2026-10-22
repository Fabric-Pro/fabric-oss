# ADR-023: Task defaults are pinned per provider connection

Changing the catalog's default models changes them for new provider connections only.

- **Audience**: Platform and AI engineers
- **Owner**: AI / Platform team
- **Status**: Accepted
- **Date**: 2026-10-21
- **Deciders**: The product owner, AI / Platform team

## Context

When an organization has no explicit model pick for a task, its model comes
from the task-default template (`TASK_DEFAULTS` in
`packages/database/prisma/ai-model-catalog.ts`, seeded into
`ai_task_model_default` on every deploy). Resolution read that table live, so
editing a default moved every tenant without a pick on the next deploy.
Switching or connecting a provider wrote no model choice, so there was no
record of what a tenant ran.

Moving defaults to newer models therefore needed a production count and a
one-off data migration each time, or it silently changed what existing
tenants run.

## Decision

Each provider connection (`cloud_provider_config`, `user_cloud_provider_config`)
stores `task_defaults_snapshot`: for the six text task types, the result of the
two template lookups the resolver makes — the connection's own provider
(`scoped`) and any provider (`unscoped`) — as canonical model names, or `null`
when the lookup found nothing.

- The snapshot is captured when a connection is created and when it becomes the
  default provider (an explicit switch or an automatic promotion), in the same
  transaction as the `isDefault` change. Other edits keep it.
- `getTaskDefaultModel` returns the frozen result when it is given the serving
  connection; everything above it is unchanged. Explicit organization and user
  picks still win.
- DECISION, EMBEDDING, IMAGE and AUDIO keep their own policies and read the live
  template. So do calls with no connection row (the platform gateway key, the
  ChatGPT plan).
- Migration `20261021180000_pin_task_defaults_on_provider_connections` froze
  every connection that existed when it ran.

To change defaults, edit `TASK_DEFAULTS`. Existing connections keep their
models; new connections and provider switches get the new ones.

## Consequences

- A connection created between a release's migration and its `deploy:seeds`
  run captures the previous template.
- A pinned model that is later deprecated follows its replacement, as explicit
  picks do. A pinned model removed from the catalog falls back to the live
  template with a warning.
- Rolling back to a release that predates this decision makes every tenant read
  the live template again; redeploying that release reruns its seeds, which
  restores its template.
- Code-level defaults that are not stored per connection (`DEFAULT_FABRIC_AI_MODEL`
  for the chat default, MCP sampling and cost estimates) still apply on deploy.
