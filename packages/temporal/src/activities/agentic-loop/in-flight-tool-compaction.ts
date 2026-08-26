/**
 * In-flight tool-result compaction for AI SDK multi-step loops.
 *
 * When a `generateText`/`streamText` call has `stopWhen: stepCountIs(N)` and
 * tools that return large outputs (e.g. `project_rag_query` returning 50+
 * reranked contexts), every prior tool result is re-sent to the model on
 * each subsequent step. Two RAG calls × ~60K chars each plus the assistant
 * traces between them quickly blow past Claude's 200K-token cap, even though
 * the agent has already read and acted on the earlier results.
 *
 * This helper plugs into the `prepareStep` callback. When estimated total
 * size crosses the budget, it rewrites the `output` of older tool results
 * to a short header — keeping the tool-call/tool-result pairing intact so
 * the conversation skeleton stays valid for every provider.
 *
 * The most recent N tool results are kept verbatim so the model still sees
 * the full body of work it's currently reasoning over.
 */

import type { ModelMessage, ToolModelMessage, ToolResultPart } from "ai";

interface CompactorOptions {
	/**
	 * Approximate char budget across all messages before compaction kicks in.
	 * Claude's 200K-token cap ≈ 800K chars; pick a budget that leaves
	 * headroom for the next tool result, the response, and provider overhead.
	 */
	charBudget?: number;
	/** Number of most-recent tool messages to leave untouched. */
	keepRecentToolMessages?: number;
	/**
	 * Tool-result outputs smaller than this many serialized chars are not
	 * worth rewriting — the header can be longer than the body.
	 */
	minOutputCharsToCompact?: number;
}

const DEFAULT_CHAR_BUDGET = 400_000;
const DEFAULT_KEEP_RECENT_TOOL_MESSAGES = 1;
const DEFAULT_MIN_OUTPUT_CHARS = 1000;

export function makeInFlightToolCompactor(opts: CompactorOptions = {}) {
	const charBudget = opts.charBudget ?? DEFAULT_CHAR_BUDGET;
	const keepRecent =
		opts.keepRecentToolMessages ?? DEFAULT_KEEP_RECENT_TOOL_MESSAGES;
	const minOutputChars =
		opts.minOutputCharsToCompact ?? DEFAULT_MIN_OUTPUT_CHARS;

	return ({ messages }: { messages: ModelMessage[] }) => {
		const totalChars = estimateMessagesChars(messages);
		if (totalChars < charBudget) {
			return {};
		}

		const toolIndices: number[] = [];
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].role === "tool") {
				toolIndices.push(i);
			}
		}
		if (toolIndices.length <= keepRecent) {
			return {};
		}
		// Highest message index that should be compacted (everything after is kept).
		const cutoffIndex = toolIndices[toolIndices.length - keepRecent - 1];

		const rewritten = messages.map((m, i) => {
			if (i > cutoffIndex || m.role !== "tool") {
				return m;
			}
			return compactToolMessage(m as ToolModelMessage, minOutputChars);
		});

		return { messages: rewritten };
	};
}

function compactToolMessage(
	msg: ToolModelMessage,
	minOutputChars: number,
): ToolModelMessage {
	return {
		...msg,
		content: msg.content.map((part) => {
			if (part.type !== "tool-result") {
				return part;
			}
			return compactToolResultPart(part, minOutputChars);
		}),
	};
}

function compactToolResultPart(
	part: ToolResultPart,
	minOutputChars: number,
): ToolResultPart {
	const outputChars = estimateOutputChars(part.output);
	if (outputChars < minOutputChars) {
		return part;
	}

	const sizeKb = Math.round(outputChars / 1000);
	const summary = `[Older ${part.toolName} result truncated to fit context budget (~${sizeKb}KB original). The agent already processed this in an earlier step; call the tool again with a refined query if more detail is needed.]`;

	return {
		...part,
		output: { type: "text", value: summary },
	};
}

function estimateMessagesChars(messages: ModelMessage[]): number {
	let total = 0;
	for (const m of messages) {
		total += estimateContentChars(m.content);
	}
	return total;
}

function estimateContentChars(content: ModelMessage["content"]): number {
	if (typeof content === "string") {
		return content.length;
	}
	if (!Array.isArray(content)) {
		return 0;
	}
	let total = 0;
	for (const part of content) {
		total += estimatePartChars(part);
	}
	return total;
}

function estimatePartChars(part: unknown): number {
	if (!part || typeof part !== "object") {
		return 0;
	}
	const p = part as { type?: string; text?: string; output?: unknown };
	if (p.type === "text" && typeof p.text === "string") {
		return p.text.length;
	}
	if (p.type === "tool-result") {
		return estimateOutputChars(p.output);
	}
	// Reasoning, file, image, tool-call: rough JSON-based estimate.
	try {
		return JSON.stringify(p).length;
	} catch {
		return 0;
	}
}

function estimateOutputChars(output: unknown): number {
	if (output == null) {
		return 0;
	}
	if (typeof output === "string") {
		return output.length;
	}
	if (typeof output === "object") {
		const o = output as { type?: string; value?: unknown };
		if (o.type === "text" && typeof o.value === "string") {
			return o.value.length;
		}
		try {
			return JSON.stringify(o).length;
		} catch {
			return 0;
		}
	}
	return String(output).length;
}
