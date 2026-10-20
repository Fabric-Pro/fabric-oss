import { ORPCError } from "@orpc/server";
import {
	createAgentConversation,
	getRegisteredAgentByAgentId,
} from "@repo/database";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../..//lib/zod-bounds";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { checkRegisteredAgentAccess } from "../../lib/registered-agent-access";
import { MessageSchema, maybeStripReasoning } from "./update-conversation";

/**
 * Create a new agent conversation
 *
 * `requireOrganization`: an explicit `organizationId: null` resolves to no
 * organization, and without it the middleware passes that through with no
 * role check, so a member whose role lacks `AGENT_CREATE` could still create
 * a conversation (stored with a null organization). There is no personal
 * conversation (ADR-018), so a request that resolves none is refused.
 */
export const createConversation = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_CREATE, {
			requireOrganization: true,
		}),
	)
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
			title: z.string().max(INPUT_BOUNDS.name).optional(),
			messages: z.array(MessageSchema).optional(),
			metadata: z.record(z.string(), z.unknown()).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// AgentConversation.agentId is not a foreign key. Require an exact catalog
		// id and apply the registry scope check before creating the conversation.
		// Missing and inaccessible agents return the same error to limit probing.
		// Non-ACTIVE status is observability-only after access is granted: health
		// monitor failures can be transient and should not block conversation creation.
		const registered = await getRegisteredAgentByAgentId(input.agentId);
		if (
			!registered ||
			!(
				await checkRegisteredAgentAccess(
					registered,
					user.id,
					organizationId,
				)
			).allowed
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Unknown agentId: "${input.agentId}". Agent must be registered in the catalog before a conversation can be created.`,
			});
		}
		if (registered.status !== "ACTIVE") {
			console.warn(
				`[agents.conversations.create] proceeding with non-ACTIVE agent (status=${registered.status})`,
				{ agentId: input.agentId },
			);
		}

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
