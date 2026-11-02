# Fabric Agents Execution Bridge & Delegation Guide

End-to-end configuration, UI delegation workflow, delivery guarantees, and automated acceptance for executing coding runs on Fabric Agents (`fabric-agent-server`).

- **Audience**: Platform engineers, AI/Backend developers, and project leads
- **Owner**: Agent & Platform team

---

This consumer uses the existing Fabric Agents `/sessions` compatibility API. The
server delegates to ordinary Fabric workspaces and the native session manager;
there is no separate execution engine. Use a matching server build advertising coding protocol **2**, durable receipts, and whole-run cancellation. Published 0.15.21 is the earlier protocol baseline; installing it alone does not provide this contract. Qualify and release the matching server changes before opting in.

## Default-off rollout and cutover

`FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED` defaults to `false` on the application
API and Temporal worker. Existing coding runs continue using the legacy execution
protocol. Merely installing this code or changing the UI label does not enable the
native bridge. Backend/model/machine overrides require the native opt-in and are
rejected before a run is created when it is off.

Before enabling it, drain all active and paused Coding Runs and Weave executions, and verify authenticated `GET /sessions/drain` reports `drained: true`. Terminal application rows alone do not prove native background work stopped. Configure the matching
server below, then set `FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED=true` on **both**
the application API and Temporal worker and restart those application processes.
Both direct coding and approved Weave workflows capture the setting; a mismatched
API/worker setting fails before
creating a session. Configure the endpoint, service HMAC secret and dedicated
profile for that same cutover. Keep the setting, endpoint and profile unchanged
while runs exist; drain them before any rollback or endpoint change. A native
bridge error never falls back to the legacy backend or creates a replacement run.

With the flag off, legacy bot webhooks remain configured through `FABRIC_BOT_URL`
and `FABRIC_BOT_SECRET`; the API does not need worker credentials for those
follow-ups. The configured legacy HTTP session link is retained before cutover.
Native headless sessions never acquire a guessed link.

Azure's `main.bicep` accepts `fabricAgentsExecutionBridgeEnabled` (default false), `fabricAgentsDefaultConnection`, and `fabricAgentsDefaultModel`. `deployment/azure/deploy.sh` forwards the matching uppercase environment variables. Configure the same flag, endpoint, HMAC secret and connection/model on the separately deployed API. Hosted deployment pipelines maintain their own template copy: port these settings there before expecting a hosted change; see [Azure deployment guidance](../../deployment/azure/README.md).

Historical legacy and pre-cutover native workflow histories are covered by SDK
replay fixtures. These are compatibility checks, not permission to switch an
active run between servers.

## Configure a dedicated server

Set `BACKGROUND_AGENTS_URL` to the trusted HTTPS execution endpoint (or an owned
loopback SSH tunnel), and configure a dedicated service HMAC secret in
`BACKGROUND_AGENTS_INTERNAL_SECRET` on the application worker/API and server.
Use a random service secret of at least 32 characters; it is not a provider API
key. The adapter signs timestamped requests. Raw shared-secret bearer requests
are not supported by the corrected server.

The server needs a private `FABRIC_CONFIG_DIR`, its own Git access, and a locally
configured provider connection. Users sign in on that machine; never copy a
workstation's provider credentials. Choose the connection/model in project/run
settings or through `FABRIC_AGENTS_DEFAULT_CONNECTION` and
`FABRIC_AGENTS_DEFAULT_MODEL`. Supported CLI connection aliases include
`antigravity-cli`, `cursor-cli`, `droid-cli`, `grok-cli` and `kimi-cli`. Install and
sign in to the chosen CLI on the execution host itself. `targetMachine` validates
the selected server's identity; it does not dispatch to a different host.

Ask is the server's default permission policy. Resolve native tool approvals,
authentication and input requests in the authenticated Fabric desktop. A text
reply is not an approval. Unattended Execute requires deliberate service-host
policy; request JSON cannot elevate permissions.

## Readiness, cancellation and continuation

`GET /sessions/readiness` is authenticated structural readiness, including the protocol, registry, workspace, permission policy and whole-run cancellation capability. It returns a stable, non-secret server profile identity. Public `/health` remains liveness only.

`POST /sessions/readiness` also validates organization/repository allowlists, the selected connection, local credential presence, catalogued model, machine identity and a read-only GitHub repository push-permission query. Both API preflight and native session creation perform it before creating remote work. Environment/none-auth connections require explicit host-local qualification through `FABRIC_CODING_QUALIFIED_CONNECTIONS`; CLI selections also check binary/version availability. These connections fail readiness by default. Application cutover initially qualifies the Anthropic/Claude SDK backend for confirmed owned-process shutdown; other provider choices remain gated until their shutdown acknowledgement is implemented and qualified. Host qualification does not override that capability gate. Qualification must follow host-local sign-in and an authorized live turn and be removed when the account/environment changes. Stored credentials and a local model catalogue do not prove a provider subscription is currently usable; qualify an actual authorized provider turn separately. GitHub permission discovery does not prove protected-branch policy or the actual Git push succeeds. No model inference is used by readiness.

