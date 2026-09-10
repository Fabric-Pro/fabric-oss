# AGENTS.md — Fabric engineering guidance

IMPORTANT: Also read and follow `AGENTS.local.md` when it exists. It contains
untracked user preferences; never add it to git or copy its private content into
tracked files.

This repository is public. Use these instructions as the always-loaded control
plane, then read the linked guidance required for the files you will change.
Markdown links are routing, not automatic includes.

## Authority and conflicts

Accepted ADRs record architectural decisions. Path-specific standards and
canonical topic documentation provide implementation detail. This file keeps
cross-repository invariants that must survive every task.

When two sources conflict:

1. Follow the most recent accepted ADR for architectural intent.
2. Verify current behavior in source and tests.
3. Surface the contradiction instead of silently choosing stale guidance.
4. Reconcile the authoritative documentation in the same change when it is in
   scope.

See [ADR-019](docs/adr/019-layered-agent-guidance.md) for the structure and
maintenance policy of agent guidance.

## Repository map

Fabric is a Next.js 16, React 19, TypeScript 5.9, Node.js 22+, pnpm 11
monorepo. Main areas:

| Path | Responsibility |
|---|---|
| `apps/web/` | Next.js application and UI modules |
| `packages/api/` | Hono and oRPC procedures, middleware, routers |
| `packages/database/` | Prisma schema, queries, tenant extension, RLS |
| `packages/ai/` | Model/provider integration |
| `packages/temporal/` | Workflows and activities |
| `packages/mcp/` | MCP integration |
| `agents/` | LangGraph agents |
| `deployment/` | Infrastructure and deployment definitions |
| `fabric/standards/` | Detailed engineering standards |

Shared domain terms are defined in [CONCEPTS.md](CONCEPTS.md).

## Required reading by change area

Read these documents before modifying matching paths. Root rules in this file
still apply.

| Change area | Read first | Minimum validation |
|---|---|---|
| Tenancy, authentication, authorization, routes | [ADR-018](docs/adr/018-organization-is-the-only-tenant-context.md), [API standards](fabric/standards/backend/api.md) | authorization and tenant-boundary tests |
| Prisma schema, queries, migrations, RLS | [Migration standards](fabric/standards/backend/migrations.md), [model standards](fabric/standards/backend/models.md), [query standards](fabric/standards/backend/queries.md) | generate client; targeted database/tenant tests; migration status when a DB is available |
| Temporal workflows or activities | [Temporal standards](fabric/standards/backend/temporal.md), [Temporal durability](docs/workflows/temporal-durability.md) | targeted workflow/activity tests; replay validation for workflow changes |
| AI models, providers, prompts, agents | [LLM standards](fabric/standards/ai/llm-integration.md), [agent standards](fabric/standards/ai/agents.md) | targeted provider/agent tests |
| React/UI | [UI style guide](docs/ui-style-guide.md), [component standards](fabric/standards/frontend/components.md), [accessibility](fabric/standards/frontend/accessibility.md) | focused component tests and accessibility checks |
| Deployment and Azure | [Deployment standards](fabric/standards/infrastructure/deployment.md), [Azure guide](deployment/azure/README.md) | template/script validator and relevant deployment tests |
| Audit log | [Audit architecture](docs/audit-log/architecture.md), [API](docs/audit-log/api.md) | taxonomy, authorization, redaction, and API tests as applicable |
| Release/changeset work | [fabric-app release contract](packages/fabric-app/README.md), [deployment flow](docs/deployment.md) | changeset status JSON or explicit skip decision |
| Documentation | [Documentation standards](DOCUMENTATION_STANDARDS.md) | links, metadata, and canonical-location review |

## Tenancy and authorization

An organization is the only tenant context.
Do not add or restore a personal route, personal product surface, or a second
live tenancy branch. The
`organizationId: null` arm retained in some helpers is a fail-closed default;
reaching it in user-facing code is a resolution bug.

Tenant filters remain exclusive. Never combine user and organization arms with
`OR`:

```typescript
const tenantFilter = organizationId
  ? { organizationId, userId }
  : { organizationId: null, userId };
```

Prefer `tenantProtectedProcedure` and tenant-aware database helpers. When manual
resolution is necessary, use `resolveOrganizationId()` and verify the caller's
tie to the resolved organization or object. Key implementations live in
[oRPC procedures](packages/api/orpc/procedures.ts) and the
[tenant database extension](packages/database/src/tenant-db.ts).

For project reads use `hasProjectAccess`; for writes use `canEditProject`; use
`getProjectRole` only when behavior genuinely depends on the role. An
organization membership check does not replace object-level access for invited
project guests.

### API keys never grant more than the UI

Every API-key surface independently checks:

1. the key's declared scope; and
2. the creator's current permission or role.

The live permission check is unconditional, including wildcard `*` keys. Keep
scope failures distinguishable from permission failures. Before tightening a
key-backed tenant filter, compare the in-app query for the same resource so the
API is neither broader nor accidentally narrower.

### Tenant propagation

Pass `organizationId` through every layer that accepts it: API procedure,
workflow input, workflow, activity, database query, MCP client, and AI model
resolution. Do not let `undefined` silently select the null/fail-closed arm.
Every new workflow start originating in a request must also use the repository's
correlation-memo helper when applicable.

The intentional prompt-binding exception is user-preference precedence inside
an organization. Keep the four resolution/status/catalog queries aligned and
run [its regression test](packages/database/__tests__/personal-override-in-org-context.test.ts)
when changing that behavior.

## Security and auditability

