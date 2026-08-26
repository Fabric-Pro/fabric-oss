/**
 * Episodic Memory Activities
 *
 * Implements conversation-level memory for agents (COALA Episodic Memory).
 * Automatically summarizes conversations and stores them for future reference.
 *
 * Flow:
 * 1. When a conversation ends/pauses → summarizeConversationActivity
 * 2. Summary stored in agent memory as conversations/{date}-{hash}.json
 * 3. When new conversation starts → loadRelevantEpisodesActivity
 * 4. Relevant past summaries injected into context
 */

import { createHash } from "node:crypto";
import { logger } from "@repo/logs";

// ============================================================================
// TYPES
// ============================================================================

export interface ConversationMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: string;
	toolCalls?: Array<{
		id: string;
		name: string;
		args: Record<string, unknown>;
		result?: string;
		status?: "pending" | "running" | "success" | "error";
	}>;
}

export interface EpisodeSummary {
	id: string;
	conversationId: string;
	agentInstanceId: string;
	title: string;
	summary: string;
	keyTopics: string[];
	userIntents: string[];
	agentActions: string[];
	toolsUsed: string[];
	outcome: "completed" | "abandoned" | "ongoing";
	messageCount: number;
	turnCount: number;
	startedAt: string;
	endedAt: string;
	createdAt: string;
}

export interface SummarizeConversationInput {
	conversationId: string;
	agentInstanceId: string;
	messages: ConversationMessage[];
	userId: string;
	organizationId?: string;
}

export interface SummarizeConversationOutput {
	summary: EpisodeSummary;
	filePath: string;
	saved: boolean;
}

export interface LoadRelevantEpisodesInput {
	agentInstanceId: string;
	currentQuery: string;
	userId: string;
	organizationId?: string;
	maxEpisodes?: number;
}

export interface LoadRelevantEpisodesOutput {
	episodes: EpisodeSummary[];
	contextPrompt: string;
}

export interface ConversationAnalysis {
	title: string;
	summary: string;
	keyTopics: string[];
	userIntents: string[];
	agentActions: string[];
	outcome: "completed" | "abandoned" | "ongoing";
}

// ============================================================================
// CONVERSATION ANALYSIS
// ============================================================================

/**
 * Analyze conversation to extract key information.
 * Uses heuristics for now - can be enhanced with LLM summarization.
 */
export function analyzeConversation(
	messages: ConversationMessage[],
): ConversationAnalysis {
	const userMessages = messages.filter((m) => m.role === "user");
	const assistantMessages = messages.filter((m) => m.role === "assistant");

	// Extract title from first user message (truncated)
	const firstUserMessage =
		userMessages[0]?.content || "Untitled conversation";
	const title =
		firstUserMessage.length > 100
			? `${firstUserMessage.slice(0, 97)}...`
			: firstUserMessage;

	// Extract key topics (simple keyword extraction)
	const allContent = messages.map((m) => m.content).join(" ");
	const keyTopics = extractKeyTopics(allContent);

	// Extract user intents from user messages
	const userIntents = userMessages
		.map((m) => extractIntent(m.content))
		.filter((intent): intent is string => intent !== null)
		.slice(0, 5);

	// Extract agent actions from assistant messages
	const agentActions: string[] = [];
	for (const msg of assistantMessages) {
		if (msg.toolCalls && msg.toolCalls.length > 0) {
			for (const tc of msg.toolCalls) {
				agentActions.push(`Used ${tc.name}`);
			}
		}
	}

	// Determine outcome
	const lastMessage = messages[messages.length - 1];
	let outcome: "completed" | "abandoned" | "ongoing" = "ongoing";
	if (lastMessage?.role === "assistant") {
		const content = lastMessage.content.toLowerCase();
		if (
			content.includes("complete") ||
			content.includes("done") ||
			content.includes("finished") ||
			content.includes("let me know if")
		) {
			outcome = "completed";
		}
	}

	// Generate summary
	const summary = generateSummary(
		userMessages,
		assistantMessages,
		agentActions,
		outcome,
	);

	return {
		title,
		summary,
		keyTopics,
		userIntents,
		agentActions: [...new Set(agentActions)].slice(0, 10),
		outcome,
	};
}

