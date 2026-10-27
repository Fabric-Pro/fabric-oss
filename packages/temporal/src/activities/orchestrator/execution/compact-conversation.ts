import { getAIModelWithMetadata } from "@repo/ai";
import { AI_CALL_PURPOSES } from "@repo/ai/lib/call-purpose";
import { clampRequestedOutputTokens } from "@repo/ai/lib/output-token-budget";
import { heartbeat } from "@temporalio/activity";
import { generateText } from "ai";
import { publishExecutionEvent } from "../../../lib/redis-publisher";
import type { IterativeMessage } from "../../../workflows/orchestrator/types";
import { usageOriginFields } from "../../../workflows/orchestrator/usage-attribution";
import {
	activityAbortSignal,
	guardTurnModel,
	rethrowIfTurnStopped,
	startHeartbeatTicker,
	type TurnScope,
} from "../turn-dispatch";

export interface CompactConversationInput {
	/** Turns to fold into the summary. Should already exclude the original user message. */
	oldTurns: IterativeMessage[];
	/** The user's original task — anchors the summary so it stays goal-relevant */
	currentTask: string;
	/** Caller for tenant-aware model resolution */
	userId: string;
	organizationId?: string;
	/** Hard cap on summary output tokens */
	maxSummaryTokens: number;
	/**
	 * Execution ID for emitting the `execution.context_compacted` SSE event so
	 * the UI can show a "Compressed earlier context to keep going" hint. Workflow
	 * code is sandboxed and cannot publish events directly, so this happens here.
	 */
	executionId?: string;
	/** Iteration number at which compaction fired (for the SSE event payload) */
	iteration?: number;
	/** Pre-compaction history length (for the SSE event payload) */
	historyLengthBefore?: number;
	/**
	 * The chat conversation this call serves, when there is one. Recorded on
	 * the usage-log row for cost attribution only.
	 */
	conversationId?: string;
	frameId?: string;
	projectId?: string;
	/**
	 * The chat turn this compaction belongs to; when set, the turn record is
	 * consulted before the model request (see turn-dispatch.ts).
	 */
	turnScope?: TurnScope;
}

/**
 * Heartbeat cadence while the summary is generated: keeps the activity
 * alive under its 1-minute heartbeat timeout and lets a Stop reach it while
 * the provider is still working.
 */
const COMPACTION_HEARTBEAT_INTERVAL_MS = 5_000;

export interface CompactConversationResult {
	summaryText: string;
	usage: { inputTokens: number; outputTokens: number };
}

const SYSTEM_PROMPT = `You are compacting the earlier portion of an ongoing agentic workflow to reclaim context budget. The agent will continue working on the task after this compaction, using your summary as context for what's already been done.

Produce a structured "PROGRESS SO FAR" summary. Include:
1. **Artifacts examined or created** — files, paths, frames, documents, with concrete identifiers
2. **Findings** — concrete facts the agent has discovered (data, code structure, decisions made)
3. **Tools used and their outcomes** — which tools were invoked and what they returned (don't list every call, group by purpose)
4. **What's been done vs. what's still TODO** — be explicit about both

Rules:
- Preserve ALL names, paths, IDs, numbers, and concrete identifiers
- Be specific. "Examined the auth module" is bad. "Examined packages/auth/src/sessions.ts and confirmed the session token TTL is 30 days" is good.
- No preamble. Start directly with the summary.
- Plain text. No JSON, no code fences around the whole output.
- Under 1500 words.`;

/**
 * Format an IterativeMessage array into a plain-text transcript suitable as
 * a single LLM prompt. Tool calls are flattened to readable lines; tool
 * results are quoted with their tool name resolved from the preceding
 * assistant message.
 */
