# Fabric Agents Execution Bridge & Delegation Guide

End-to-end configuration, UI delegation workflow, delivery guarantees, and automated acceptance for executing coding runs on Fabric Agents (`fabric-agent-server`).

- **Audience**: Platform engineers, AI/Backend developers, and project leads
- **Owner**: Agent & Platform team

---

This consumer uses the existing Fabric Agents `/sessions` compatibility API. The
server delegates to ordinary Fabric workspaces and the native session manager;
there is no separate execution engine. Use a matching server release containing
the durable coding bridge. The earlier 0.15.17 release is not that runtime.

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

## Delegating Work in the Fabric UI

Once `BACKGROUND_AGENTS_URL` and `BACKGROUND_AGENTS_INTERNAL_SECRET` are configured and the project has a connected GitHub repository:

1. **Project Implementation Defaults (`Project Settings → Implementation Defaults`)**:
   - Select **Remote execution — Fabric Agents** as the default implementation path (or **Local execution — Local development** when queueing work for `fabric-kanban`).
   - Optionally set a default checkout directory if the server maps a pre-existing repository path.
2. **Direct Feature & Task Implementation (`Start work → Fabric Agents`)**:
   - On any published feature in the **Stories / Coding** tab (or via **Implement** on an individual task row), open **Start work → Fabric Agents**.
   - **Task assignment**: Choose either the entire feature (all open tasks) or a single focused task.
   - **Fabric Agents backend**: Select **Server default**, **Claude Max**, **Codex**, **Cursor**, **Antigravity**, **Factory Droid**, **Grok**, or **Kimi**.
   - Click **Delegate to Fabric Agents** to create an isolated git worktree on a dedicated `feat/<slug>` branch and start the session.
3. **Approved Weave Plans (`Plan with Weave → Approve → Fabric Agents`)**:
   - After approving a feature-linked Weave plan, click **Fabric Agents** on the plan card to delegate multi-step execution and monitor it in the Weave execution monitor.
4. **Live Progress, Follow-Up Replies, and Deep-Linking**:
   - Open the session dialog from the feature or task badge to view the 4-stage execution progress stepper (`1. Worktree & session` → `2. Implementing task` → `3. Pull Request` → `4. Completed`).
   - When the session pauses for clarification (`AWAITING_REVIEW`), use the inline reply form to send follow-up instructions with durable prompt receipt tracking.
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
  __tests__/coding-bridge-receipts.test.ts \
  __tests__/coding-bridge-activity.test.ts \
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
