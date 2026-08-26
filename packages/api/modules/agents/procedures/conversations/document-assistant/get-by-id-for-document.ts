/**
 * `agents.conversations.getByIdForDocument` — spec §3.4 FR-12 / FR-14, §5.2.
 *
 * Group F.13 hotfix: the History drawer's viewer pane needs to render any
 * conversation the user selects, not just the active thread. The existing
 * `getActiveForDocument` only resolves the caller's *latest* ACTIVE row;
 * picking a prior conversation in the list had nothing to fetch against.
 *
 * This procedure mirrors the `getActiveForDocument` shape exactly, with one
 * difference: the input names the conversation explicitly via `conversationId`
 * instead of letting the server infer "the latest ACTIVE for me". The output
 * carries the full persisted `messages[]` payload so the viewer can render
 * read-only inline without a follow-up round-trip.
 *
 * Visibility predicate is applied at the query level:
 *
 *   `(visibility = SHARED OR userId = $currentUserId)`
 *
 * — and we deliberately swallow every "match miss" into `{ conversation: null }`
 * (NOT `NOT_FOUND`). The reason is information-leak avoidance per spec §9.3 /
 * AC-11: a `NOT_FOUND` distinguishable from `FORBIDDEN` would let a curious
 * caller probe whether a private thread exists. Both go through the same null
 * branch.
 */

import { ORPCError } from "@orpc/server";
import {
	db,
	getDocumentAssistantConversationByIdAndDocument,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../../organizations/lib/membership";
import { DocumentRefKindSchema, resignMessageAttachments } from "./_shared";

export const getByIdForDocument = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/agents/conversations/document-assistant/by-id",
		tags: ["Agent Conversations", "Document Assistant"],
		summary: "Get document-assistant conversation by id",
		description:
			"Return a single prior assistant conversation by id for the given document, scoped to the caller's tenant and the SHARED-or-own-PRIVATE visibility predicate. Returns null on any miss (wrong tenant, wrong document, private+non-author, deleted) to avoid leaking existence — spec §9.3 / AC-11.",
	})
	.input(
		z.object({
			conversationId: z.string().min(1),
			documentRefKind: DocumentRefKindSchema,
			documentRefId: z.string().min(1),
			projectId: z.string().min(1),
			organizationId: z.string().nullable().optional(),
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

		// Feature flag: spec §3.11 FR-27. Personal context (no org) is always
		// treated as enabled — there is no per-user equivalent.
		if (organizationId) {
			const org = await db.organization.findUnique({
				where: { id: organizationId },
				select: { documentAssistantHistoryEnabled: true },
			});
			if (org?.documentAssistantHistoryEnabled === false) {
				return { conversation: null };
			}
		}

		const row = await getDocumentAssistantConversationByIdAndDocument({
			tenantFilter: organizationId
				? { organizationId, userId: user.id }
				: { organizationId: null, userId: user.id },
			conversationId: input.conversationId,
			documentRefKind: input.documentRefKind,
			documentRefId: input.documentRefId,
			currentUserId: user.id,
		});

		if (!row) {
			// Cross-tenant, cross-document, deleted, or private-and-not-author.
			// All four collapse into the same null branch
			// so a NOT_FOUND vs FORBIDDEN distinction can't leak.
			return { conversation: null };
		}

		const { joinRow, agentConversation: conv } = row;

		// Re-sign attachment GET URLs (matches `getActiveForDocument`). See
		// `resignMessageAttachments` in `_shared.ts` for the rationale.
		const messages = await resignMessageAttachments(
			conv.messages as unknown[],
		);

		// Same payload shape `getActiveForDocument` returns, so the viewer
		// pane can render both branches through the exact same component.
		return {
			conversation: {
				id: joinRow.id,
				conversationId: joinRow.conversationId,
				title: conv.title,
				visibility: joinRow.visibility,
				visibilityLockedAt:
					joinRow.visibilityLockedAt?.toISOString() ?? null,
				archivedAt: joinRow.archivedAt?.toISOString() ?? null,
				messages,
				parentConversationId: conv.parentConversationId,
				agentId: conv.agentId,
				createdAt: joinRow.createdAt.toISOString(),
				updatedAt: joinRow.updatedAt.toISOString(),
			},
		};
	});
