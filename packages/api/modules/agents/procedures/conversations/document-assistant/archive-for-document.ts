/**
 * `agents.conversations.archiveForDocument` — spec §5.5.
 *
 * Author-only. Sets `archivedAt = now()` on the join row AND
 * `AgentConversation.status = ARCHIVED` in one transaction so the History
 * drawer's status chip stays in sync with the underlying conversation row.
 */

import { ORPCError } from "@orpc/server";
import { archiveDocumentAssistantConversation, db } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import {
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../../organizations/lib/membership";
import { HISTORY_DISABLED_MESSAGE } from "./_shared";

export const archiveForDocument = tenantProtectedProcedure
	.route({
		method: "POST",
		path: "/agents/conversations/document-assistant/{conversationId}/archive",
		tags: ["Agent Conversations", "Document Assistant"],
		summary: "Archive a document-assistant conversation",
		description:
			"Soft-archive a conversation. Author-only. Emits document_assistant.conversation.archived.",
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

		const updated = await archiveDocumentAssistantConversation({
			id: row.id,
		});

		recordAuditFromRequest(context, {
			action: "document_assistant.conversation.archived",
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

		return {
			conversation: {
				id: updated.id,
				archivedAt: updated.archivedAt?.toISOString() ?? null,
				status: "ARCHIVED" as const,
			},
		};
	});
