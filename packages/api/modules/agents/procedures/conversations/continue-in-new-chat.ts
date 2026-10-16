import { ORPCError } from "@orpc/client";
import {
	CarriedOverSummaryRequiredError,
	continueConversationInNewChat,
	ParentConversationNotFoundError,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { resolvedOrganizationId } from "./resolved-organization";

/**
 * Authorized in the organization the request names: the parent may be another
 * member's session shared with that organization, so the caller must be a
 * member of it (`requireInputOrgPermission` checks, `requireOrganization`
 * refuses a request that names none). The new chat is always the caller's own
 * and PRIVATE; a parent the caller cannot read is `NOT_FOUND`.
 */
export const continueInNewChat = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_CREATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/agents/conversations/continue-in-new-chat",
		tags: ["Agent Conversations"],
		summary:
			"Continue a conversation in a new chat with carried-over context",
		description:
			"Creates a fresh conversation of the caller's own linked to the parent, seeded with carried-over context: the caller's own summary for a conversation of theirs, or the transcript of a session another member shared, built by the server.",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			parentConversationId: z.string(),
			/**
			 * What to carry over from the caller's OWN conversation (its exhaustion
			 * synthesis); required for one, and ignored for another member's shared
			 * session, whose context the server builds from the session itself.
			 */
			summary: z
				.string()
				.min(1, "summary cannot be empty")
				.max(50_000, "summary exceeds 50KB limit")
				.optional(),
			title: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		try {
			const conversation = await continueConversationInNewChat({
				userId: context.user.id,
				organizationId: resolvedOrganizationId(input, context.session),
				parentConversationId: input.parentConversationId,
				ownSummary: input.summary,
				title: input.title,
			});
			return {
				id: conversation.id,
				agentId: conversation.agentId,
				title: conversation.title,
				parentConversationId: conversation.parentConversationId,
				createdAt: conversation.createdAt.toISOString(),
			};
		} catch (error) {
			if (error instanceof ParentConversationNotFoundError) {
				throw new ORPCError("NOT_FOUND", {
					message: "Parent conversation not found",
				});
			}
			if (error instanceof CarriedOverSummaryRequiredError) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"A summary is needed to continue your own conversation",
				});
			}
			throw error;
		}
	});
