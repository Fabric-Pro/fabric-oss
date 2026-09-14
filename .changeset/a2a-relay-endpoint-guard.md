---
"fabric-app": patch
---

The A2A relay and agent delegation no longer let the server be aimed at an address the deployment has not permitted

Fizzy #2380, QA round 2. The SSRF guard from the previous round covered agent
discovery and registration and never reached `POST /api/agents/a2a/send`, which
takes `agentUrl` straight from the request body, performs no lookup and cross-
checks it against no stored `deploymentUrl`, behind nothing but a bare session
check.

This route is the sharper of the two. The registry procedures return a health
flag and a response time, so aiming them inward leaks reachability. This one
hands the chosen destination `X-Service-Token` — the inter-agent shared secret
— and `X-AI-Token`, which is exchangeable for real provider credentials. It
also read `organizationId` off the same body and passed it unvalidated into
model selection, RAG configuration and the AI token it issues, so membership is
now checked before any of that runs.

The guard moved from `@repo/api` to `@repo/utils/agent-endpoint` to make this
reachable at all: the Temporal activities and this web route both need it, and
neither can import `@repo/api`, because `@repo/api` depends on
`@repo/temporal`. `@repo/api` keeps the oRPC wrapper that turns a refusal into
an `ORPCError`, so the seven registry call sites are untouched. The route maps
the refusal to a 400 itself — an `ORPCError` thrown inside a Next route handler
would have surfaced as a 500 through its catch-all.

Delegation now checks the stored `deploymentUrl` at request time, following the
guard's own rule that the request is what must be checked rather than only the
write: a stored URL can be rewritten by a later update, can predate the guard,
or can arrive from a path that never went through the registration procedures.
One check covers the health check, the send and the poll.

The weave activities are deliberately not guarded: their destination comes from
`requireServiceUrl`, the operator's own environment, not from a caller or a row.
