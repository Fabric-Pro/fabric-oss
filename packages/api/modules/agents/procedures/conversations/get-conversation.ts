import { ORPCError } from "@orpc/server";
import { getAgentConversationForViewer } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { ConversationDetailSchema, detailOf } from "./conversation-view";
import { resolvedOrganizationId } from "./resolved-organization";

/**
 * Get a single agent conversation by ID: the caller's own, or one its owner
 * shared with the organization. `isOwn` tells the caller which; a session that
 * is not theirs is read-only (every writer filters on the owner) and comes as a
 * transcript only (see `./conversation-view`), so a client shows it without
 * sending or approval controls and offers to continue it in the caller's own
 * chat.
 *
 * Authorized in the organization the request names, for `AGENT_READ`: ADR-018
 * leaves no personal conversation. A session of another organization, and
 * another member's private one, are "not found".
 */
export const getConversation = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/agents/conversations/{id}",
		tags: ["Agent Conversations"],
		summary: "Get an agent conversation",
		description:
			"Get a single agent conversation by ID: the caller's own, or one shared in the organization",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(ConversationDetailSchema)
	.handler(async ({ input, context }) => {
		const conversation = await getAgentConversationForViewer({
			id: input.id,
			userId: context.user.id,
			organizationId: resolvedOrganizationId(input, context.session),
		});

		if (!conversation) {
			throw new ORPCError("NOT_FOUND", {
				message: "Conversation not found",
			});
		}

		return detailOf(conversation);
	});
