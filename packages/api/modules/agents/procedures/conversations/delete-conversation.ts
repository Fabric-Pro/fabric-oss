import { ORPCError } from "@orpc/server";
import {
	archiveAgentConversation,
	deleteAgentConversation,
	toggleConversationPin,
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
 * Delete an agent conversation
 */
export const deleteConversation = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_DELETE))
	.route({
		method: "DELETE",
		path: "/agents/conversations/{id}",
		tags: ["Agent Conversations"],
		summary: "Delete an agent conversation",
		description: "Permanently delete an agent conversation",
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

		try {
			await deleteAgentConversation({
				id: input.id,
				userId: user.id,
				organizationId,
			});

			return { success: true };
		} catch (_error) {
			throw new ORPCError("NOT_FOUND", {
				message: "Conversation not found",
			});
		}
	});

/**
 * Archive an agent conversation (soft delete)
 */
export const archiveConversation = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_DELETE))
	.route({
		method: "POST",
		path: "/agents/conversations/{id}/archive",
		tags: ["Agent Conversations"],
		summary: "Archive an agent conversation",
		description: "Archive (soft delete) an agent conversation",
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

		try {
			const conversation = await archiveAgentConversation({
				id: input.id,
				userId: user.id,
				organizationId,
			});

			return {
				id: conversation.id,
				status: conversation.status,
			};
		} catch (_error) {
			throw new ORPCError("NOT_FOUND", {
				message: "Conversation not found",
			});
		}
	});

/**
 * Toggle pin status for a conversation
 */
export const togglePin = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_DELETE))
	.route({
		method: "POST",
		path: "/agents/conversations/{id}/toggle-pin",
		tags: ["Agent Conversations"],
		summary: "Toggle conversation pin status",
		description: "Toggle the pinned status of a conversation",
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

		try {
			const conversation = await toggleConversationPin({
				id: input.id,
				userId: user.id,
				organizationId,
			});

			return {
				id: conversation.id,
				pinned: conversation.pinned,
			};
		} catch (_error) {
			throw new ORPCError("NOT_FOUND", {
				message: "Conversation not found",
			});
		}
	});
