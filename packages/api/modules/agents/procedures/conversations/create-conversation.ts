import { ORPCError } from "@orpc/server";
import {
	createAgentConversation,
	getRegisteredAgentByAgentId,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { MessageSchema, maybeStripReasoning } from "./update-conversation";

/**
 * Create a new agent conversation
 */
export const createConversation = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_CREATE))
	.route({
		method: "POST",
		path: "/agents/conversations",
		tags: ["Agent Conversations"],
		summary: "Create a new agent conversation",
		description: "Create a new conversation with an agent",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			// `trim().min(1).max(128)` closes a cheap DoS surface: without
			// bounds, an empty / megabyte agentId would still reach
			// `getRegisteredAgentByAgentId` and execute a real Postgres
			// `findUnique` before the catalog gate returned 400.
			// `.trim()` is applied BEFORE `.min(1)` so whitespace-only
			// inputs (`"   "`, 3 spaces — passes `.min(1)` by raw length)
			// collapse to empty and get rejected at the schema layer too
			// (Codex round-3 finding #2). Catalog IDs are programmatic
			// constants — silently trimming spurious whitespace around
			// them is the right semantic. 128 chars is a generous
			// ceiling: the longest seeded agentId today
			// (`fabric-workspace-assistant`) is 26 chars; 128 leaves
			// room for namespaced future ids.
			agentId: z.string().trim().min(1).max(128),
			title: z.string().optional(),
			messages: z.array(MessageSchema).optional(),
			metadata: z.record(z.string(), z.unknown()).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// Server-side agentId validation.
		//
		// AgentConversation.agentId is a plain `String` column, not a FK,
		// so the database does not enforce that the id corresponds to a
		// real registered agent. Without this guard, any oRPC caller can
		// create conversations with typo'd or non-existent agentIds,
		// silently breaking SystemAgent attribution (no icon, no display
		// name, no telemetry), the Step 6 post-operation-result dispatch
		// from Temporal workflows, and the agent catalog UI.
		//
		// Existence is a strict allowlist (gate 1): a conversation is only
		// created when the agent exists in the `RegisteredAgent` catalog.
		// An unknown agentId is rejected with `ORPCError("BAD_REQUEST")`
		// so typo'd ids surface immediately at the API boundary instead
		// of silently producing dead conversations. Uses the existing
		// `getRegisteredAgentByAgentId` helper to share the indexed-lookup
		// query plan with the rest of the codebase. Runs ONCE per
		// conversation creation (not per message), so the overhead is
		// negligible.
		//
		// Status is observability-only (gate 2): non-ACTIVE statuses
		// (`INACTIVE`, `ERROR`, `STALE`, future enum additions) emit a
		// `console.warn` but DO NOT block creation. Rationale: the
		// `status` column is owned by the agent-health-monitor Temporal
		// workflow (probes `${deploymentUrl}/health` every 2 minutes) and
		// can flip to `ERROR` for transient reasons that are independent
		// of whether the user-facing chat surface should function —
		// stale deploymentUrl after env-var change, brief Azure
		// Container App restart, intermittent network blip, ACA cold
		// start. Hard-failing `conversations.create` on those signals
		// turns transient health-monitor noise into a hard customer
		// block (Fizzy #1412 round-3 follow-up, staging incident
		// 2026-05-28: all 10 staging system_agents had stale localhost
		// deploymentUrls from a misconfigured seed run, so every probe
		// failed → status=ERROR → every new conversation rejected with
		// 400, while the agents themselves were otherwise fine to talk
		// to via cached agent cards). The warn-log keeps the signal
		// observable without making it blocking; a follow-up PR can
		// re-tighten this once the catalog-status reliability has been
		// audited end-to-end.
		//
		// Runs BEFORE `resolveOrganizationId` because (a) it only needs
		// `input.agentId` with no context/session dependency, and (b) a
		// bad agentId is a cheap input error — rejecting it before any
		// other work runs limits the blast radius of malformed callers.
		//
		// Tenant-scope checks (USER agents belonging to another user,
		// ORGANIZATION agents from another org) are DELIBERATELY out of
		// scope for this PR. This was an explicit product decision —
		// the round-2 follow-up is scoped to drift prevention only,
		// not to fix the broader tenant-isolation gap. A separate PR
		// will add scope enforcement: SYSTEM agents universally
		// accessible; ORGANIZATION requires `registered.organizationId
		// === organizationId`; USER requires `registered.userId ===
		// user.id` and a personal context.
		//
		// Safety today: ALL 16 seeded RegisteredAgent rows have
		// `scope = "SYSTEM"` (see seed-system-agents.ts). User-defined
		// agents created via Agent Builder DO get `scope = "USER"` or
		// `"ORGANIZATION"`, so the info-leak surface (the BAD_REQUEST
		// "unknown" vs "exists but inactive" distinction) is real for
		// those tenants — but bounded to callers who already hold the
		// AGENT_CREATE permission. Codex round-3 flagged this as
		// Important; the deliberate punt is documented here so a
		// future reader cannot mistake this for an oversight.
		const registered = await getRegisteredAgentByAgentId(input.agentId);
		if (!registered) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Unknown agentId: "${input.agentId}". Agent must be registered in the catalog before a conversation can be created.`,
			});
		}
		if (registered.status !== "ACTIVE") {
			// Observability-only — see gate-2 rationale above. Logged via
			// console.warn so it lands in Vercel runtime logs alongside the
			// existing oRPC request log, with enough context to correlate
			// to the offending agentId without leaking user/tenant scope.
			console.warn(
				`[agents.conversations.create] proceeding with non-ACTIVE agent (status=${registered.status})`,
				{ agentId: input.agentId },
			);
		}

		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		const conversation = await createAgentConversation({
			userId: user.id,
			organizationId,
			agentId: input.agentId,
			title: input.title,
			messages: input.messages?.map(maybeStripReasoning),
			metadata: input.metadata,
		});

		return {
			id: conversation.id,
			agentId: conversation.agentId,
			title: conversation.title,
			createdAt: conversation.createdAt.toISOString(),
		};
	});
