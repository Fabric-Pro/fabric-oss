/**
 * `agents.conversations.listForDocument` — spec §5.1.
 *
 * Lists the SHARED + own-PRIVATE conversations for a (documentRefKind,
 * documentRefId) cursor-paginated and visibility-filtered. The query
 * helper (`listDocumentAssistantConversations`) anchors tenant isolation
 * via `tenantFilter`; this procedure adds the feature-flag short-circuit
 * and shapes the row payload for the History drawer.
 */

import { ORPCError } from "@orpc/server";
import { db, listDocumentAssistantConversations } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../../organizations/lib/membership";
import {
	type DocumentAssistantConversationSummarySchema,
	DocumentRefSchema,
} from "./_shared";

const LIST_DEFAULT_LIMIT = 10;
const LIST_MAX_LIMIT = 50;

function previewFromMessages(messages: unknown): string | null {
	if (!Array.isArray(messages)) {
		return null;
	}
	for (const raw of messages) {
		if (
			raw &&
			typeof raw === "object" &&
			(raw as { role?: unknown }).role === "user"
		) {
			const content = (raw as { content?: unknown }).content;
			if (typeof content === "string" && content.length > 0) {
				return content.length > 100 ? content.slice(0, 100) : content;
			}
		}
	}
	return null;
}

export const listForDocument = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/agents/conversations/document-assistant",
		tags: ["Agent Conversations", "Document Assistant"],
		summary: "List document-assistant conversations",
		description:
			"List prior assistant conversations for a document (PRD or feature description). Returns SHARED + own-PRIVATE rows, cursor-paginated.",
	})
	.input(
		DocumentRefSchema.extend({
			cursor: z.string().optional(),
			limit: z
				.number()
				.int()
				.min(1)
				.max(LIST_MAX_LIMIT)
				.default(LIST_DEFAULT_LIMIT),
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

		// Feature flag: spec §3.11 FR-27. Personal context (no org) is
		// always treated as enabled — there is no per-user equivalent.
		if (organizationId) {
			const org = await db.organization.findUnique({
				where: { id: organizationId },
				select: { documentAssistantHistoryEnabled: true },
			});
			if (org?.documentAssistantHistoryEnabled === false) {
				return { items: [], nextCursor: null };
			}
		}

		const result = await listDocumentAssistantConversations({
			tenantFilter: organizationId
				? { organizationId, userId: user.id }
				: { organizationId: null, userId: user.id },
			documentRefKind: input.documentRefKind,
			documentRefId: input.documentRefId,
			cursor: input.cursor,
			limit: input.limit,
		});

		// Hydrate the author chip + preview/messageCount in a single follow-up
		// query so the drawer can render without a second round-trip per row.
		const conversationIds = result.items.map((r) => r.conversationId);
		const userIds = Array.from(new Set(result.items.map((r) => r.userId)));

		const [conversations, authors] = await Promise.all([
			conversationIds.length > 0
				? db.agentConversation.findMany({
						where: { id: { in: conversationIds } },
						select: {
							id: true,
							title: true,
							messages: true,
							parentConversationId: true,
						},
					})
				: Promise.resolve(
						[] as Array<{
							id: string;
							title: string | null;
							messages: unknown;
							parentConversationId: string | null;
						}>,
					),
			userIds.length > 0
				? db.user.findMany({
						where: { id: { in: userIds } },
						select: { id: true, name: true, image: true },
					})
				: Promise.resolve(
						[] as Array<{
							id: string;
							name: string;
							image: string | null;
						}>,
					),
		]);

		const conversationById = new Map(
			conversations.map((c) => [c.id, c] as const),
		);
		const authorById = new Map(authors.map((u) => [u.id, u] as const));

		const items = result.items.map((row) => {
			const conv = conversationById.get(row.conversationId);
			const author = authorById.get(row.userId);
			const messageCount = Array.isArray(conv?.messages)
				? (conv?.messages as unknown[]).length
				: 0;
			return {
				id: row.id,
				conversationId: row.conversationId,
				title: conv?.title ?? null,
				messageCount,
				firstPromptPreview: previewFromMessages(conv?.messages),
				authorId: row.userId,
				authorName: author?.name ?? null,
				authorAvatarUrl: author?.image ?? null,
				visibility: row.visibility,
				visibilityLockedAt:
					row.visibilityLockedAt?.toISOString() ?? null,
				archivedAt: row.archivedAt?.toISOString() ?? null,
				createdAt: row.createdAt.toISOString(),
				updatedAt: row.updatedAt.toISOString(),
				parentConversationId: conv?.parentConversationId ?? null,
			};
		});

		return {
			items: items satisfies z.infer<
				typeof DocumentAssistantConversationSummarySchema
			>[],
			nextCursor: result.nextCursor,
		};
	});
