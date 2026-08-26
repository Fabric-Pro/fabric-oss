/**
 * Backlog workflow constants.
 *
 * Centralises the string literals that previously lived as bare strings
 * scattered across the two backlog workflows + the frontend lazy-create
 * helper + the cancellation throw sites. Drift between them would
 * silently break:
 *
 *   - `BACKLOG_AGENT_ID`: must match the row seeded by
 *     `packages/database/prisma/seed-system-agents.ts`. A future typo
 *     anywhere this is consumed (frontend `agents.conversations.create`
 *     call, or any future server-side validation / catalog JOIN)
 *     would create conversations the system-agent registry can't
 *     attribute (no icon, no name, no telemetry).
 *
 *   - `BACKLOG_*_CANCELLED`: must match the second arg of the
 *     `ApplicationFailure.nonRetryable(...)` throws at the
 *     cancellation checkpoints AND the `error.type === "..."` sniff
 *     in the catch blocks where Step 6 decides whether to post
 *     `outcome: "cancelled"` or `outcome: "failure"`. A typo in
 *     either side silently downgrades cancellation to failure (AC-3
 *     regression caught by code-reviewer round-1 #2).
 *
 * These constants are exported as `const`-typed string literals so
 * TS narrows them at every call site. `AgentConversation.agentId` is
 * a plain `String` column (not a FK relation), but server-side
 * validation in `agents.conversations.create` rejects any agentId
 * that is not present and ACTIVE in the `RegisteredAgent` catalog
 * (see `packages/api/modules/agents/procedures/conversations/
 * create-conversation.ts`). That guard catches runtime drift AT THE
 * API PROCEDURE BOUNDARY — if a caller bypasses these TS constants
 * and sends a typo'd literal via oRPC, the creation fails with
 * ORPCError("BAD_REQUEST") before the row touches the database.
 *
 * The validation does NOT fire for direct server-side calls to the
 * `createAgentConversation` DB helper (exported from @repo/database),
 * because the helper has no knowledge of the catalog. No such
 * direct call site exists today — every `AgentConversation` row is
 * created via the API procedure — but a future Temporal activity or
 * server-side worker that calls the DB helper directly would need
 * to re-validate at its own boundary. Together, the TS constants
 * (compile-time) plus the catalog lookup at the API boundary
 * (runtime) close the drift surface raised by Codex round-2.
 */

/**
 * Agent ID used for backlog-session `AgentConversation` rows. Matches
 * the seeded `SystemAgent.agentId` value in
 * `packages/database/prisma/seed-system-agents.ts`.
 */
export const BACKLOG_AGENT_ID = "backlog_updater" as const;

/**
 * `ApplicationFailure.type` used by the context-analysis workflow's
 * cancellation-checkpoint throws. Read by the Step 6 dispatch in the
 * catch block to distinguish `outcome: "cancelled"` from `"failure"`.
 */
export const BACKLOG_ANALYSIS_CANCELLED_TYPE =
	"BACKLOG_ANALYSIS_CANCELLED" as const;

/**
 * `ApplicationFailure.type` used by the apply-changes workflow's
 * cancellation-signal handler throw. Symmetric to
 * `BACKLOG_ANALYSIS_CANCELLED_TYPE`.
 */
export const BACKLOG_APPLY_CANCELLED_TYPE = "BACKLOG_APPLY_CANCELLED" as const;