/**
 * Extract key topics from text using simple heuristics.
 */
function extractKeyTopics(text: string): string[] {
	const topics: string[] = [];

	// Common domain keywords to look for
	const domainPatterns: Record<string, RegExp> = {
		coding: /\b(code|programming|function|api|debug|error|bug|feature)\b/gi,
		data: /\b(data|database|query|sql|analytics|report|chart)\b/gi,
		writing: /\b(write|document|email|blog|article|content)\b/gi,
		research: /\b(research|find|search|look up|information|learn)\b/gi,
		planning: /\b(plan|schedule|meeting|task|project|deadline)\b/gi,
	};

	for (const [topic, pattern] of Object.entries(domainPatterns)) {
		if (pattern.test(text)) {
			topics.push(topic);
		}
	}

	return topics.slice(0, 5);
}

/**
 * Extract user intent from a message.
 */
function extractIntent(message: string): string | null {
	const lowerMessage = message.toLowerCase();

	// Intent patterns
	const intents: Array<{ pattern: RegExp; intent: string }> = [
		{
			pattern: /^(can you|could you|please|help me)/i,
			intent: "request help",
		},
		{ pattern: /^(what|how|why|when|where|who)/i, intent: "ask question" },
		{
			pattern: /^(create|make|build|generate)/i,
			intent: "create something",
		},
		{ pattern: /^(find|search|look for)/i, intent: "search" },
		{ pattern: /^(explain|describe|tell me about)/i, intent: "understand" },
		{ pattern: /^(fix|debug|solve|resolve)/i, intent: "fix problem" },
		{ pattern: /^(update|change|modify|edit)/i, intent: "modify" },
		{ pattern: /^(delete|remove|clear)/i, intent: "delete" },
		{ pattern: /^(remember|note|save)/i, intent: "remember" },
	];

	for (const { pattern, intent } of intents) {
		if (pattern.test(lowerMessage)) {
			return intent;
		}
	}

	return null;
}

/**
 * Generate a human-readable summary.
 */
function generateSummary(
	userMessages: ConversationMessage[],
	assistantMessages: ConversationMessage[],
	agentActions: string[],
	outcome: "completed" | "abandoned" | "ongoing",
): string {
	const parts: string[] = [];

	// What the user wanted
	if (userMessages.length > 0) {
		const firstRequest = userMessages[0].content;
		const truncatedRequest =
			firstRequest.length > 200
				? `${firstRequest.slice(0, 197)}...`
				: firstRequest;
		parts.push(`User requested: "${truncatedRequest}"`);
	}

	// What the agent did
	if (agentActions.length > 0) {
		const uniqueActions = [...new Set(agentActions)];
		parts.push(`Agent actions: ${uniqueActions.slice(0, 5).join(", ")}`);
	}

	// Exchange stats
	parts.push(
		`Exchange: ${userMessages.length} user messages, ${assistantMessages.length} assistant responses`,
	);

	// Outcome
	const outcomeText =
		outcome === "completed"
			? "Task completed successfully"
			: outcome === "abandoned"
				? "Conversation abandoned"
				: "Conversation ongoing";
	parts.push(outcomeText);

	return parts.join(". ");
}

// ============================================================================
// MAIN ACTIVITIES
// ============================================================================

/**
 * Summarize a conversation and store it as episodic memory.
 */
