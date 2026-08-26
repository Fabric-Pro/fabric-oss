/**
 * `agents.conversations.deleteForDocument` — spec §5.6.
 *
 * Author-only. Emit the audit row BEFORE the delete so it references a
 * live id (audit ledger never carries a tombstoned resourceId for an
 * action that succeeded). Delete cascades the join row via the FK.
 */

import { ORPCError } from "@orpc/server";
import {
	db,
	deleteDocumentAssistantConversationByConversationId,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import {
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../../organizations/lib/membership";
import { HISTORY_DISABLED_MESSAGE } from "./_shared";

export const deleteForDocument = tenantProtectedProcedure
	.route({
		method: "DELETE",
		path: "/agents/conversations/document-assistant/{conversationId}",
		tags: ["Agent Conversations", "Document Assistant"],
		summary: "Delete a document-assistant conversation",
		description:
			"Permanently delete the underlying AgentConversation row. The join row cascades away via the FK. Author-only.",
	})
	.input(
		z.object({
			conversationId: z.string().min(1),
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

		const row = await db.documentAssistantConversation.findUnique({
			where: { conversationId: input.conversationId },
			select: {
				id: true,
				userId: true,
				organizationId: true,
				projectId: true,
				documentRefKind: true,
				documentRefId: true,
			},
		});
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

		// Audit BEFORE the delete so the ledger row keeps a live resourceId.
		// `recordAuditFromRequest` is fire-and-forget; the row may land
		// fractionally after the delete returns, but the resourceId snapshot
		// is captured at this synchronous call site.
		recordAuditFromRequest(context, {
			action: "document_assistant.conversation.deleted",
			category: "project",
			organizationId: organizationId ?? null,
			projectId: row.projectId,
			resource: {
				type: "document_assistant_conversation",
				id: input.conversationId,
			},
			metadata: {
				documentRefKind: row.documentRefKind,
				documentRefId: row.documentRefId,
			},
		});

		await deleteDocumentAssistantConversationByConversationId({
			conversationId: input.conversationId,
		});

		return { success: true as const };
	});
