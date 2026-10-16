import { ORPCError } from "@orpc/server";
import {
	ConversationNotFoundError,
	setAgentConversationVisibility,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { resolvedOrganizationId } from "./resolved-organization";

/**
 * Set who can read an agent conversation: only its owner (PRIVATE), or every
 * member of the organization (ORGANIZATION). Owner only; anyone else, and a
 * session of another organization, gets "not found". The owner may change it
 * at any time. A shared session is read-only for everyone else, and they are
 * shown its transcript only.
 *
 * Sharing a transcript shares what the words in it say, which can include
 * results from the owner's own connected servers that the agent quoted, so a
 * client shows that before it asks. Authorized in the organization the request
 * names, for `AGENT_UPDATE` (ADR-018).
 */
export const setConversationVisibility = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/agents/conversations/{id}/visibility",
		tags: ["Agent Conversations"],
		summary: "Set who can read an agent conversation",
		description:
			"Share an agent conversation with the organization, or make it private again. Owner only.",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			visibility: z.enum(["PRIVATE", "ORGANIZATION"]),
		}),
	)
	.handler(async ({ input, context }) => {
		try {
			const conversation = await setAgentConversationVisibility({
				id: input.id,
				userId: context.user.id,
				organizationId: resolvedOrganizationId(input, context.session),
				visibility: input.visibility,
			});
			return {
				id: conversation.id,
				visibility: conversation.visibility,
				updatedAt: conversation.updatedAt.toISOString(),
			};
		} catch (error) {
			if (error instanceof ConversationNotFoundError) {
				throw new ORPCError("NOT_FOUND", {
					message: "Conversation not found",
				});
			}
			throw error;
		}
	});