export async function summarizeConversationActivity(
	input: SummarizeConversationInput,
): Promise<SummarizeConversationOutput> {
	const {
		conversationId,
		agentInstanceId,
		messages,
		userId,
		organizationId,
	} = input;

	logger.info("[EpisodicMemory] Summarizing conversation", {
		conversationId,
		agentInstanceId,
		messageCount: messages.length,
	});

	// Skip if too few messages
	if (messages.length < 2) {
		logger.debug("[EpisodicMemory] Skipping - too few messages");
		return {
			summary: {} as EpisodeSummary,
			filePath: "",
			saved: false,
		};
	}

	// Analyze the conversation
	const analysis = analyzeConversation(messages);

	// Calculate turns (user-assistant pairs)
	const userMessages = messages.filter((m) => m.role === "user");
	const turnCount = userMessages.length;

	// Get timestamps
	const startedAt = messages[0]?.timestamp || new Date().toISOString();
	const endedAt =
		messages[messages.length - 1]?.timestamp || new Date().toISOString();

	// Extract tools used
	const toolsUsed: string[] = [];
	for (const msg of messages) {
		if (msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				toolsUsed.push(tc.name);
			}
		}
	}

	// Generate unique ID
	const contentHash = createHash("sha256")
		.update(conversationId + startedAt)
		.digest("hex")
		.slice(0, 8);
	const summaryId = `episode-${contentHash}`;

	// Build summary object
	const summary: EpisodeSummary = {
		id: summaryId,
		conversationId,
		agentInstanceId,
		title: analysis.title,
		summary: analysis.summary,
		keyTopics: analysis.keyTopics,
		userIntents: analysis.userIntents,
		agentActions: analysis.agentActions,
		toolsUsed: [...new Set(toolsUsed)],
		outcome: analysis.outcome,
		messageCount: messages.length,
		turnCount,
		startedAt,
		endedAt,
		createdAt: new Date().toISOString(),
	};

	// Generate file path
	const date = new Date(startedAt).toISOString().split("T")[0];
	const filePath = `conversations/${date}-${contentHash}.json`;

	// Save to agent memory
	try {
		const { writeMemoryFile } = await import("@repo/database");
		await writeMemoryFile(
			{
				agentInstanceId,
				userId,
				organizationId,
			},
			filePath,
			JSON.stringify(summary, null, 2),
			"system",
		);

		logger.info("[EpisodicMemory] Saved conversation summary", {
			conversationId,
			filePath,
			titleLength: analysis.title?.length ?? 0,
		});

		return {
			summary,
			filePath,
			saved: true,
		};
	} catch (error) {
		logger.error("[EpisodicMemory] Failed to save summary", {
			conversationId,
			error: error instanceof Error ? error.message : "Unknown error",
		});

		return {
			summary,
			filePath,
			saved: false,
		};
	}
}

/**
 * Load relevant past episodes for context injection.
 */
export async function loadRelevantEpisodesActivity(
	input: LoadRelevantEpisodesInput,
): Promise<LoadRelevantEpisodesOutput> {
	const {
		agentInstanceId,
		currentQuery,
		userId,
		organizationId,
		maxEpisodes = 5,
	} = input;

	logger.info("[EpisodicMemory] Loading relevant episodes", {
		agentInstanceId,
		queryLength: currentQuery.length,
		maxEpisodes,
	});

	try {
		const { listMemoryFiles, readMemoryFile } = await import(
			"@repo/database"
		);

		// List all conversation files
		const { files } = await listMemoryFiles({
			agentInstanceId,
			userId,
			organizationId,
			path: "conversations/",
			fileType: "CONVERSATION",
			limit: 50,
		});

		if (files.length === 0) {
			return {
				episodes: [],
				contextPrompt: "",
			};
		}

		// Load and parse each episode
		const episodes: EpisodeSummary[] = [];
		for (const file of files) {
			try {
				const fileData = await readMemoryFile(
					{
						agentInstanceId,
						userId,
						organizationId,
					},
					file.path,
				);
				if (fileData) {
					const episode = JSON.parse(
						fileData.content,
					) as EpisodeSummary;
					episodes.push(episode);
				}
			} catch {}
		}

		// Sort by recency (most recent first)
		episodes.sort(
			(a, b) =>
				new Date(b.createdAt).getTime() -
				new Date(a.createdAt).getTime(),
		);

		// Score episodes by relevance to current query
		const scoredEpisodes = episodes.map((episode) => ({
			episode,
			score: calculateRelevanceScore(episode, currentQuery),
		}));

		// Sort by relevance score
		scoredEpisodes.sort((a, b) => b.score - a.score);

		// Take top N
		const relevantEpisodes = scoredEpisodes
			.slice(0, maxEpisodes)
			.filter((e) => e.score > 0.1) // Minimum relevance threshold
			.map((e) => e.episode);

		// Build context prompt
		const contextPrompt = buildEpisodicContextPrompt(relevantEpisodes);

		logger.info("[EpisodicMemory] Loaded relevant episodes", {
			agentInstanceId,
			totalEpisodes: episodes.length,
			relevantEpisodes: relevantEpisodes.length,
		});

		return {
			episodes: relevantEpisodes,
			contextPrompt,
		};
	} catch (error) {
		logger.error("[EpisodicMemory] Failed to load episodes", {
			agentInstanceId,
			error: error instanceof Error ? error.message : "Unknown error",
		});

		return {
			episodes: [],
			contextPrompt: "",
		};
	}
}

