import { ORPCError } from "@orpc/client";
import {
	countAgentConversations,
	listAgentConversations,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

/**
 * List agent conversations for the current user
 */
export const listConversations = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/agents/conversations",
		tags: ["Agent Conversations"],
		summary: "List agent conversations",
		description:
			"List all agent conversations for the current user or organization",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			agentId: z.string().optional(),
			status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
			limit: z.number().min(1).max(100).default(50),
			offset: z.number().min(0).default(0),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		const [conversations, total] = await Promise.all([
			listAgentConversations({
				userId: user.id,
				organizationId,
				agentId: input.agentId,
				status: input.status,
				limit: input.limit,
				offset: input.offset,
			}),
			countAgentConversations({
				userId: user.id,
				organizationId,
				agentId: input.agentId,
				status: input.status,
			}),
		]);

		return {
			conversations: conversations.map((c) => ({
				id: c.id,
				agentId: c.agentId,
				title: c.title,
				messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
				pinned: c.pinned,
				status: c.status,
				createdAt: c.createdAt.toISOString(),
				updatedAt: c.updatedAt.toISOString(),
				// Include preview of last message
				lastMessage: getLastMessagePreview(c.messages),
				// Include metadata to identify orchestrator conversations
				metadata: c.metadata,
			})),
			total,
			hasMore: input.offset + conversations.length < total,
		};
	});

function getLastMessagePreview(messages: unknown): string | null {
	if (!Array.isArray(messages) || messages.length === 0) {
		return null;
	}
	const lastMessage = messages[messages.length - 1];
	if (typeof lastMessage?.content === "string") {
		return lastMessage.content.slice(0, 100);
	}
	return null;
}