function renderMessagesAsTranscript(messages: IterativeMessage[]): string {
	const toolCallIdToName = new Map<string, string>();

	const lines: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			lines.push(`USER: ${msg.content}`);
		} else if (msg.role === "assistant") {
			toolCallIdToName.clear();
			for (const call of msg.toolCalls ?? []) {
				toolCallIdToName.set(call.id, call.name);
			}
			const renderCall = (id: string) => {
				const call = msg.toolCalls?.find(
					(candidate) => candidate.id === id,
				);
				if (!call) {
					return;
				}
				const argPreview = JSON.stringify(call.args).slice(0, 500);
				lines.push(
					`ASSISTANT_TOOL_CALL: ${call.name}(${argPreview}${argPreview.length >= 500 ? "..." : ""})`,
				);
			};
			if (msg.assistantParts) {
				for (const part of msg.assistantParts) {
					if (part.type === "text") {
						lines.push(`ASSISTANT: ${part.text}`);
					} else {
						renderCall(part.toolCallId);
					}
				}
			} else {
				if (msg.content?.trim()) {
					lines.push(`ASSISTANT: ${msg.content}`);
				}
				for (const call of msg.toolCalls ?? []) {
					renderCall(call.id);
				}
			}
		} else if (msg.role === "tool") {
			const toolName =
				toolCallIdToName.get(msg.toolCallId || "") || "unknown_tool";
			// Cap each tool result; the per-result summarizer already trimmed
			// these on the way in, but defense-in-depth keeps the prompt small.
			const resultPreview = msg.content.slice(0, 4000);
			lines.push(
				`TOOL_RESULT[${toolName}]: ${resultPreview}${msg.content.length > 4000 ? "\n... [truncated]" : ""}`,
			);
		}
	}
	return lines.join("\n\n");
}

export async function compactConversationHistoryActivity(
	input: CompactConversationInput,
): Promise<CompactConversationResult> {
	const { oldTurns, currentTask, userId, organizationId, maxSummaryTokens } =
		input;

	if (oldTurns.length === 0) {
		return {
			summaryText: "",
			usage: { inputTokens: 0, outputTokens: 0 },
		};
	}

	const { model, metadata } = await getAIModelWithMetadata(
		{ taskType: "SIMPLE" },
		{
			userId,
			organizationId,
			callPurpose: AI_CALL_PURPOSES.compaction,
			featureKey: "chat-agent",
			...usageOriginFields(input),
		},
	);

	const transcript = renderMessagesAsTranscript(oldTurns);

	heartbeat({ phase: "compacting" });

	// Every physical request — the SDK's own retries included — is checked
	// against the turn record (see guardTurnModel).
	const guarded = guardTurnModel(model, input.turnScope);
	// Heartbeat for the whole call, not once before it: a single heartbeat
	// left a long summary call with nothing to keep it alive or to deliver
	// a cancel to it.
	const stopHeartbeat = startHeartbeatTicker(
		COMPACTION_HEARTBEAT_INTERVAL_MS,
		{ phase: "compacting" },
	);
	let result: Awaited<ReturnType<typeof generateText>>;
	try {
		result = await generateText({
			model: guarded.model,
			instructions: SYSTEM_PROMPT,
			prompt: `User's original task:\n${currentTask}\n\n=== EARLIER CONVERSATION TO COMPACT ===\n${transcript}\n=== END ===\n\nProduce the PROGRESS SO FAR summary now.`,
			maxOutputTokens: clampRequestedOutputTokens(
				maxSummaryTokens,
				metadata,
			),
			temperature: 0.2,
			// A cancelled activity aborts the request in flight.
			abortSignal: activityAbortSignal(),
		});
	} catch (error) {
		// An aborted request surfaces as the SDK's abort error; report the
		// activity cancelled, which is what it is. A refusal the SDK wrapped
		// in its retry error is rethrown as itself.
		rethrowIfTurnStopped(error);
		throw error;
	} finally {
		stopHeartbeat();
	}

	if (input.executionId && result.text.trim().length > 0) {
		publishExecutionEvent(input.executionId, {
			event: "execution.context_compacted",
			data: {
				iteration: input.iteration ?? 0,
				compactedTurns: oldTurns.length,
				summaryChars: result.text.length,
				historyLengthBefore: input.historyLengthBefore ?? 0,
			},
		});
	}

	return {
		summaryText: result.text,
		usage: {
			inputTokens: result.usage?.inputTokens ?? 0,
			outputTokens: result.usage?.outputTokens ?? 0,
		},
	};
}
