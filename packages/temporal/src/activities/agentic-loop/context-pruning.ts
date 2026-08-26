/**
 * Context Pruning Activity
 *
 * Summarizes long conversations to prevent token exhaustion in agentic loops.
 * When context exceeds threshold, summarizes older messages while
 * preserving recent context and key information.
 *
 * Strategies:
 * 1. Sliding Window: Keep last N messages, summarize the rest
 * 2. Token Budget: Fit within token limit by summarizing oldest content
 * 3. Importance-based: Use LLM to identify and preserve key information
 */

import { getAIModelWithMetadata } from "@repo/ai";
import { generateText } from "ai";

// =============================================================================
// Types
// =============================================================================

export interface Message {
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	name?: string;
	toolCallId?: string;
	timestamp?: string;
}

export interface ConversationContext {
	messages: Message[];
	systemPrompt?: string;
	knowledgeContext?: string;
	variables?: Record<string, unknown>;
}

export interface PruneContextInput {
	context: ConversationContext;
	/** Maximum tokens to target after pruning */
	maxTokens?: number;
	/** Minimum messages to always preserve at the end */
	preserveLastN?: number;
	/** Strategy for pruning */
	strategy?: "sliding_window" | "token_budget" | "importance_based";
	/** User ID for model resolution */
	userId: string;
	/** Organization ID for model resolution */
	organizationId?: string;
}

