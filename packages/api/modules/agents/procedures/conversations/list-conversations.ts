import { ORPCError } from "@orpc/server";
import {
	AgentConversationCursorError,
	countAgentConversationsForViewer,
	listAgentConversationsForViewer,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { ConversationListOutputSchema, listItemOf } from "./conversation-view";
import { resolvedOrganizationId } from "./resolved-organization";

/**
 * List the agent conversations the caller can see: their own ("mine", the
 * default), or every session an owner set to ORGANIZATION ("shared", the
 * caller's own included), optionally narrowed by a title search. Paged by
 * cursor, newest first (the caller's own list keeps pinned sessions on top).
 * Each session says whether it is the caller's and who owns it, so a client can
 * show another member's as read-only, and a session that is not the caller's is
 * shown as a transcript only (see `./conversation-view`).
 *
 * `agentId` narrows the list to one agent; without it the list spans every
 * agent in the organization, as the Execution History does.
 *
 * This is a public route, so what it answered before keeps working: `offset`
 * (deprecated, and refused together with a `cursor`) pages the way it did, and
 * `total` is the count under the same filter.
 *
 * Authorized in the organization the request names, for `AGENT_READ`: ADR-018
 * leaves no personal list.
 */
export const listConversations = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/agents/conversations",
		tags: ["Agent Conversations"],
		summary: "List agent conversations",
		description:
			"List the caller's agent conversations, or the ones shared in the organization",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			agentId: z.string().min(1).optional(),
			scope: z.enum(["mine", "shared"]).default("mine"),
			status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
			search: z.string().max(100).optional(),
			cursor: z.string().max(512).optional(),
			/** Deprecated: page by `cursor`. */
			offset: z.number().int().min(0).optional(),
			limit: z.number().min(1).max(100).default(50),
		}),
	)
	.output(ConversationListOutputSchema)
	.handler(async ({ input, context }) => {
		if (input.offset !== undefined && input.cursor !== undefined) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Send a cursor or an offset, not both",
			});
		}
		const filter = {
			userId: context.user.id,
			organizationId: resolvedOrganizationId(input, context.session),
			agentId: input.agentId,
			scope: input.scope,
			search: input.search,
			status: input.status,
		};

		try {
			const [{ items, nextCursor }, total] = await Promise.all([
				listAgentConversationsForViewer({
					...filter,
					cursor: input.cursor,
					offset: input.offset,
					limit: input.limit,
				}),
				countAgentConversationsForViewer(filter),
			]);
			return {
				conversations: items.map(listItemOf),
				hasMore: nextCursor !== undefined,
				total,
				...(nextCursor ? { nextCursor } : {}),
			};
		} catch (error) {
			if (error instanceof AgentConversationCursorError) {
				throw new ORPCError("BAD_REQUEST", {
					message: "The cursor is not valid",
				});
			}
			throw error;
		}
	});
