import { getAIModelWithMetadata } from "@repo/ai";
import { heartbeat } from "@temporalio/activity";
import { generateText } from "ai";
import { publishExecutionEvent } from "../../../lib/redis-publisher";
import type { IterativeMessage } from "../../../workflows/orchestrator/types";

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
}

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
	// Build tool-call-id → tool-name lookup for tool result attribution
	const toolCallIdToName = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role === "assistant" && msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				toolCallIdToName.set(tc.id, tc.name);
			}
		}
	}

	const lines: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			lines.push(`USER: ${msg.content}`);
		} else if (msg.role === "assistant") {
			if (msg.content?.trim()) {
				lines.push(`ASSISTANT: ${msg.content}`);
			}
			if (msg.toolCalls) {
				for (const tc of msg.toolCalls) {
					const argPreview = JSON.stringify(tc.args).slice(0, 500);
					lines.push(
						`ASSISTANT_TOOL_CALL: ${tc.name}(${argPreview}${argPreview.length >= 500 ? "..." : ""})`,
					);
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

	const { model } = await getAIModelWithMetadata(
		{ taskType: "SIMPLE" },
		{ userId, organizationId },
	);

	const transcript = renderMessagesAsTranscript(oldTurns);

	heartbeat({ phase: "compacting" });

	const result = await generateText({
		model,
		system: SYSTEM_PROMPT,
		prompt: `User's original task:\n${currentTask}\n\n=== EARLIER CONVERSATION TO COMPACT ===\n${transcript}\n=== END ===\n\nProduce the PROGRESS SO FAR summary now.`,
		maxOutputTokens: maxSummaryTokens,
		temperature: 0.2,
	});

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