export interface PruneContextOutput {
	/** Pruned context ready for use */
	context: ConversationContext;
	/** Summary of pruned content */
	summary: string;
	/** Original token count estimate */
	originalTokens: number;
	/** Pruned token count estimate */
	prunedTokens: number;
	/** Number of messages removed */
	messagesRemoved: number;
	/** Whether pruning was performed */
	wasPruned: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_TOKENS = 100000; // 100k token context window target
const DEFAULT_PRESERVE_LAST_N = 10; // Always keep last 10 messages
const TOKENS_PER_CHAR = 0.25; // Rough estimate: 4 chars per token

const SUMMARY_PROMPT = `You are a conversation summarizer. Your task is to create a concise summary of the conversation that preserves:

1. **Key decisions** made during the conversation
2. **Important facts** and data mentioned
3. **Tool results** and their outcomes
4. **User preferences** or constraints stated
5. **Progress** toward the goal

The summary will be used to continue the conversation, so preserve all information needed for context.

Format your summary as:
## Conversation Summary
[Overview of what has been discussed]

## Key Decisions
- [Decision 1]
- [Decision 2]

## Important Information
- [Fact 1]
- [Fact 2]

## Tool Results
- [Tool name]: [Outcome]

## Current Status
[Where we are in the task]

---

Conversation to summarize:
`;

// =============================================================================
// Activity Implementation
// =============================================================================

/**
 * Prune conversation context to fit within token limits
 *
 * This activity is designed to be called during long-running agentic loops
 * when the conversation history grows too large.
 */
export async function pruneConversationContext(
	input: PruneContextInput,
): Promise<PruneContextOutput> {
	const {
		context,
		maxTokens = DEFAULT_MAX_TOKENS,
		preserveLastN = DEFAULT_PRESERVE_LAST_N,
		strategy = "token_budget",
		userId,
		organizationId,
	} = input;

	// Estimate current token count
	const originalTokens = estimateTokens(context);

	// Check if pruning is needed
	if (originalTokens <= maxTokens) {
		return {
			context,
			summary: "",
			originalTokens,
			prunedTokens: originalTokens,
			messagesRemoved: 0,
			wasPruned: false,
		};
	}

	// Perform pruning based on strategy
	switch (strategy) {
		case "sliding_window":
			return await pruneSlidingWindow(
				context,
				preserveLastN,
				userId,
				organizationId,
			);

		case "importance_based":
			return await pruneImportanceBased(
				context,
				maxTokens,
				preserveLastN,
				userId,
				organizationId,
			);
		default:
			return await pruneTokenBudget(
				context,
				maxTokens,
				preserveLastN,
				userId,
				organizationId,
			);
	}
}

// =============================================================================
// Pruning Strategies
// =============================================================================

/**
 * Sliding Window: Keep last N messages, summarize everything else
 */
async function pruneSlidingWindow(
	context: ConversationContext,
	preserveLastN: number,
	userId: string,
	organizationId?: string,
): Promise<PruneContextOutput> {
	const { messages } = context;
	const originalTokens = estimateTokens(context);

	if (messages.length <= preserveLastN) {
		return {
			context,
			summary: "",
			originalTokens,
			prunedTokens: originalTokens,
			messagesRemoved: 0,
			wasPruned: false,
		};
	}

	// Split messages
	const messagesToSummarize = messages.slice(0, -preserveLastN);
	const messagesToKeep = messages.slice(-preserveLastN);

	// Generate summary of older messages
	const summary = await generateSummary(
		messagesToSummarize,
		userId,
		organizationId,
	);

	// Create new context with summary as first message
	const prunedMessages: Message[] = [
		{
			role: "system",
			content: `## Previous Conversation Summary\n\n${summary}`,
			timestamp: new Date().toISOString(),
		},
		...messagesToKeep,
	];

	const prunedContext: ConversationContext = {
		...context,
		messages: prunedMessages,
	};

	return {
		context: prunedContext,
		summary,
		originalTokens,
		prunedTokens: estimateTokens(prunedContext),
		messagesRemoved: messagesToSummarize.length,
		wasPruned: true,
	};
}

/**
 * Token Budget: Remove oldest messages until within budget, then summarize
 */
async function pruneTokenBudget(
	context: ConversationContext,
	maxTokens: number,
	preserveLastN: number,
	userId: string,
	organizationId?: string,
): Promise<PruneContextOutput> {
	const { messages } = context;
	const originalTokens = estimateTokens(context);

	// Calculate how many tokens we need to remove
	const tokensToRemove = originalTokens - maxTokens;
	if (tokensToRemove <= 0) {
		return {
			context,
			summary: "",
			originalTokens,
			prunedTokens: originalTokens,
			messagesRemoved: 0,
			wasPruned: false,
		};
	}

	// Find how many messages to summarize
	let tokensCounted = 0;
	let messagesToSummarizeCount = 0;
	const maxSummarizable = Math.max(0, messages.length - preserveLastN);

	for (let i = 0; i < maxSummarizable; i++) {
		const msgTokens = estimateMessageTokens(messages[i]);
		tokensCounted += msgTokens;
		messagesToSummarizeCount++;

		// Leave room for the summary (estimate 500 tokens)
		if (tokensCounted >= tokensToRemove + 500) {
			break;
		}
	}

	if (messagesToSummarizeCount === 0) {
		return {
			context,
			summary: "",
			originalTokens,
			prunedTokens: originalTokens,
			messagesRemoved: 0,
			wasPruned: false,
		};
	}

	// Split and summarize
	const messagesToSummarize = messages.slice(0, messagesToSummarizeCount);
	const messagesToKeep = messages.slice(messagesToSummarizeCount);

	const summary = await generateSummary(
		messagesToSummarize,
		userId,
		organizationId,
	);

	const prunedMessages: Message[] = [
		{
			role: "system",
			content: `## Previous Conversation Summary\n\n${summary}`,
			timestamp: new Date().toISOString(),
		},
		...messagesToKeep,
	];

	const prunedContext: ConversationContext = {
		...context,
		messages: prunedMessages,
	};

	return {
		context: prunedContext,
		summary,
		originalTokens,
		prunedTokens: estimateTokens(prunedContext),
		messagesRemoved: messagesToSummarize.length,
		wasPruned: true,
	};
}

/**
 * Importance-based: Use LLM to identify important messages to keep
 */
async function pruneImportanceBased(
	context: ConversationContext,
	maxTokens: number,
	preserveLastN: number,
	userId: string,
	organizationId?: string,
): Promise<PruneContextOutput> {
	// For now, fall back to token budget strategy
	// TODO: Implement LLM-based importance scoring
	return await pruneTokenBudget(
		context,
		maxTokens,
		preserveLastN,
		userId,
		organizationId,
	);
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Estimate token count for entire context
 */
function estimateTokens(context: ConversationContext): number {
	let total = 0;

	// System prompt
	if (context.systemPrompt) {
		total += context.systemPrompt.length * TOKENS_PER_CHAR;
	}

	// Knowledge context
	if (context.knowledgeContext) {
		total += context.knowledgeContext.length * TOKENS_PER_CHAR;
	}

	// Messages
	for (const msg of context.messages) {
		total += estimateMessageTokens(msg);
	}

	return Math.ceil(total);
}

/**
 * Estimate token count for a single message
 */
function estimateMessageTokens(message: Message): number {
	let tokens = message.content.length * TOKENS_PER_CHAR;

	// Add overhead for role and formatting
	tokens += 10;

	if (message.name) {
		tokens += message.name.length * TOKENS_PER_CHAR;
	}

	return Math.ceil(tokens);
}

/**
 * Generate a summary of messages using LLM
 */
async function generateSummary(
	messages: Message[],
	userId: string,
	organizationId?: string,
): Promise<string> {
	// Format messages for summarization
	const conversationText = messages
		.map((msg) => {
			const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
			const name = msg.name ? ` (${msg.name})` : "";
			return `**${role}${name}**: ${msg.content}`;
		})
		.join("\n\n");

	try {
		const { model } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{ userId, organizationId },
		);

		const result = await generateText({
			model,
			system: "You are a helpful assistant that creates concise conversation summaries.",
			prompt: `${SUMMARY_PROMPT}\n\n${conversationText}`,
			maxOutputTokens: 1000,
			temperature: 0.3,
		});

		return result.text;
	} catch (error) {
		// Fallback to simple truncation if LLM fails
		console.error("Failed to generate summary:", error);
		return `Previous conversation contained ${messages.length} messages discussing the task at hand.`;
	}
}

/**
 * Quick check if context needs pruning
 */
export function needsPruning(
	context: ConversationContext,
	maxTokens = DEFAULT_MAX_TOKENS,
): boolean {
	return estimateTokens(context) > maxTokens;
}

/**
 * Get estimated token count for context
 */
export function getContextTokenCount(context: ConversationContext): number {
	return estimateTokens(context);
}
