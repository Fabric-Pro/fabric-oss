/**
 * `agents.conversations.getActiveForDocument` — spec §5.2 / §3.2 FR-7.
 *
 * Loads the caller's most recent ACTIVE conversation for a document so the
 * SSR document-page loader can hydrate `<CopilotKit initialMessages>` in a
 * single round-trip (Risk R3 — no greeting flash). Returns `null` when no
 * thread exists or the org feature flag is OFF.
 */

import { ORPCError } from "@orpc/server";
import { db, getActiveDocumentAssistantConversation } from "@repo/database";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../../organizations/lib/membership";
import { DocumentRefSchema, resignMessageAttachments } from "./_shared";

export const getActiveForDocument = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/agents/conversations/document-assistant/active",
		tags: ["Agent Conversations", "Document Assistant"],
		summary: "Get active document-assistant conversation",
		description:
			"Return the caller's most recent ACTIVE assistant conversation for the given document, or null when none exists. Used by SSR hydration.",
	})
	.input(DocumentRefSchema)
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
		// always treated as enabled.
		if (organizationId) {
			const org = await db.organization.findUnique({
				where: { id: organizationId },
				select: { documentAssistantHistoryEnabled: true },
			});
			if (org?.documentAssistantHistoryEnabled === false) {
				return { conversation: null };
			}
		}

		const row = await getActiveDocumentAssistantConversation({
			tenantFilter: organizationId
				? { organizationId, userId: user.id }
				: { organizationId: null, userId: user.id },
			documentRefKind: input.documentRefKind,
			documentRefId: input.documentRefId,
		});

		if (!row) {
			return { conversation: null };
		}

		// The helper joins `conversation` so we can return messages + parent
		// linkage without a follow-up query. Message validation is intentionally
		// loose here: the schema accepts whatever is on the row (which has
		// already passed the stricter write-path Zod), and the hydration
		// consumer treats the array as opaque.
		const conv = row.conversation;
		// Re-sign each persisted attachment's GET URL before handing the
		// payload to the client. URLs in storage are stale almost by
		// definition (we never persist the signed URL — only the
		// `s3Path`) so this step is mandatory for image previews to
		// actually render in the History drawer's viewer pane.
		const messages = await resignMessageAttachments(
			conv.messages as unknown[],
		);
		return {
			conversation: {
				id: row.id,
				conversationId: row.conversationId,
				title: conv.title,
				visibility: row.visibility,
				visibilityLockedAt:
					row.visibilityLockedAt?.toISOString() ?? null,
				messages,
				parentConversationId: conv.parentConversationId,
				agentId: conv.agentId,
				createdAt: row.createdAt.toISOString(),
				updatedAt: row.updatedAt.toISOString(),
			},
		};
	});
