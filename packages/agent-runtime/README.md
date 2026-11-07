# Governed Harness signal triage

- **Audience**: Fabric runtime and software-factory engineers
- **Owner**: Fabric platform engineering

`createSignalTriager` from `@repo/agent-runtime/harness/triage` creates a finite agent using the published
`@fabric-harness/sdk/strict` 6.9.0 contract. It reads selected evidence and returns private proposals. The first platform adapter supports private
Slack root-message observations; other sources need their own governed revision/audience adapters.
Temporal remains the owner of outer scheduling and durable recovery. This module neither creates
stories nor sends messages, deploys code, registers a remote target, or enables a Portal feature.

## Trusted host interface

A host supplies all implementations of `SignalTriagerHost` through server configuration, never the
request body. `resolveAuthority` must verify the admitted run, actor, organization, project, release,
model pin, immutable input hash, originating credential scope ceiling and original evidence grants. SDK tenant/principal fields are checked
against that authority but are not authentication. The input accepts only a bounded goal and selected
evidence IDs; it cannot select a model, target, policy, budget or organization.

The platform adapter `createPrivateTriageEvidenceReader` in the API project module binds the authenticated
actor/project and reuses the existing authorized fresh-evidence command. It rechecks original pins
before and after provider proof and propagates the host cancellation signal. Its mandatory server-resolved credential discriminator preserves an API key’s declared read-scope ceiling; current key validity and creator permissions must also be checked by the verified host on every phase. It must still be bound
to a verified finite host; it does not authenticate an arbitrary job by itself.

`authorize` repeats the originating credential scope ceiling plus the creator's current actor/project
and original source-grant permissions (including wildcard credentials) for run, model, source
and result access. `readEvidence` must use Fabric's fresh source-evidence checks: current provider ACL,
original immutable grant/revision/digest, expiry and current object access, including checks after
provider I/O. Retained plaintext, an ID lookup or a digest supplied by the request is insufficient.
Every selected item must be read before any result, including an empty proposal list. All selected
items are checked again before disclosure; even unchanged pins with changed text cause refusal.

`budget.reserve` must use an atomic durable ledger owned by this finite execution. It grants
`SEND_ONCE` only for a new immutable call identity, semantic request digest, model and output cap.
For an already settled call it can return `REPLAY` with the same pins and its verified encrypted
response artifact. Replays repeat authorization, usage/schema validation and fresh source reads;
they neither send nor settle again. A duplicate with no confirmed response, a request-digest
conflict, or unknown spend must refuse dispatch. Cleanup/settlement waits are bounded independently of run cancellation, and a cleanup error must not replace the original sanitized stop reason. Call IDs remain stable across retries. Do not
fabricate a conversation turn, release unknown spend, or use an in-memory counter in production.
`settle` and `markUnknown` must be idempotent and monotonic: a lost settlement response cannot erase
a completed charge. The semantic digest binds model/messages/tools/output cap, excluding transport
nonces and cancellation signals; it does not grant permission.

The host must durably store an encrypted, owner-scoped response before a call becomes replayable.
Cached content expires with its original evidence and remains subject to current source access,
revocation and deletion. Never put source/model bodies into Temporal history or a content-free
budget ledger. Future status/event/result endpoints must reauthorize the original source audience
before returning any derived text, including previously completed proposals.

`generateOne` makes exactly one physical request through Fabric's configured model factory and
current dispatch guard. Disable provider/SDK retries, fallback, account rotation and background
ChatGPT-plan use unless each physical send independently passes the durable reservation and current
permission checks. The host tokenizes/prices the actual wire request against its approved catalog,
enforces the supplied output cap, verifies the explicit reservation/call identity, and propagates
cancellation. Settlement retains separately billable cache writes, cached reads and reported cost;
unknown or unsupported billable usage remains reserved rather than being treated as free. The agent's byte limit and the SDK's
post-charge cost ceiling are not financial admission controls. Missing or invalid usage withholds the
result and retains uncertain spend. Cancellation before dispatch releases only the unsent reservation;
cancellation or failure after dispatch retains it for reconciliation.

