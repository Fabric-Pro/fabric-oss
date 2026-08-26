/**
 * `postOperationResultActivity` — Fizzy #1412 PR1.
 *
 * Persists an operation-completion system message into an
 * `AgentConversation` and emits a realtime `message_appended` event.
 * Designed to be called as the final step of a Temporal workflow's
 * completion phase (PR2 wires it into the orchestrator + direct-chat
 * completion phases).
 *
 * # Determinism
 *
 *   - This is an ACTIVITY, not a workflow function. The activity body
 *     can do I/O freely; Temporal records the activity's input + result
 *     in history, so workflow replays are deterministic regardless of
 *     when the side effects happened.
 *   - The workflow caller passes an `operationKey` that is stable
 *     across retries (e.g. `${executionId}-result`). The underlying
 *     `appendConversationMessage` dedups on this key, so a retried
 *     activity will NEVER append a duplicate row to the messages array.
 *
 * # Error handling (NFR: must not fail the operation)
 *
 *   All errors are caught and logged; the activity returns
 *   `{ posted: false, reason }` instead of throwing. This is the entire
 *   point of running it inside `CancellationScope.nonCancellable` (PR2
 *   wires that wrapping in the workflow): the chat message is "nice to
 *   have", and the workflow's primary success path must not regress
 *   because the chat persistence had a transient blip.
 *
 *   Specifically:
 *     - DB-level failures (Postgres down, lock timeout) → swallow + log.
 *     - Realtime emit failures → already swallowed by the realtime
 *       helper itself; this layer never sees them.
 *     - Validation failures (missing operationKey) → swallow + log;
 *       these are caller bugs but should not break the operation.
 *
 * # Why this lives in `packages/temporal` and not `packages/api`
 *
 *   `packages/api` depends on `packages/temporal` (for workflow
 *   start/signal helpers); inverting that would create a cycle. The
 *   activity is server-side code that runs in the Temporal worker, so
 *   it lives next to the other activities. It static-imports the pure
 *   formatter (`@repo/utils/operation-result-message`), the realtime
 *   emit helper (`@repo/utils/realtime-emit`), and the DB primitive
 *   (`@repo/database`) — none of which sit above `@repo/temporal`.
 *   Previous revisions of this file used a dynamic `await import(...)`
 *   into `@repo/api/lib/realtime` to side-step the cycle, but that path
 *   was structurally broken because `@repo/api` is not declared in
 *   `packages/temporal/package.json` — every call silently fell through
 *   the catch block and the realtime push never fired. Hoisting the
 *   emit helper to `@repo/utils` (a neutral dependency both packages
 *   already share) is the durable fix.
 */

import { randomUUID } from "node:crypto";
import {
	appendConversationMessage,
	ConversationNotFoundError,
} from "@repo/database/prisma/queries/agent-conversations";
import {
	buildOperationResultMessage,
	type OperationArtifact,
	type OperationOutcome,
} from "@repo/utils/operation-result-message";
import { emitConversationMessageAppended } from "@repo/utils/realtime-emit";
import { Context } from "@temporalio/activity";

export interface PostOperationResultInput {
	readonly conversationId: string;
	readonly userId: string;
	readonly organizationId?: string | null;
	readonly operationKey: string;
	readonly outcome: OperationOutcome;
	readonly operationLabel: string;
	readonly summary: string;
	readonly artifact?: OperationArtifact;
	readonly errorCode?: string;
}

export interface PostOperationResultOutput {
	readonly posted: boolean;
	readonly messageId?: string;
	readonly deduplicated?: boolean;
	readonly reason?: string;
}

export async function postOperationResultActivity(
	input: PostOperationResultInput,
): Promise<PostOperationResultOutput> {
	const ctxLog = ((): {
		info: (msg: string, meta?: Record<string, unknown>) => void;
		warn: (msg: string, meta?: Record<string, unknown>) => void;
		error: (msg: string, meta?: Record<string, unknown>) => void;
	} => {
		try {
			return Context.current().log;
		} catch {
			// Not running under a Temporal activity (e.g. local
			// dev/test). Fall back to console; the activity is still
			// callable for integration tests.
			return {
				info: (msg, meta) =>
					console.log(`[post-operation-result] ${msg}`, meta ?? {}),
				warn: (msg, meta) =>
					console.warn(`[post-operation-result] ${msg}`, meta ?? {}),
				error: (msg, meta) =>
					console.error(`[post-operation-result] ${msg}`, meta ?? {}),
			};
		}
	})();

	try {
		const { content, metadata } = buildOperationResultMessage({
			outcome: input.outcome,
			operationLabel: input.operationLabel,
			summary: input.summary,
			artifact: input.artifact,
			errorCode: input.errorCode,
		});

		const messageId = randomUUID();
		const timestamp = new Date().toISOString();

		const result = await appendConversationMessage({
			id: input.conversationId,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
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

		// Realtime emit failures are already swallowed inside the
		// helper; wrapping in another try/catch here would be belt and
		// braces. We do, however, await it so the caller's activity
		// duration reflects the full operation.
		await emitConversationMessageAppended({
			conversationId: input.conversationId,
			messageId: result.persisted.id,
			appendedAt: timestamp,
		});

		ctxLog.info("operation-result message posted", {
			conversationId: input.conversationId,
			messageId: result.persisted.id,
			deduplicated: result.deduplicated,
			outcome: input.outcome,
		});

		return {
			posted: true,
			messageId: result.persisted.id,
			deduplicated: result.deduplicated,
		};
	} catch (error) {
		if (error instanceof ConversationNotFoundError) {
			ctxLog.warn(
				"operation-result skipped: conversation not found or wrong tenant",
				{
					conversationId: input.conversationId,
					userId: input.userId,
				},
			);
			return { posted: false, reason: "conversation_not_found" };
		}
		const message = error instanceof Error ? error.message : String(error);
		ctxLog.error(
			"operation-result post failed (swallowed; operation is non-fatal)",
			{
				conversationId: input.conversationId,
				userId: input.userId,
				error: message,
			},
		);
		return { posted: false, reason: message };
	}
}
