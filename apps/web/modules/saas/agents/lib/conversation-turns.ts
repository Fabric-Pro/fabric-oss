/**
 * Projecting a flat message array into conversation turns.
 *
 * A turn is one user message plus every agent response to it, keyed by
 * `turnId`. This is what makes a parallel multi-model reply legible: several
 * assistant messages share a turn and each carries its own agent identity, so
 * the UI can group them under the question that produced them.
 *
 * Lifted out of the Nexus page, which was the only surface that could render
 * more than one response per turn. The unified agent interface needs the same
 * projection on the shared chat components (#2040), and a multi-select picker
 * without it would silently drop every response after the first.
 *
 * Pure: no React, no data fetching. The projection is a client-side view over
 * the persisted message array — there is no turn table and no migration.
 */

import type {
	AgentResponse,
	ConversationTurn,
} from "../hooks/useMultiAgentStream";

/** Display name for a response with no agent attribution of its own. */
export const DEFAULT_AI_AGENT_NAME = "Nexus";
/** Superseded name still present in older persisted rows. */
export const LEGACY_DEFAULT_AI_AGENT_NAME = "AI Companion";

/**
 * Legacy attribution format: `[Agent Name]: message`. Older rows carry the
 * agent in a content prefix rather than in dedicated fields, so the parser
 * below still has to understand it.
 */
const HISTORY_AGENT_PREFIX_REGEX = /^\[([^\]]+)\]:\s*([\s\S]*)$/;

/**
 * One persisted message, as the turn projection needs to see it.
 *
 * `turnId`, `agentId`, `agentName` and `vendor` are what carry a fan-out:
 * several assistant messages sharing a `turnId`, each naming its own agent.
 */
export interface HistoryChatMessage {
	id?: string;
	role: string;
	content: string;
	timestamp?: string;
	turnId?: string;
	agentId?: string;
	agentName?: string;
	vendor?: string;
	executionId?: string;
	streamStatus?: "idle" | "streaming" | "completed" | "error" | "cancelled";
	toolCalls?: Array<{
		id: string;
		name: string;
		args?: unknown;
		result?: unknown;
		status: string;
		serverName?: string;
		mcpAppResourceUri?: string;
		mcpAppConfigId?: string;
	}>;
}
function slugifyAgentName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
function inferVendorFromAgentName(name: string): string | undefined {
	const normalized = name.toLowerCase();

	if (normalized.includes("claude")) {
		return "Anthropic";
	}
	if (
		normalized.includes("gpt") ||
		normalized.includes("openai") ||
		normalized === "o1" ||
		normalized === "o3" ||
		normalized.startsWith("o1-") ||
		normalized.startsWith("o3-")
	) {
		return "OpenAI";
	}
	if (normalized.includes("gemini")) {
		return "Google";
	}
	if (normalized.includes("grok")) {
		return "xAI";
	}
	if (normalized.includes("deepseek")) {
		return "DeepSeek";
	}
	if (normalized.includes("mistral")) {
		return "Mistral AI";
	}
	if (normalized.includes("cohere") || normalized.includes("command")) {
		return "Cohere";
	}
	if (normalized.includes("groq")) {
		return "Groq";
	}
	if (normalized.includes("llama")) {
		return "Meta";
	}

	return undefined;
}
export function parseHistoryAssistantMessage(content: string): {
	agentName: string;
	agentId: string;
	vendor?: string;
	content: string;
} {
	const match = content.match(HISTORY_AGENT_PREFIX_REGEX);
	const rawAgentName = match?.[1]?.trim() || DEFAULT_AI_AGENT_NAME;
	const normalizedContent = (match?.[2] ?? content).trim();
	const vendor = inferVendorFromAgentName(rawAgentName);
	const slug = slugifyAgentName(rawAgentName) || "nexus";

	return {
		agentName: rawAgentName,
		agentId: vendor ? `model:${slug}` : `history:${slug}`,
		vendor,
		content: normalizedContent,
	};
}
export function getHistoryAssistantIdentity(message: HistoryChatMessage): {
	agentName: string;
	agentId: string;
	vendor?: string;
	content: string;
	executionId?: string;
	streamStatus?: "idle" | "streaming" | "completed" | "error" | "cancelled";
} {
	const parsed = parseHistoryAssistantMessage(message.content);

	if (message.agentId && message.agentName) {
		return {
			agentName: message.agentName,
			agentId: message.agentId,
			vendor:
				message.vendor ?? inferVendorFromAgentName(message.agentName),
			content: parsed.content,
			executionId: message.executionId,
			streamStatus: message.streamStatus,
		};
	}

	return {
		...parsed,
		executionId: message.executionId,
		streamStatus: message.streamStatus,
	};
}
export function buildTurnsFromHistory(
	messages: HistoryChatMessage[],
): ConversationTurn[] {
	const turns: ConversationTurn[] = [];
	const turnsById = new Map<string, ConversationTurn>();
	let currentTurn: ConversationTurn | null = null;

	for (const [index, message] of messages.entries()) {
		if (message.role !== "user" && message.role !== "assistant") {
			continue;
		}
		if (typeof message.content !== "string") {
			continue;
		}
		// Skip messages with no content AND no tool calls (nothing to display)
		const hasContent = message.content.trim().length > 0;
		const hasToolCalls = (message.toolCalls ?? []).length > 0;
		if (!hasContent && !hasToolCalls) {
			continue;
		}

		const timestamp = message.timestamp
			? new Date(message.timestamp)
			: new Date();

		if (message.role === "user") {
			const turnId =
				message.turnId ?? message.id ?? `history-turn-${index}`;
			currentTurn = {
				id: turnId,
				userMessage: message.content,
				agentResponses: new Map<string, AgentResponse>(),
				timestamp,
			};
			turnsById.set(turnId, currentTurn);
			turns.push(currentTurn);
			continue;
		}

		const parsed = getHistoryAssistantIdentity(message);
		const targetTurn =
			(message.turnId ? turnsById.get(message.turnId) : null) ??
			currentTurn;
		if (!targetTurn) {
			continue;
		}

		targetTurn.agentResponses.set(parsed.agentId, {
			agentId: parsed.agentId,
			agentName: parsed.agentName,
			vendor: parsed.vendor,
			executionId: parsed.executionId,
			content: parsed.content,
			toolCalls: (message.toolCalls ?? []).map((tc) => ({
				id: tc.id,
				name: tc.name,
				args: tc.args,
				result: tc.result,
				status: tc.status as
					| "complete"
					| "error"
					| "pending"
					| "running",
				serverName: tc.serverName,
				mcpAppResourceUri: tc.mcpAppResourceUri,
				mcpAppConfigId: tc.mcpAppConfigId,
			})),
			isLoading: parsed.streamStatus === "streaming",
			isError: parsed.streamStatus === "error",
			status: parsed.streamStatus ?? "completed",
		});
	}

	return turns;
}