## Result audience and limits

Results carry `PRIVATE_OWNER` audience and `SELECTED_EVIDENCE_ONLY` coverage, at most three proposals,
stable proposal IDs, uncertainties and exact original evidence pins. They are not project-wide Inbox
entries. A future review/apply command must independently authorize any sharing or application and
must preserve source audience restrictions. Raw model events and session state are not persisted by
this definition; a host must also prevent its surrounding journal, traces and HTTP event endpoints
from disclosing private prompts, tool results or generated text.

The agent permits up to five selected items, six model calls, ten model-requested fresh reads plus a separate final proof for
each selected item, 16 KiB per source text, 2 MiB per serialized model request, 64 KiB per response, 2,048 output tokens per
call and a 60-second containing deadline. The byte cap includes JSON escaping and accumulated tool turns; it does not authorize a larger financial budget. The model cap comes from the verified host and may be
lower. Shell, filesystem, provider-write and arbitrary network tools are denied. There is no model
fallback or automatic trigger.

## Implementation stage and verification

The finite engine now has an API-owned host, a dedicated Temporal workflow/worker, encrypted private
results and completed-call caches, and a separate organization/month budget ledger. The initial
configured-model bridge supports saved direct OpenAI API configurations with catalog pricing and a
pinned route. Other provider bridges, scheduling, and generic Remote/Desktop targets remain unsupported;
no ordinary remote session is treated as a verified Harness host.

Portal source watches offer a **Review signals** drawer. The product operations are `list`, `start`,
`status`, `result`, `cancel`, and `review` (`KEEP` or `DISMISS`). They share canonical authorized commands
through oRPC, `/api/v1/projects/{projectId}/delivery/triage`, SDK `projects.*Triage*` methods,
`fabric projects triage`, and `fabric_triage_*` MCP tools. MCP Apps hosts can inspect cited results
through `ui://fabric/private-triage`; ordinary MCP text results remain available. Keeping a proposal
is private bookkeeping, not ticket creation, publication or sharing.

The dedicated worker entry point is `scripts/harness-triage-worker.ts`. It registers hourly native
Temporal retention and polls only `fabric-harness-triage-v1`; it does not replace existing workers.
Use the same organization database, encryption configuration and authenticated Temporal deployment
as the Portal, with a qualified `fabric_worker` database connection. The native namespace must
retain workflow histories for at least seven days. Do not enable starts until that worker, the additive migrations and private-source
capture are available. Set `FABRIC_HARNESS_TRIAGE_ENABLED=true` and an explicit
`FABRIC_HARNESS_TRIAGE_MONTHLY_MICRO_USD` ceiling through operator configuration. The per-run ceiling is
the smaller of that ceiling and 250,000 micro-USD, alongside 196,608 conservative reserved tokens;
all runs share a monthly ceiling and two-million-token limit. Known-unsent reservations are released at terminal completion or cancellation. Unknown spend remains held. Public
inputs cannot raise these limits or choose a provider, model, policy, actor or execution host.

Model calls are replayed only from settled encrypted responses with identical semantic digests.
Dispatched requests without confirmed settlement never authorize another send. Source revocation
and integration deactivation, credential rotation, integration deletion or observation deletion
purge derived encrypted bodies; expiry retention removes bodies while retaining accounting and
request identities for retry fencing. Failed native acknowledgements remain explicit uncertainty.

Live source/model/remote qualification is deliberately the final rollout step, after local integration
and transport/security checks. This implementation does not certify an untested paid provider or
remote endpoint.
Run `pnpm --filter @repo/agent-runtime test` and `pnpm --filter @repo/agent-runtime type-check`.
Tests exercise the actual strict SDK/native loop with controlled host/model/evidence/ledger ports,
including tenant mismatch, injected tools, read/citation constraints, cancellation, uncertain spend,
revocation, concurrent runs and retry admission. They do not certify a real model, source, durable
ledger, hosted Node runtime or remote broker.
