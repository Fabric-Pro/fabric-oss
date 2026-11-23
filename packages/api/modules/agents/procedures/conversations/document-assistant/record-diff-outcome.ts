/**
 * `agents.conversations.recordDiffOutcome` — spec §3.8 FR-23 / §5.8.
 *
 * Patches the `messages` JSON blob to stamp `acceptedAt` / `rejectedAt`
 * on the targeted tool-call. Project members with PROJECT_UPDATE can
 * record outcomes — they are the same population already permitted to
 * accept / reject the diff via `DiffReviewBar` (a non-author teammate
 * can accept a teammate's draft edit). No audit event (spec §5.8 — diff
 * outcomes already log through the document-version pipeline).
 *
 * Like the other procedures on a document's threads, the caller must be
 * able to see the document's project (`assertDocumentProjectAccess`): the
 * permission gate's org-role fallback admits an organization member who is
 * not on the project, who would otherwise write into its shared threads.
 * The input names no document, so the check reads the thread's own.
 *
 * The stamp is read and written under the conversation row lock
 * (`lockConversationRow`). A Reject also saves the turn's tool result
 * (`appendTurnForDocument`) and appends the "Changes rejected." operation
 * result (`appendConversationMessage`), usually within a second; both
 * rewrite the same `messages` column under the same lock, so none of the
 * three overwrites another's change.
 */

import { ORPCError } from "@orpc/server";
import { db, lockConversationRow } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { assertDocumentProjectAccess } from "./_shared";

interface StoredToolCall {
	id: string;
	name: string;
	args?: Record<string, unknown>;
	result?: string;
	status?: string;
	acceptedAt?: string | null;
	rejectedAt?: string | null;
	[key: string]: unknown;
}

interface StoredMessage {
	id: string;
	toolCalls?: StoredToolCall[];
	[key: string]: unknown;
}

interface DiffOutcome {
	messageId: string;
	toolCallId: string;
	outcome: "accepted" | "rejected";
	at: string;
}

export const recordDiffOutcome = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/agents/conversations/document-assistant/{conversationId}/diff-outcome",
		tags: ["Agent Conversations", "Document Assistant"],
		summary: "Record diff accept/reject outcome",
		description:
			"Stamp acceptedAt or rejectedAt on a tool-call entry inside the persisted messages JSON, keyed by (messageId, toolCallId).",
	})
	.input(
		z.object({
			conversationId: z.string().min(1),
			projectId: z.string().min(1),
			organizationId: z.string().nullable().optional(),
			messageId: z.string().min(1),
			toolCallId: z.string().min(1),
			outcome: z.enum(["accepted", "rejected"]),
			at: z.string().datetime(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		const join = await db.documentAssistantConversation.findUnique({
			where: { conversationId: input.conversationId },
			select: {
				id: true,
				userId: true,
				organizationId: true,
				projectId: true,
				documentRefKind: true,
				documentRefId: true,
				conversation: {
					select: { id: true },
				},
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
		// Cross-project record attempts (input.projectId differs from the
		// conversation's owning project) are NOT_FOUND for the same reason
		// as cross-tenant — never reveal that the row exists elsewhere.
		if (join.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Conversation not found",
			});
		}
		// The thread's document must be in that project, and the caller must
		// be able to see it, before anything in the thread is written.
		await assertDocumentProjectAccess({
			documentRefKind: join.documentRefKind,
			documentRefId: join.documentRefId,
			projectId: input.projectId,
			userId: user.id,
		});

		const conversationId = join.conversation.id;
		await db.$transaction(async (tx) => {
			if (!(await lockConversationRow(tx, conversationId))) {
				throw new ORPCError("NOT_FOUND", {
					message: "Conversation not found",
				});
			}
			const conversation = await tx.agentConversation.findUnique({
				where: { id: conversationId },
				select: { messages: true },
			});
			const next = stampToolCall(conversation?.messages, {
				messageId: input.messageId,
				toolCallId: input.toolCallId,
				outcome: input.outcome,
				at: input.at,
			});

			// We deliberately do NOT bump `documentAssistantConversation.updatedAt`
			// here — recordDiffOutcome is a meta-event on an existing turn, not a
			// new turn. Keeping the join's updatedAt stable means the History
			// drawer's date-grouping ("Today / Yesterday / …") doesn't shuffle
			// when a teammate clicks accept on a hours-old diff.
			await tx.agentConversation.update({
				where: { id: conversationId },
				data: { messages: next as never },
			});
		});

		return { success: true as const };
	});

/**
 * Returns the stored messages with the outcome stamped on the tool call
 * (messageId, toolCallId); every other message and tool call is returned
 * as it was. Throws NOT_FOUND when the turn holds no such tool call.
 */
function stampToolCall(
	storedMessages: unknown,
	input: DiffOutcome,
): StoredMessage[] {
	const messages = Array.isArray(storedMessages)
		? (storedMessages as StoredMessage[])
		: [];

	let messageIndex = -1;
	let toolCallIndex = -1;
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!m || typeof m !== "object" || m.id !== input.messageId) {
			continue;
		}
		if (!Array.isArray(m.toolCalls)) {
			break;
		}
		for (let j = 0; j < m.toolCalls.length; j++) {
			const tc = m.toolCalls[j];
			if (tc && typeof tc === "object" && tc.id === input.toolCallId) {
				messageIndex = i;
				toolCallIndex = j;
				break;
			}
		}
		if (messageIndex !== -1) {
			break;
		}
	}

	if (messageIndex === -1 || toolCallIndex === -1) {
		throw new ORPCError("NOT_FOUND", {
			message: "Tool call not found",
		});
	}

	return messages.map((m, i) => {
		if (i !== messageIndex) {
			return m;
		}
		const toolCalls = (m.toolCalls ?? []).map((tc, j) => {
			if (j !== toolCallIndex) {
				return tc;
			}
			return {
				...tc,
				acceptedAt:
					input.outcome === "accepted"
						? input.at
						: (tc.acceptedAt ?? null),
				rejectedAt:
					input.outcome === "rejected"
						? input.at
						: (tc.rejectedAt ?? null),
			};
		});
		return { ...m, toolCalls };
	});
}