New Coding Runs persist their endpoint/profile identity in existing provider metadata and thread it through prompt delivery, observation, artifact sync, cancellation and cleanup. A changed target or profile fails closed; it never becomes a caller-controlled destination. Historical native rows without a binding require operator reconciliation rather than guessed routing. Weave/legacy cutover still requires a complete drain; this is not a multi-host scheduler.

Whole-run Stop terminates owned descendants/background work, including an idle parent. Only `confirmed: true` acknowledges successful termination. Unknown cancellation keeps the application active for recovery (including watchdog cleanup), fences new native prompts and blocks the drain check across restart. Native desktop foreground Stop retains its existing semantics. Stop is not proof of unrelated external cloud-job termination.

Ordinary Fabric follow-ups start after the preceding native turn and its Temporal cleanup have finished. A continuation claims the existing Coding Run's active slot, reserves the prompt identity/content digest/actor, starts a deterministic continuation workflow, and sends to the **same native session**. Each continuation resets its watchdog start time. The workflow rechecks organization/project access and read-only state before delivery, persists the native receipt, and resumes status/artifact observation. A retry recovers the existing receipt; changed content or another actor cannot reuse the identity. A second run owning the story/task prevents continuation. A queued/ambiguous response retains the draft and identity; never create another session to recover it.

Permission/authentication/elicitation checkpoints remain native-client actions. The paused panel directs users there; it does not present text as approval. The continuation observation budget is 90 minutes plus activity overhead. Every terminal transition follows confirmed native cleanup. A timeout or delivery failure records recovery evidence and attempts whole-run shutdown; an unconfirmed shutdown retains an active recovery state instead of declaring the work stopped. Use the existing-session recovery path and cancel/confirm outstanding work before starting another run.

## Project connections: private and team servers

Developers assign work from the existing project **Roadmap → feature → Start work → Fabric Agents** flow. Its remote-server picker lists only active connections for that project: **My servers** are owner-private within the organization; **Team servers** are available to authorized project members. The separate **Coding Agents** tab remains the local-agent board. Organization administrators can register team connections. Developers can register their own private connection using its dedicated execution-service HMAC secret. After choosing a connection, **Open server** opens its native Web UI before assignment; after execution starts, **Open in browser** in the session dialog opens the exact native session. Server browser authentication is separate from the execution service secret. Provider and Git sign-ins remain on the selected host; the Portal does not import those credentials. Remote assignment does not require a Portal AI provider: when Portal AI grooming is unconfigured, the feature page shows setup guidance while its **Start work** menu remains available. Automatic summary generation skips missing AI configuration without marking the summary generated, so reopening after setup can retry.

Connection registration verifies protocol readiness and pins the server profile. The API encrypts the service secret using the existing application credential encryption configuration; API and worker must share that configuration. Connection lists, run metadata, Temporal inputs and audit metadata contain no service secret. Connections are immutable: changing the endpoint/profile requires a new connection. Connection records are project-scoped; connecting a host to another project requires a separate authorized connection.

Both API and worker must reach the registered HTTPS origin. A developer laptop's `localhost` is not reachable from a hosted Portal. Use a trusted HTTPS endpoint or an operator-managed private network; private destinations must be explicitly permitted through `AGENT_DISCOVERY_ALLOWED_HOSTS` on API and worker. Local HTTP loopback is accepted only outside production. User-supplied origins reject credentials, paths, query strings, fragments and redirects; public destinations use the shared DNS-pinned outbound guard.

Each selected run stores its connection ID, endpoint, profile, project, organization and initiating user. Creation, prompts, status, artifact polling, continuation and cancellation resolve that binding server-side instead of using the deployment-global server. Selected-server failures do not fall back. Choosing **Server default** uses that host's own provider/model default; deployment-global provider/model defaults apply only to the compatibility default. Disconnecting stops admission and continuation, including queued prompts checked at delivery; existing runs retain observation and cleanup access to their original credentials. Disconnect is not an instruction to stop an existing run: cancel and confirm it separately.