This public repository must contain only synthetic identifiers.
Never copy a real organization, person, deployment hostname, internal URL,
credential, or private ticket text into source, fixtures, comments, runtime
strings, screenshots, branch names, commits, PRs, or changesets. Use values
such as `example-org`, `example.com`, and `dev@example.com`. Run the identifier
guard when externally supplied context influenced written content.

Git author metadata and the contributor identity required by DCO sign-off are
the necessary exception; do not reuse those identities as example data.

Do not log or persist secrets. Audit metadata and `resourceName` must never
contain credentials; use the shared sensitive-key redactor as defense in depth,
not as permission to pass secrets.

Security-relevant mutations must emit the appropriate audit action. Inside oRPC
handlers, normally use `recordAuditFromRequest`; use `recordAuditTx` when the
audit row and business mutation must commit atomically. Do not duplicate generic
error auditing already handled by the outer error middleware.

Authorization checks belong at the server boundary and must be repeated in
background activities when the activity independently loads tenant data. Never
trust a client-provided `organizationId`, role, ownership field, or API scope
without server-side resolution.

## Database and migration safety

Never run `prisma db push`.
Every schema change requires a reviewed migration. Do not edit an
already-deployed migration or manipulate `_prisma_migrations`
history as routine recovery. If local history and schema disagree, stop and
diagnose the exact branch/database state before making a destructive repair.

For a schema change:

1. edit `packages/database/prisma/schema.prisma`;
2. create a focused migration with `prisma migrate dev`;
3. inspect the generated SQL;
4. regenerate Prisma and Zod clients;
5. update [RLS policies](packages/database/scripts/apply-rls-direct.ts) for
   tenant-aware tables;
6. run targeted tenant and migration validation.

Use additive/expand-contract migrations for production compatibility. Separate
long-running data backfills from blocking schema changes.

## Durable and paired surfaces

Temporal workflows must remain deterministic. Put I/O, clocks, random values,
and environment reads in activities. Make activities idempotent because retries
are normal. Changes to workflow control flow require replay validation against
representative histories.

When changing one side of an intentionally paired surface, inspect and test the
sibling in the same task:

- MCP management dialogs:
  [primary](apps/web/modules/saas/mcp/components/McpServersView.tsx) and
  [settings](apps/web/modules/saas/settings/components/mcp/components/McpConfigDialog.tsx).
- Slack and Teams integrations: preserve portable behavior while keeping
  provider-specific differences explicit.
- Document editors: compare both implementations before changing shared
  streaming/diff behavior.

When adding, renaming, removing, or feature-gating navigation, tabs, settings,
or covered page components, update the
[Get Started registry](apps/web/modules/saas/get-started/lib/get-started-registry.ts),
[tour steps](apps/web/modules/saas/get-started/lib/tour-steps.ts), anchors, and
translation copy together. Run its drift test.

## Testing and validation

Treat a failing test as evidence of a possible production regression. Before
weakening an assertion or mock, trace the actual value to source and history.
Update tests only when the intended contract changed; never make the test agree
with an unexplained regression.

Use the narrowest validation that proves the change, then expand in proportion
to risk. Run sibling render tests when shared UI queries, mutations, or hooks
change. State plainly which checks ran, failed, or could not run. Do not report a
missing executable, unavailable service, timeout, or read-only filesystem as a
pass.

Common commands from the repository root:

```bash
pnpm type-check
pnpm lint
pnpm format:check
pnpm knip
pnpm test
pnpm guidance:check
```

Do not automatically run the full suite for a localized change when focused
tests plus static checks provide the necessary evidence. Conversely, do not use
a focused test to claim unrelated packages are healthy.

## Changesets and delivery

Every PR must choose exactly one: a non-empty changeset or the `skip-changeset` label.

Every PR requires an explicit release decision before its first push and again
after later revisions:

- User-visible or production-shipping behavior needs a non-empty changeset,
  normally `"fabric-app": patch` plus any genuinely published
  `@fabricorg/*` package. Never list internal `@repo/*` packages.
- Docs-only, CI-only, Markdown-only, and pure changeset edits are normally
  eligible for the `skip-changeset` label. Other changes may skip only when
  they genuinely have no user-visible or deployable effect.

For an impacting change, run `pnpm exec changeset status
--since=origin/master --output=<temporary-json>` and verify that `.releases` is
non-empty. Exit code zero with `"releases": []` is not success. For a
non-impacting change, record the reason and apply `skip-changeset` as soon as
the PR exists; omission alone is not a decision. The CI contract is in the
[changeset workflow](.github/workflows/changeset-check.yml).

The first changeset body paragraph is public release text. Make it a complete,
specific sentence and keep ticket numbers, private context, and internal
hostnames out of it.

Every commit requires DCO sign-off through `git commit -s`.
Never add AI attribution or generated-by footers. Follow
[CONTRIBUTING.md](CONTRIBUTING.md) and the
[pull-request template](.github/PULL_REQUEST_TEMPLATE.md).

This repository lands through its OSS relay. Never run `gh pr merge` here. A
request to create or update a PR does not by itself authorize relay/publication;
relay only when the user's requested workflow includes landing. After every
push, any prior head-SHA authorization is stale.

## Workspace safety

- Preserve unrelated working-tree changes; they belong to the user or another
  agent.
- Do not run `git clean` in this repository.
- Do not restart containers, workers, or services unless the task requires it
  or the user asks.
- Do not commit, push, create a PR, relay, deploy, or message external systems
  unless the user has authorized that action.
- Before an authorized commit or push, inspect the diff, fetch incoming changes,
  and verify the final state. Use non-interactive git commands.
- Keep generated files generated: never hand-edit Prisma Zod output or other
  generated artifacts.
- Add dependencies with `pnpm add`/`pnpm remove`, not manual manifest edits.
