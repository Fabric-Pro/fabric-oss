import { ORPCError } from "@orpc/client";
import type { UIMessage } from "@repo/ai";
import {
	getAiChatsByOrganizationId,
	getAiChatsByProjectId,
	getAiChatsByUserId,
	hasProjectAccess,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const listChats = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "GET",
		path: "/ai/chats",
		tags: ["AI"],
		summary: "Get chats",
		description:
			"Get all chats for current user or organization with pagination",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			projectId: z.string().optional(),
			limit: z.number().min(1).max(50).default(10),
			offset: z.number().min(0).default(0),
		}),
	)
	.handler(async ({ input, context }) => {
		const limit = input.limit;
		const offset = input.offset;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				context.user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN");
			}
		}

		if (input.projectId) {
			const canAccess = await hasProjectAccess(
				input.projectId,
				context.user.id,
				organizationId,
			);
			if (!canAccess) {
				throw new ORPCError("FORBIDDEN");
			}
		}

		// Fetch one extra item to determine if there are more results
		let chats:
			| Awaited<ReturnType<typeof getAiChatsByProjectId>>
			| undefined;
		if (input.projectId) {
			chats = await getAiChatsByProjectId({
				projectId: input.projectId,
				organizationId,
				userId: context.user.id,
				limit: limit + 1,
				offset,
			});
		} else if (organizationId) {
			chats = await getAiChatsByOrganizationId({
				limit: limit + 1,
				offset,
				organizationId,
				userId: context.user.id,
			});
		} else {
			chats = await getAiChatsByUserId({
				limit: limit + 1,
				offset,
				userId: context.user.id,
			});
		}

		// Check if there are more results
		const hasMore = chats.length > limit;
		const resultChats = hasMore ? chats.slice(0, limit) : chats;

		return {
			chats: resultChats.map((chat) => ({
				...chat,
				messages: (chat.messages ?? []) as unknown as UIMessage[],
			})),
			hasMore,
			nextOffset: hasMore ? offset + limit : undefined,
		};
	});