The session dialog reads recent user/assistant text from the actual native session through the authenticated, bridge-owned `GET /sessions/:id/messages` endpoint. Project access and private/team connection access are checked before retrieval. Shared story/task summaries omit registered runtime bindings; a teammate viewing a private-server run receives status and PRs with a private-session notice, without host metadata, transcript, or controls. Owner/team runtime details are resolved only by the authorized session endpoint. Tool-result and provider credential fields are omitted. It is a read-only conversation view; existing authenticated native clients handle permissions, authentication and tool-input checkpoints. **Open in browser** opens the server's existing Web UI at the same workspace/session; users authenticate with that server separately, and may need to reopen the session link after their first sign-in. The optional desktop link still requires the explicit installation-specific workspace mapping; it is not a portable team connection mechanism. Team Web UI access currently remains a server-profile trust boundary, not per-user Portal SSO or session-level RPC authorization.

Before deploying this slice, apply `20261031210344_project_remote_agent_servers` and run `pnpm --filter @repo/database apply:rls`. The additive migration creates the table with forced RLS; the policy installer enables project access plus owner-private/team visibility and reserves team-connection writes for organization administrators. The application tenant extension applies the same owner/team visibility around the parent-project filter. Deploy the matching server with the messages endpoint and matching Portal/worker code before enabling the existing bridge flag. The global configuration remains the compatibility default for callers without a registered connection; the project assignment picker requires an explicit connection when native execution is enabled. Existing approved Weave delegation continues using that global default and does not yet select a registered connection. To roll back, stop new assignments and drain selected-server runs before removing supporting application code; preserve connection rows and encrypted credentials for reconciliation.

## Delegating Work in the Fabric UI

Once the bridge is enabled, a project server connection is registered (or the compatibility default is configured for existing API/Weave callers), and the project has a connected GitHub repository:

1. **Project Implementation Defaults (`Project Settings → Implementation Defaults`)**:
   - Select **Fabric Agents Remote Server** (`fabric-agent-server`) or **Fabric Agents Desktop** (`fabricagents://`) as the default implementation path.
   - Optionally set a default checkout directory if the server maps a pre-existing repository path.
2. **Direct Feature & Task Implementation (`Start work → Send to Fabric Agents…`)**:
   - On any published feature in the **Roadmap** tab (or via **Send to Fabric Agents** on an individual task row), open **Start work → Send to Fabric Agents…**.
   - **Task assignment**: Choose either the entire feature (all open tasks) or a single focused primary task.
   - **Remote server**: Select one of **Personal** (`PRIVATE`) or **Organization** (`TEAM`) servers; register a new server with 1-click presets and token generation directly from the dialog when needed.
   - **Fabric Agents backend**: The picker lists the server/provider catalogue. Initial application cutover qualifies **Claude Max / Anthropic** with confirmed shutdown; other backends fail readiness until their shutdown capability is implemented and qualified. Choose **Server default** only when it resolves to that qualified connection.
   - Click **Send to Fabric Agents** to create an isolated git worktree on a dedicated `feat/<slug>` branch and start the session.
3. **Approved Weave Plans (`Plan with Weave → Approve → Fabric Agents`)**:
   - After approving a feature-linked Weave plan, click **Fabric Agents** on the plan card to delegate multi-step execution and monitor it in the Weave execution monitor.
4. **Live Progress, Embedded Server Web UI, Follow-Up Replies, and Deep-Linking**:
   - Open the session dialog from the feature or task badge to view the 4-stage execution progress stepper (`1. Worktree & session` → `2. Implementing task` → `3. Pull Request` → `4. Completed`).
   - Click **View Live Server Web UI in Portal** to embed the real `fabric-agent-server` Web UI directly inside the coding run drawer, or click **Open in new tab** for a full-window browser view.
   - After a native turn completes, use **Continue this session** to send another instruction with durable prompt receipt tracking and renewed observation of the same session. When a native session pauses (`AWAITING_REVIEW`), resolve permission, sign-in, and tool-input checkpoints in the authenticated Fabric Agents client; ordinary text in Fabric does not approve them.
   - Click **Open in Fabric Agents** (`fabricagents://workspace/<desktop-workspace-id>/...`) to open the live session in the Fabric Agents desktop application, or click **View PR** once the pull request is opened.

## Delivery and recovery

- Session creation retains the coding run ID. Temporal prompt retries retain a
  workflow/run/activity request ID; accepted native message IDs are saved as
  `prompt_accepted` run events before activity success.
- Follow-up requests carry a UUID. The browser retains unresolved UUIDs and only
  a content digest in session storage, so reopening the dialog or refreshing the
  same tab can retry the same request identity without storing draft text. The
  API records the native message ID in `follow_up_sent` before success.
- An uncertain response must be retried with its original identity. A changed
  body under an existing identity is a conflict. `RECOVERY_REQUIRED` requires
  inspection of the existing native session; do not create a replacement run or
  erase server state to clear it. `INPUT_REQUIRED` means opening the existing
  session to resolve a real checkpoint. Both preserve the browser draft.