/**
 * Calculate relevance score between an episode and current query.
 * Simple keyword matching - can be enhanced with embeddings.
 */
function calculateRelevanceScore(
	episode: EpisodeSummary,
	query: string,
): number {
	const queryLower = query.toLowerCase();
	const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 3);

	let score = 0;
	const maxScore = 5;

	// Check title match
	if (episode.title.toLowerCase().includes(queryLower.slice(0, 50))) {
		score += 2;
	}

	// Check topic overlap
	for (const topic of episode.keyTopics) {
		if (queryLower.includes(topic.toLowerCase())) {
			score += 1;
		}
	}

	// Check intent overlap
	for (const intent of episode.userIntents) {
		if (queryLower.includes(intent.toLowerCase())) {
			score += 0.5;
		}
	}

	// Check word overlap in summary
	const summaryLower = episode.summary.toLowerCase();
	for (const word of queryWords) {
		if (summaryLower.includes(word)) {
			score += 0.2;
		}
	}

	// Recency bonus (more recent = higher score)
	const daysSinceEpisode =
		(Date.now() - new Date(episode.createdAt).getTime()) /
		(1000 * 60 * 60 * 24);
	if (daysSinceEpisode < 1) {
		score += 0.5;
	} else if (daysSinceEpisode < 7) {
		score += 0.2;
	}

	return Math.min(score / maxScore, 1);
}

/**
 * Build a context prompt from relevant episodes.
 */
function buildEpisodicContextPrompt(episodes: EpisodeSummary[]): string {
	if (episodes.length === 0) {
		return "";
	}

	const lines: string[] = [
		"## Relevant Past Conversations",
		"",
		"The user has had the following relevant conversations with you before:",
		"",
	];

	for (const episode of episodes) {
		const date = new Date(episode.startedAt).toLocaleDateString();
		lines.push(`### ${date}: ${episode.title}`);
		lines.push(`- Summary: ${episode.summary}`);
		if (episode.keyTopics.length > 0) {
			lines.push(`- Topics: ${episode.keyTopics.join(", ")}`);
		}
		if (episode.toolsUsed.length > 0) {
			lines.push(`- Tools used: ${episode.toolsUsed.join(", ")}`);
		}
		lines.push(`- Outcome: ${episode.outcome}`);
		lines.push("");
	}

	lines.push(
		"Use this context to provide more personalized and consistent responses.",
	);

	return lines.join("\n");
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if a conversation should be summarized.
 * Called periodically during long conversations.
 */
export function shouldSummarizeConversation(
	messages: ConversationMessage[],
	lastSummarizedAt?: Date,
): boolean {
	// Minimum messages before summarizing
	if (messages.length < 6) {
		return false;
	}

	// Summarize every 20 messages
	const messageThreshold = 20;
	if (messages.length % messageThreshold === 0) {
		return true;
	}

	// Summarize if last summary was more than 1 hour ago
	if (lastSummarizedAt) {
		const hoursSinceLastSummary =
			(Date.now() - lastSummarizedAt.getTime()) / (1000 * 60 * 60);
		if (hoursSinceLastSummary > 1 && messages.length >= 10) {
			return true;
		}
	}

	return false;
}

/**
 * Generate a conversation title from messages.
 */
export function generateConversationTitle(
	messages: ConversationMessage[],
): string {
	const firstUserMessage = messages.find((m) => m.role === "user");
	if (!firstUserMessage) {
		return "Untitled Conversation";
	}

	const content = firstUserMessage.content;
	if (content.length <= 50) {
		return content;
	}

	// Truncate at word boundary
	const truncated = content.slice(0, 50);
	const lastSpace = truncated.lastIndexOf(" ");
	if (lastSpace > 30) {
		return `${truncated.slice(0, lastSpace)}...`;
	}

	return `${truncated}...`;
}
