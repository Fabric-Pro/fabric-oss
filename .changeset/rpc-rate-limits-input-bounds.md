---
"fabric-app": patch
---

Every RPC call now has a per-caller ceiling, workflow starts are quota'd and idempotent, and the busiest user-typed inputs have a size limit

Three abuse gaps found together in the same review of the oRPC surface.

The API had rate-limit builders — `rateLimitedProcedure`, `aiRateLimitedProcedure`,
`workflowRateLimitedProcedure` — and nothing used them. Only the IP-keyed public
variant had call sites (eight, all forms and webhooks). An authenticated user
could call any of the roughly one thousand procedures as fast as they liked.
There is now one floor under all of them: 1000 requests per minute per user,
per client IP for the unauthenticated public procedures, configurable through
`RPC_RATE_LIMIT_PER_MINUTE` (`0` disables it). It is deliberately wide — the
shell is chatty, and the CopilotKit route alone budgets 500 a minute — because
it is an abuse ceiling rather than a product quota. A tripped call gets the
same 429 the codebase already sends, with `retryAfter` in the error data and a
`Retry-After` header, and is logged with the user and the procedure. The
per-route limiters keep their own tighter keys and are unaffected.

The limiter is a middleware mounted once on each base chain rather than an
interceptor on the HTTP handlers, for the reason the metric and audit
middlewares live there too: the protected chain knows the user only after its
session middleware has run, and that is where the per-user key has to be
computed. `protectedProcedure` no longer derives from `publicProcedure` so the
two chains each charge one bucket; deriving one from the other would have
charged every signed-in call to its IP as well, and an office behind one NAT
address would have shared a single budget. What Redis being missing means is
unchanged: fail closed in production, in-memory elsewhere.

Starting a workflow run held a worker slot and created a row on the plain
tenant builder with no quota at all — `workflowRateLimitedProcedure` is built
on the non-tenant chain, so no workflow procedure could adopt it. The workflow
preset (30 a minute) is now applied through a callable, the way the AI preset
already was. The same procedure accepts an optional client `idempotencyKey`; a
second start with the same key from the same user for the same workflow inside
five minutes returns the run the first one created instead of starting
another. The key is stored in the existing `triggerInput` JSON, so there is no
migration, and find-or-create is serialised on an advisory lock so the case
this exists for — a double-click whose second request lands while the first is
between its read and its insert — resolves to one run rather than two. A prior
attempt the engine refused is not a match, so "try again" still means that.
The workflow editor sends a key that is reused until the request settles.

Finally, almost no `z.string()` or `z.array()` input carried a `.max()`. The
columns behind them are `text` and `jsonb`, so a multi-megabyte "title" or a
chat message the length of a novel went straight through to storage or a model
call. The highest-traffic user-typed fields across the ai, agents, projects,
prompts, workflows and workspaces modules are now bounded: 500 characters for
names, titles, categories and search queries; 10,000 for descriptions and
goals; 200,000 for chat messages, prompt bodies, system prompts and work-item
descriptions; 500 entries for id and tag arrays. Document content is
deliberately left unbounded — the editor's update procedures accept any size
today and no ceiling is known to be safe for the largest existing document.
