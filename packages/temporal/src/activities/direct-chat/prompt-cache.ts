import {
	cacheableSystem,
	withRollingCacheBreakpoint,
} from "@repo/ai/prompt-cache";

/**
 * Direct-chat instructions that are identical across conversations and turns.
 * Keep request-, tenant-, tool-, and date-specific content out of this prefix
 * so provider prompt caches can reuse it safely.
 */
export const DIRECT_CHAT_IDENTITY =
	"You are Fabric Loom, an intelligent assistant that helps users accomplish tasks.";

export const DIRECT_CHAT_TOOL_USAGE_GUIDELINES = `TOOL USAGE GUIDELINES:
- CAREFULLY read the tool's input schema to understand ALL available filter/query parameters
- When the user specifies filters, ALWAYS use the appropriate filter parameters
- Do NOT fetch ALL data and filter client-side - use server-side filtering
- Only fetch the minimum data needed to answer the user's question
- When an MCP tool is available that matches the user's request, call it — do not give text instructions instead`;

export const DIRECT_CHAT_RESPONSE_GUIDELINES = `RESPONSE GUIDELINES:
- Use markdown for formatting (tables, bullet points, code blocks)
- Be concise but complete
- Cite sources when using document context or web search results`;

export const DIRECT_CHAT_CACHEABLE_SYSTEM_PROMPT = [
	DIRECT_CHAT_IDENTITY,
	DIRECT_CHAT_TOOL_USAGE_GUIDELINES,
	DIRECT_CHAT_RESPONSE_GUIDELINES,
].join("\n\n");

interface LegacyDirectChatSystemInput {
	capabilitiesInstructions: string;
	webSearchInstructions: string;
	frameOutputInstructions: string;
	currentDateContext: string;
}

/**
 * Preserve the exact pre-cache direct-chat system template for providers that
 * do not use the Anthropic cache-aware message shape. The seemingly redundant
 * newlines around optional sections are intentional legacy prompt bytes.
 */
export function buildLegacyDirectChatSystemInstructions({
	capabilitiesInstructions,
	webSearchInstructions,
	frameOutputInstructions,
	currentDateContext,
}: LegacyDirectChatSystemInput): string {
	return `${DIRECT_CHAT_IDENTITY}

${capabilitiesInstructions}

${DIRECT_CHAT_TOOL_USAGE_GUIDELINES}
${webSearchInstructions ? `\n${webSearchInstructions}\n` : ""}
${DIRECT_CHAT_RESPONSE_GUIDELINES}
${frameOutputInstructions ? `\n${frameOutputInstructions}` : ""}

${currentDateContext}`;
}

interface DirectChatPromptCacheInput<Message> {
	promptCacheEnabled: boolean;
	rollingHistoryEnabled: boolean;
	systemPrompt: string;
	messages: readonly Message[];
}

interface VariableSystemMessage {
	role: "system";
	content: string;
}

interface DirectChatPromptCacheRequest<Message> {
	system:
		| string
		| ReturnType<typeof cacheableSystem>
		| [ReturnType<typeof cacheableSystem>, VariableSystemMessage];
	messages: Array<Message | VariableSystemMessage>;
}

/**
 * Assemble the cache-aware fields passed to streamText.
 *
 * Every explicit-cache target gets adjacent stable and variable top-level
 * system blocks. Models known to support Anthropic's mid-conversation system
 * beta additionally receive a rolling history breakpoint; their variable
 * context moves to a terminal system message after the current turn.
 *
 * Other providers retain the legacy full-system-string request shape and
 * receive a shallow copy of the unmarked messages.
 */
export function buildDirectChatPromptCacheRequest<Message>({
	promptCacheEnabled,
	rollingHistoryEnabled,
	systemPrompt,
	messages,
}: DirectChatPromptCacheInput<Message>): DirectChatPromptCacheRequest<Message> {
	if (!promptCacheEnabled) {
		return {
			system: systemPrompt,
			messages: [...messages],
		};
	}

	const variableSystemMessage = {
		role: "system" as const,
		content: systemPrompt,
	};
	if (!rollingHistoryEnabled) {
		return {
			system: [
				cacheableSystem(DIRECT_CHAT_CACHEABLE_SYSTEM_PROMPT),
				variableSystemMessage,
			],
			messages: [...messages],
		};
	}

	const currentMessage = messages.at(-1);
	const history =
		currentMessage === undefined ? messages : messages.slice(0, -1);
	const markedHistory = withRollingCacheBreakpoint(history) as Message[];

	return {
		system: cacheableSystem(DIRECT_CHAT_CACHEABLE_SYSTEM_PROMPT),
		messages: [
			...markedHistory,
			...(currentMessage === undefined ? [] : [currentMessage]),
			variableSystemMessage,
		],
	};
}
