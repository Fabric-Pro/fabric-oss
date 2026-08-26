/**
 * `agents.conversations.recordDiffOutcome` — spec §3.8 FR-23 / §5.8.
 *
 * Patches the `messages` JSON blob to stamp `acceptedAt` / `rejectedAt`
 * on the targeted tool-call. Project members with PROJECT_UPDATE can
 * record outcomes — they are the same population already permitted to
 * accept / reject the diff via `DiffReviewBar` (a non-author teammate
 * can accept a teammate's draft edit). No audit event (spec §5.8 — diff
 * outcomes already log through the document-version pipeline).
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

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
				conversation: {
					select: { id: true, messages: true },
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

		const messages = Array.isArray(join.conversation.messages)
			? (join.conversation.messages as StoredMessage[])
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
				if (
					tc &&
					typeof tc === "object" &&
					tc.id === input.toolCallId
				) {
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

		const next = messages.map((m, i) => {
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

		// We deliberately do NOT bump `documentAssistantConversation.updatedAt`
		// here — recordDiffOutcome is a meta-event on an existing turn, not a
		// new turn. Keeping the join's updatedAt stable means the History
		// drawer's date-grouping ("Today / Yesterday / …") doesn't shuffle
		// when a teammate clicks accept on a hours-old diff.
		await db.agentConversation.update({
			where: { id: join.conversation.id },
			data: { messages: next as never },
		});

		// Touch the user binding to keep the linter from complaining; this
		// procedure has no per-user side effects beyond authorization.
		void user;

		return { success: true as const };
	});
