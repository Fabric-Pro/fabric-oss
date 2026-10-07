import { ORPCError } from "@orpc/server";
import {
	ConversationNotFoundError,
	removeConversationMessage,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Remove one user message from the caller's own conversation.
 *
 * The Advisor creates a new chat already holding its first question, before
 * the server decides whether that question may run (Fizzy #2958). When the
 * server refuses it because another message in the conversation is being
 * answered, the chat calls this to take the unanswered question back out.
 * Only a `user` message with this id is removed, under a row lock, so
 * anything written to the conversation in the meantime is kept. A message
 * that is already gone is not an error: the result says `removed: false`.
 *
 * Authorized in the organization the request names, not the session's:
 * `requireInputOrgPermission` checks membership of that organization and
 * that the caller's role there grants `AGENT_UPDATE`. `requireOrganization`
 * refuses a request that resolves no organization (an explicit `null` does
 * not fall back to the session), so there is no path that removes a message
 * without a tenant filter.
 */
export const removeMessage = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "DELETE",
		path: "/agents/conversations/{conversationId}/messages/{messageId}",
		tags: ["Agent Conversations"],
		summary: "Remove a message from a conversation",
		description:
			"Remove one user message from a conversation, keeping every other message",
	})
	.input(
		z.object({
			conversationId: z.string(),
			messageId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// The middleware already refused this; checked again so the query
		// below can never run without an organization filter.
		if (typeof organizationId !== "string" || organizationId.length === 0) {
			throw new ORPCError("FORBIDDEN", {
				message: "Removing a message requires an organization",
			});
		}

		try {
			return await removeConversationMessage({
				id: input.conversationId,
				userId: user.id,
				organizationId,
				messageId: input.messageId,
			});
		} catch (error) {
			if (error instanceof ConversationNotFoundError) {
				throw new ORPCError("NOT_FOUND", {
					message: "Conversation not found",
				});
			}
			throw error;
		}
	});
