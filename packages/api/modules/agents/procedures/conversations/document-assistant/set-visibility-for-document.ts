/**
 * `agents.conversations.setVisibilityForDocument` — spec §5.4 / §3.5
 * FR-17–FR-19, AC-8.
 *
 * Author-only. CONFLICT once `visibilityLockedAt` is set — the helper
 * does the atomic check-and-set so a racing first-message-send can't
 * slip a flip past us.
 */

import { ORPCError } from "@orpc/server";
import {
	DocumentAssistantVisibilityLockedError,
	db,
	setDocumentAssistantConversationVisibility,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import {
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../../organizations/lib/membership";
import {
	DocumentAssistantVisibilitySchema,
	HISTORY_DISABLED_MESSAGE,
	VISIBILITY_LOCKED_MESSAGE,
} from "./_shared";

export const setVisibilityForDocument = tenantProtectedProcedure
	.route({
		method: "POST",
		path: "/agents/conversations/document-assistant/{conversationId}/visibility",
		tags: ["Agent Conversations", "Document Assistant"],
		summary: "Set conversation visibility",
		description:
			"Toggle a conversation's SHARED / PRIVATE visibility. Author-only. Rejected with CONFLICT once the first user message has been persisted.",
	})
	.input(
		z.object({
			conversationId: z.string().min(1),
			organizationId: z.string().nullable().optional(),
			visibility: DocumentAssistantVisibilitySchema,
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

		const row = await db.documentAssistantConversation.findUnique({
			where: { conversationId: input.conversationId },
			select: {
				id: true,
				userId: true,
				organizationId: true,
				projectId: true,
				documentRefKind: true,
				documentRefId: true,
				visibility: true,
			},
		});

		// NOT_FOUND wins over FORBIDDEN for cross-tenant — spec FR-20 / AC-11
		// avoids leaking row existence across orgs.
		if (!row || (row.organizationId ?? null) !== (organizationId ?? null)) {
			throw new ORPCError("NOT_FOUND", {
				message: "Conversation not found",
			});
		}
		if (row.userId !== user.id) {
			throw new ORPCError("FORBIDDEN", {
				message: "You are not the author of this conversation",
			});
		}

		// Feature-flag gate: writes are rejected when the org has the flag
		// OFF.
		if (organizationId) {
			const org = await db.organization.findUnique({
				where: { id: organizationId },
				select: { documentAssistantHistoryEnabled: true },
			});
			if (org?.documentAssistantHistoryEnabled === false) {
				throw new ORPCError("CONFLICT", {
					message: HISTORY_DISABLED_MESSAGE,
				});
			}
		}

		try {
			const updated = await setDocumentAssistantConversationVisibility({
				id: row.id,
				visibility: input.visibility,
				expectUnlocked: true,
			});

			// Audit only on actual change (idempotent same-state writes shouldn't
			// inflate the ledger).
			if (row.visibility !== input.visibility) {
				recordAuditFromRequest(context, {
					action: "document_assistant.conversation.visibility_changed",
					category: "project",
					organizationId: organizationId ?? null,
					projectId: row.projectId,
					resource: {
						type: "document_assistant_conversation",
						id: input.conversationId,
					},
					metadata: {
						from: row.visibility,
						to: input.visibility,
						documentRefKind: row.documentRefKind,
						documentRefId: row.documentRefId,
					},
				});
			}

			return {
				conversation: {
					id: updated.id,
					visibility: updated.visibility,
					visibilityLockedAt:
						updated.visibilityLockedAt?.toISOString() ?? null,
				},
			};
		} catch (err) {
			if (err instanceof DocumentAssistantVisibilityLockedError) {
				throw new ORPCError("CONFLICT", {
					message: VISIBILITY_LOCKED_MESSAGE,
				});
			}
			throw err;
		}
	});
