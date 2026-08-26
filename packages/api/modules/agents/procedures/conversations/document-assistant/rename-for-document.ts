/**
 * `agents.conversations.renameForDocument` — spec §5.7.
 *
 * Author-only. Sets the `AgentConversation.title` (the join row holds no
 * title of its own — title is a property of the conversation, not the
 * document linkage). Emits `renamed` with `{ from, to }`.
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import {
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../../organizations/lib/membership";
import { HISTORY_DISABLED_MESSAGE } from "./_shared";

const MAX_TITLE_LENGTH = 200;

export const renameForDocument = tenantProtectedProcedure
	.route({
		method: "PATCH",
		path: "/agents/conversations/document-assistant/{conversationId}/title",
		tags: ["Agent Conversations", "Document Assistant"],
		summary: "Rename a document-assistant conversation",
		description:
			"Update the conversation title. Author-only. Title is trimmed and capped at 200 chars.",
	})
	.input(
		z.object({
			conversationId: z.string().min(1),
			organizationId: z.string().nullable().optional(),
			title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
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

		const join = await db.documentAssistantConversation.findUnique({
			where: { conversationId: input.conversationId },
			select: {
				id: true,
				userId: true,
				organizationId: true,
				projectId: true,
				documentRefKind: true,
				documentRefId: true,
				conversation: { select: { id: true, title: true } },
			},
		});
		if (
			!join ||
			(join.organizationId ?? null) !== (organizationId ?? null)
		) {
			throw new ORPCError("NOT_FOUND", {
				message: "Conversation not found",
			});
		}
		if (join.userId !== user.id) {
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

		const previousTitle = join.conversation.title;
		const updated = await db.agentConversation.update({
			where: { id: join.conversation.id },
			data: { title: input.title },
			select: { id: true, title: true },
		});

		if (previousTitle !== updated.title) {
			recordAuditFromRequest(context, {
				action: "document_assistant.conversation.renamed",
				category: "project",
				organizationId: organizationId ?? null,
				projectId: join.projectId,
				resource: {
					type: "document_assistant_conversation",
					id: input.conversationId,
					name: updated.title ?? null,
				},
				metadata: {
					from: previousTitle,
					to: updated.title,
					documentRefKind: join.documentRefKind,
					documentRefId: join.documentRefId,
				},
			});
		}

		return {
			conversation: {
				id: updated.id,
				title: updated.title,
			},
		};
	});
