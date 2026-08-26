import { ORPCError } from "@orpc/server";
import { getAgentConversationById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

/**
 * Get a single agent conversation by ID
 */
export const getConversation = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/agents/conversations/{id}",
		tags: ["Agent Conversations"],
		summary: "Get an agent conversation",
		description: "Get a single agent conversation by ID",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Verify organization membership if in org context
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

		const conversation = await getAgentConversationById({
			id: input.id,
			userId: user.id,
			organizationId,
		});

		if (!conversation) {
			throw new ORPCError("NOT_FOUND", {
				message: "Conversation not found",
			});
		}

		return {
			id: conversation.id,
			agentId: conversation.agentId,
			title: conversation.title,
			messages: conversation.messages,
			trajectory: conversation.trajectory,
			metadata: conversation.metadata,
			pinned: conversation.pinned,
			status: conversation.status,
			createdAt: conversation.createdAt.toISOString(),
			updatedAt: conversation.updatedAt.toISOString(),
			parentConversationId: conversation.parentConversationId,
			carriedOverSummary: conversation.carriedOverSummary,
			carriedOverAt: conversation.carriedOverAt?.toISOString() ?? null,
		};
	});