- Creator/project authorization is rechecked before native coding or Shuttle
  prompt delivery. Sandbox creation stores its run/session binding before
  returning, with a stable creation identity if the binding save needs retry.
- Native links use `fabricagents://workspace/<desktop-workspace-id>/...` (or the
  configured numbered scheme). Headless servers without an explicit desktop
  mapping omit the link; the consumer does not guess an old executor page.
- Branch-only Spike capability is disabled until a real branch push without a
  pull request has been qualified on the replacement runtime.

## Reproduce automated acceptance

Use an isolated worktree with its frozen dependencies and generated Prisma
client. No database migration or live database is needed for these tests.

```sh
pnpm --filter @repo/temporal exec vitest run \
  __tests__/coding-bridge-cutover.test.ts \
  __tests__/coding-bridge-replay-cutover.test.ts \
  __tests__/coding-bridge-receipts.test.ts \
  __tests__/coding-bridge-activity.test.ts \
  __tests__/coding-run-follow-up-workflow.test.ts \
  __tests__/weave-runtime-authorization.test.ts

FABRIC_AGENTS_ACCEPTANCE_SOURCE_ROOT=/path/to/fabric-agents \
  pnpm --filter @repo/temporal exec vitest run \
  __tests__/coding-bridge-joint.test.ts

pnpm --filter @repo/api exec vitest run \
  modules/coding-runs/__tests__/send-follow-up-receipts.test.ts
pnpm --filter @repo/web exec vitest run \
  modules/saas/projects/components/coding-runs/__tests__/CodingRunTimeline.test.tsx
```

The joint suite is explicitly skipped without the source-root opt-in. When
selected, it starts the actual server router in a separate loopback process,
uses the actual consumer HMAC adapter, restarts that process to verify durable
receipt replay and uncertain-delivery fencing, and checks native input handling.
It also runs the actual Temporal coding workflow and delivery activities and
replays its recorded synthetic history. Database authorization/storage,
repository preparation, artifact synchronization and native provider callbacks
are doubles. This proves the transport, orchestration and recovery contract; it
is not a live tenant-database, vendor account, repository-push, PR or native OS
URI-launch acceptance result.

Before production cutover, pin the intended server endpoint/profile, deploy the
matching reviewed consumer and server through their normal release processes,
and run a disposable authorized repository task with host-local sign-in. Verify
actual tool approval/denial, cancellation, artifact/PR delivery, tenant isolation
and native desktop launch. Keep public/fleet rollout disabled until those live
acceptance checks are recorded. Do not use normal user sessions as fixtures.

## Read-only deployment preflight

Run from the repository root with the intended environment supplied through its normal secret injection:

```sh
pnpm --filter @repo/temporal exec tsx scripts/check-fabric-agents-execution.ts \
  --repo example-org/example-repo --organization example-org \
  --connection example-provider --model example-model
```

This command invokes authenticated readiness and drain reads only. It creates no session, sends no prompt, changes no rollout flag and uses no model inference. A failed check or a non-drained server exits nonzero. It does not replace live acceptance.

## Staging qualification and cutover

1. Pin the reviewed consumer and protocol-2 server source revisions and immutable runtime checksum. Select one isolated staging environment, one private server OS account/profile, one organization/repository allowlist and a disposable repository. Keep rollout false and install/sign in to the provider and Git on that host.
2. Check authenticated structural and selected-execution readiness. Align API/worker settings. Deliberately choose supervised Ask via an authenticated native client, or an explicitly authorized unattended host policy. HTTP requests never elevate that policy.
3. Record real feature/task and approved Weave/Shuttle execution through database and Temporal, correct worktree/branch, commit/push/PR, application PR link, continuation receipt/artifact updates, native allow/deny, revoked-access and cross-tenant negatives, foreground/background cancellation, lost ACK, service restart and client launch. Fixtures do not close these rows.
4. Stop admission and drain active/paused application work and native background work; resolve any unbound reservation or unknown cancellation. Enable the bridge on both API and worker for the isolated environment. The flag is global, not a tenant-percentage canary. Observe accepted receipts, startup/poll latency, cancellation, recovery events and real PR delivery.
5. For rollback, stop admission and drain again before changing mode/endpoint/secret/profile. Preserve registry, native sessions, worktrees and Temporal history during reconciliation. Never clear the registry to make a drain check pass.
6. Retire legacy services/webhooks only after this qualification and the canary observation window pass. Keep historical URLs, enum compatibility and workflow replay support. Multi-host placement, HA, remaining provider qualification and branch-only Spike remain separate capabilities.
