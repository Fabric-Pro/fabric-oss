/**
 * `agents.conversations.recordOperationResult` — Fizzy #1412 PR1.
 *
 * Persists a single "operation completed" system message into an
 * AgentConversation and emits a realtime `message_appended` event so
 * any open SSE subscriber can re-validate the conversation's message
 * list.
 *
 * # PR1 contract (IMPORTANT)
 *
 *   This handler is exported as a named constant but **deliberately
 *   NOT registered in any router file** during PR1. Codex round-2
 *   feedback (plan §10 P1.5) flagged that shipping a new oRPC
 *   endpoint with zero callers in PR1 would create new attack
 *   surface without any code paths exercising the authorization
 *   model. PR1 ships the handler so its persistence + realtime
 *   plumbing can be tested in isolation; PR3 (Tier 2 wire-up) adds
 *   the router registration for the Sidekick / Backlog / CopilotKit
 *   callers.
 *
 *   TODO(#1412 PR3): register in `packages/api/modules/agents/router.ts`
 *   (or wherever the agents-conversations sub-router lives) alongside
 *   the other conversation procedures.
 *
 * # Authorization
 *
 * Uses `tenantProtectedProcedure` (auth + tenant context) and
 * `requireProjectPermission(PROJECT_UPDATE)` — the same population
 * that's authorized to edit project content is authorized to record
 * completion outcomes on the chat. Mirrors `record-diff-outcome.ts`.
 *
 * `appendConversationMessage` is the gatekeeper for the actual data
 * write: it does the SELECT FOR UPDATE with tenant filter and throws
 * `ConversationNotFoundError` on mismatch. The handler maps that to
 * `ORPCError("NOT_FOUND")` with a generic message; we never reveal
 * whether the row exists in a different tenant.
 *
 * # Idempotency
 *
 * `operationKey` (caller-supplied) is the dedup key. If a previous
 * call already persisted a message with the same key in this
 * conversation, the append is a no-op and the handler returns
 * `deduplicated: true` with the existing message id. Callers should
 * use a stable key derived from the upstream operation (e.g.
 * `${workflowId}-${runId}-result`).
 */

import { ORPCError } from "@orpc/server";
import {
	appendConversationMessage,
	ConversationNotFoundError,
} from "@repo/database/prisma/queries/agent-conversations";
import { buildOperationResultMessage } from "@repo/utils/operation-result-message";
import { z } from "zod";
// Same-package import: this module lives at
// packages/api/modules/agents/procedures/conversations/, so the
// realtime helper at packages/api/lib/realtime is four levels up.
// Mirrors the relative-path convention used by every other
// in-package consumer (see e.g. modules/projects/procedures/create-document.ts).
import { emitConversationMessageAppended } from "../../../../lib/realtime";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const OperationOutcomeSchema = z.enum([
	"success",
	"failure",
	"partial",
	"cancelled",
]);

const ArtifactSchema = z
	.object({
		label: z.string().min(1),
		url: z.string().url(),
	})
	.optional();

export const recordOperationResult = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/agents/conversations/{conversationId}/operation-result",
		tags: ["Agent Conversations"],
		summary: "Record an operation-completion system message",
		description:
			"Persists a single role='system' message describing the outcome of an AI operation. Idempotent on `operationKey`.",
	})
	.input(
		z.object({
			conversationId: z.string().min(1),
			projectId: z.string().min(1),
			organizationId: z.string().nullable().optional(),
			operationKey: z.string().min(1),
			outcome: OperationOutcomeSchema,
			operationLabel: z.string().min(1),
			summary: z.string(),
			artifact: ArtifactSchema,
			errorCode: z.string().optional(),
		}),
	)
	.output(
		z.object({
			messageId: z.string(),
			deduplicated: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		const { content, metadata } = buildOperationResultMessage({
			outcome: input.outcome,
			operationLabel: input.operationLabel,
			summary: input.summary,
			artifact: input.artifact,
			errorCode: input.errorCode,
		});

		const messageId = crypto.randomUUID();
		const timestamp = new Date().toISOString();

		try {
			const result = await appendConversationMessage({
				id: input.conversationId,
				userId: user.id,
				organizationId: organizationId ?? null,
				message: {
					id: messageId,
					role: "system",
					content,
					timestamp,
					metadata: {
						...metadata,
						operationKey: input.operationKey,
					},
				},
			});

			// Emit realtime AFTER the row is persisted. We emit on dedup
			// as well: open subscribers re-validate their view either
			// way, and the only "extra" cost is one TanStack Query
			// re-validation. Dropping the emit on dedup would mean a
			// retried Temporal activity wouldn't surface the latest
			// state to anyone who happened to connect between the first
			// emit and the retry.
			await emitConversationMessageAppended({
				conversationId: input.conversationId,
				messageId: result.persisted.id,
				appendedAt: timestamp,
			});

			return {
				messageId: result.persisted.id,
				deduplicated: result.deduplicated,
			};
		} catch (error) {
			if (error instanceof ConversationNotFoundError) {
				throw new ORPCError("NOT_FOUND", {
					message: "Conversation not found",
				});
			}
			throw error;
		}
	});
