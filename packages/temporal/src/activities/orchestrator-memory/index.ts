/**
 * Orchestrator Memory Activities
 *
 * Temporal activities for loading and managing Orchestrator memory:
 * - Load user preferences (hot memory)
 * - Search episodic memory (cold memory via Qdrant)
 * - Create episodic memory from completed conversations
 * - Update preferences based on learned patterns
 */

import { embed, getAIEmbeddingModel } from "@repo/ai";
import {
	buildOrchestratorMemoryContext,
	createEpisodicMemory,
	type EpisodeSummary,
	formatMemoryContextPrompt,
	getOrchestratorMemoryPreferences,
	getRecentEpisodes,
	learnPattern,
	type OrchestratorMemoryPreferencesData,
	updateOrchestratorMemoryPreferences,
	updateRecentActivity,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	type EpisodeSearchResult,
	searchSimilarEpisodes,
	storeEpisodeEmbedding,
} from "@repo/rag/lib/vector-store";

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Safely convert a Date or string to ISO string.
 * Temporal serializes Date objects to strings when passing between workflow and activities,
 * so we need to handle both cases.
 */
function toISOString(value: Date | string | null | undefined): string {
	if (!value) {
		return new Date().toISOString();
	}
	if (typeof value === "string") {
		return value;
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	// Fallback for any other case
	return new Date().toISOString();
}

// =============================================================================
// TYPES
// =============================================================================

export interface LoadOrchestratorMemoryInput {
	userId: string;
	organizationId?: string | null;
	projectId?: string | null;
	workspaceId?: string | null;
	currentQuery?: string;
}

export interface LoadOrchestratorMemoryOutput {
	preferences: OrchestratorMemoryPreferencesData;
	memoryContextPrompt: string;
	relevantEpisodes: EpisodeSummary[];
	recentEpisodes: EpisodeSummary[];
}

export interface SearchEpisodicMemoryInput {
	userId: string;
	organizationId?: string | null;
	projectId?: string | null;
	workspaceId?: string | null;
	query: string;
	topK?: number;
	minSimilarity?: number;
	excludeConversationIds?: string[];
}

export interface CreateEpisodeInput {
	userId: string;
	organizationId?: string | null;
	projectId?: string | null;
	workspaceId?: string | null;
	conversationId: string;
	agentId?: string | null;
	title: string;
	summary: string;
	keyTopics: string[];
	userIntents: string[];
	outcome: string;
	messageCount: number;
	turnCount: number;
	toolsUsed: string[];
	agentsUsed: string[];
	conversationStartedAt: Date;
	conversationEndedAt?: Date | null;
}

export interface UpdatePreferencesInput {
	userId: string;
	organizationId?: string | null;
	updates: Partial<OrchestratorMemoryPreferencesData>;
}

export interface LearnPatternInput {
	userId: string;
	organizationId?: string | null;
	pattern: string;
}

export interface UpdateRecentActivityInput {
	userId: string;
	organizationId?: string | null;
	projectId?: string;
	workspaceId?: string;
}

// =============================================================================
// ACTIVITIES
// =============================================================================

/**
 * Load orchestrator memory context
 * Combines hot preferences + recent episodes + semantically relevant episodes
 */
export async function loadOrchestratorMemoryActivity(
	input: LoadOrchestratorMemoryInput,
): Promise<LoadOrchestratorMemoryOutput> {
	const { userId, organizationId, projectId, workspaceId, currentQuery } =
		input;

	logger.info("[OrchestratorMemory] Loading memory context", {
		userId,
		organizationId,
		projectId,
		workspaceId,
		hasQuery: !!currentQuery,
	});

	try {
		// Step 1: Get hot preferences (always fast)
		const preferences = await getOrchestratorMemoryPreferences(
			userId,
			organizationId,
		);

		// Step 2: Get recent episodes
		const recentEpisodes = await getRecentEpisodes(
			userId,
			organizationId,
			5,
		);

		// Step 3: Search for semantically relevant episodes (if we have a query)
		const _relevantEpisodes: EpisodeSummary[] = [];
		let relevantEpisodeIds: string[] = [];

		if (currentQuery && currentQuery.trim().length > 10) {
			const searchResults = await searchEpisodicMemoryActivity({
				userId,
				organizationId,
				projectId,
				workspaceId,
				query: currentQuery,
				topK: 5,
				minSimilarity: 0.6,
			});

			relevantEpisodeIds = searchResults.map((r) => r.id);
		}

		// Step 4: Build full memory context
		const memoryContext = await buildOrchestratorMemoryContext({
			userId,
			organizationId,
			projectId,
			workspaceId,
			currentQuery,
			relevantEpisodeIds,
		});

		// Step 5: Format as system prompt addition
		const memoryContextPrompt = formatMemoryContextPrompt(memoryContext);

		logger.info("[OrchestratorMemory] Memory context loaded", {
			hasPreferences:
				!!preferences.responseStyle ||
				Object.keys(preferences.preferences).length > 0,
			recentEpisodeCount: recentEpisodes.length,
			relevantEpisodeCount: memoryContext.relevantEpisodes.length,
			promptLength: memoryContextPrompt.length,
		});

		return {
			preferences,
			memoryContextPrompt,
			relevantEpisodes: memoryContext.relevantEpisodes,
			recentEpisodes,
		};
	} catch (error) {
		logger.error("[OrchestratorMemory] Failed to load memory context", {
			error: error instanceof Error ? error.message : "Unknown error",
		});

		// Return empty context on failure (graceful degradation)
		return {
			preferences: {
				preferences: {},
				recentProjectIds: [],
				recentWorkspaceIds: [],
			},
			memoryContextPrompt: "",
			relevantEpisodes: [],
			recentEpisodes: [],
		};
	}
}

/**
 * Search episodic memory using semantic similarity
 */
export async function searchEpisodicMemoryActivity(
	input: SearchEpisodicMemoryInput,
): Promise<EpisodeSearchResult[]> {
	const {
		userId,
		organizationId,
		projectId,
		workspaceId,
		query,
		topK = 5,
		minSimilarity = 0.5,
		excludeConversationIds = [],
	} = input;

	logger.info("[OrchestratorMemory] Searching episodic memory", {
		userId,
		organizationId,
		queryLength: query.length,
		topK,
	});

	try {
		// Generate embedding for the query
		const embeddingModel = await getAIEmbeddingModel({
			userId,
			organizationId: organizationId ?? undefined,
		});
		const result = await embed({ model: embeddingModel, value: query });
		const queryEmbedding = result.embedding;

		if (!queryEmbedding || queryEmbedding.length === 0) {
			logger.warn(
				"[OrchestratorMemory] Failed to generate query embedding",
			);
			return [];
		}

		// Search Qdrant
		const results = await searchSimilarEpisodes({
			queryEmbedding,
			userId,
			organizationId,
			projectId,
			workspaceId,
			topK,
			minSimilarity,
			excludeConversationIds,
		});

		logger.info("[OrchestratorMemory] Episodic search completed", {
			resultCount: results.length,
			topScore: results[0]?.similarity,
		});

		return results;
	} catch (error) {
		logger.error("[OrchestratorMemory] Episodic search failed", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
		return [];
	}
}

/**
 * Create episodic memory from a completed conversation
 */
export async function createEpisodicMemoryActivity(
	input: CreateEpisodeInput,
): Promise<{ episodeId: string | null; qdrantPointId: string | null }> {
	logger.info("[OrchestratorMemory] Creating episodic memory", {
		conversationId: input.conversationId,
		titleLength: input.title?.length ?? 0,
		messageCount: input.messageCount,
	});

	try {
		// Step 1: Create PostgreSQL record
		const episode = await createEpisodicMemory({
			userId: input.userId,
			organizationId: input.organizationId,
			projectId: input.projectId,
			workspaceId: input.workspaceId,
			conversationId: input.conversationId,
			agentId: input.agentId,
			title: input.title,
			summary: input.summary,
			keyTopics: input.keyTopics,
			userIntents: input.userIntents,
			outcome: input.outcome,
			messageCount: input.messageCount,
			turnCount: input.turnCount,
			toolsUsed: input.toolsUsed,
			agentsUsed: input.agentsUsed,
			conversationStartedAt: input.conversationStartedAt,
			conversationEndedAt: input.conversationEndedAt,
		});

		// Step 2: Generate embedding and store in Qdrant
		const embeddingText = `${input.title}\n\n${input.summary}\n\nTopics: ${input.keyTopics.join(", ")}`;
		const embeddingModel = await getAIEmbeddingModel({
			userId: input.userId,
			organizationId: input.organizationId || undefined,
		});
		const embeddingResult = await embed({
			model: embeddingModel,
			value: embeddingText,
		});
		const episodeEmbedding = embeddingResult.embedding;

		let qdrantPointId: string | null = null;

		if (episodeEmbedding && episodeEmbedding.length > 0) {
			const storeResult = await storeEpisodeEmbedding({
				episode: {
					id: episode.id,
					conversationId: input.conversationId,
					title: input.title,
					summary: input.summary,
					keyTopics: input.keyTopics,
					userIntents: input.userIntents,
					outcome: input.outcome,
					userId: input.userId,
					organizationId: input.organizationId,
					projectId: input.projectId,
					workspaceId: input.workspaceId,
					agentId: input.agentId,
					conversationEndedAt: toISOString(input.conversationEndedAt),
				},
				embedding: episodeEmbedding,
			});

			qdrantPointId = storeResult.pointId;
		}

		logger.info("[OrchestratorMemory] Episodic memory created", {
			episodeId: episode.id,
			qdrantPointId,
			hasEmbedding: !!qdrantPointId,
		});

		return {
			episodeId: episode.id,
			qdrantPointId,
		};
	} catch (error) {
		logger.error("[OrchestratorMemory] Failed to create episodic memory", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
		return { episodeId: null, qdrantPointId: null };
	}
}

/**
 * Update user preferences
 */
export async function updateOrchestratorPreferencesActivity(
	input: UpdatePreferencesInput,
): Promise<OrchestratorMemoryPreferencesData> {
	logger.info("[OrchestratorMemory] Updating preferences", {
		userId: input.userId,
		organizationId: input.organizationId,
		updateKeys: Object.keys(input.updates),
	});

	try {
		const updated = await updateOrchestratorMemoryPreferences(
			input.userId,
			input.organizationId,
			input.updates,
		);

		logger.info("[OrchestratorMemory] Preferences updated");
		return updated;
	} catch (error) {
		logger.error("[OrchestratorMemory] Failed to update preferences", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
		throw error;
	}
}

/**
 * Learn a new pattern from conversation
 */
export async function learnPatternActivity(
	input: LearnPatternInput,
): Promise<void> {
	logger.info("[OrchestratorMemory] Learning pattern", {
		userId: input.userId,
		organizationId: input.organizationId,
		patternLength: input.pattern.length,
	});

	try {
		await learnPattern(input.userId, input.organizationId, input.pattern);
		logger.info("[OrchestratorMemory] Pattern learned");
	} catch (error) {
		logger.error("[OrchestratorMemory] Failed to learn pattern", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}
}

/**
 * Update recent activity (projects/workspaces)
 */
export async function updateRecentActivityActivity(
	input: UpdateRecentActivityInput,
): Promise<void> {
	logger.info("[OrchestratorMemory] Updating recent activity", {
		userId: input.userId,
		organizationId: input.organizationId,
		projectId: input.projectId,
		workspaceId: input.workspaceId,
	});

	try {
		await updateRecentActivity(input.userId, input.organizationId, {
			projectId: input.projectId,
			workspaceId: input.workspaceId,
		});
		logger.info("[OrchestratorMemory] Recent activity updated");
	} catch (error) {
		logger.error("[OrchestratorMemory] Failed to update recent activity", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}
}

// =============================================================================
// CONVERSATION SUMMARIZATION FOR EPISODE CREATION
// =============================================================================

export interface SummarizeConversationInput {
	userId: string;
	organizationId?: string | null;
	conversationId: string;
	projectId?: string | null;
	workspaceId?: string | null;
	agentId?: string | null;
	messages: Array<{
		role: "user" | "assistant" | "system";
		content: string;
		timestamp?: string;
	}>;
	toolsUsed?: string[];
	agentsUsed?: string[];
	conversationStartedAt: Date;
	conversationEndedAt?: Date | null;
}

export interface SummarizeConversationOutput {
	title: string;
	summary: string;
	keyTopics: string[];
	userIntents: string[];
	outcome: string;
	shouldCreateEpisode: boolean;
}

/**
 * Analyze a conversation and generate summary for episodic memory
 * Uses LLM to extract key information from the conversation
 */
export async function summarizeConversationActivity(
	input: SummarizeConversationInput,
): Promise<SummarizeConversationOutput> {
	const { generateText, getAIModel } = await import("@repo/ai");

	logger.info("[OrchestratorMemory] Summarizing conversation", {
		conversationId: input.conversationId,
		messageCount: input.messages.length,
	});

	// Filter out system messages and format conversation
	const conversationText = input.messages
		.filter((m) => m.role !== "system")
		.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
		.join("\n\n")
		.slice(0, 8000); // Limit to ~8k chars

	// Skip very short conversations
	if (input.messages.filter((m) => m.role === "user").length < 2) {
		return {
			title: "",
			summary: "",
			keyTopics: [],
			userIntents: [],
			outcome: "incomplete",
			shouldCreateEpisode: false,
		};
	}

	try {
		const model = await getAIModel(
			{ taskType: "SIMPLE" },
			{
				userId: input.userId,
				organizationId: input.organizationId || undefined,
			},
		);

		const prompt = `Analyze this conversation and extract key information for memory storage.

CONVERSATION:
${conversationText}

Respond in JSON format with these fields:
{
  "title": "Brief title summarizing the conversation (max 100 chars)",
  "summary": "2-3 sentence summary of what was discussed and accomplished",
  "keyTopics": ["topic1", "topic2", "topic3"] (max 5 topics),
  "userIntents": ["intent1", "intent2"] (what the user wanted to achieve),
  "outcome": "success" | "partial" | "abandoned" (based on conversation completion)
}

Rules:
- Title should be specific and descriptive
- Topics should be concrete nouns or short phrases
- Intents should be action-oriented
- Mark as "abandoned" if conversation seems incomplete or user gave up`;

		const result = await generateText({
			model,
			prompt,
			maxTokens: 500,
		} as Parameters<typeof generateText>[0]);

		// Parse JSON response
		const jsonMatch = result.text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			logger.warn("[OrchestratorMemory] Failed to parse summary JSON");
			return {
				title: "Untitled Conversation",
				summary: "Conversation summary unavailable",
				keyTopics: [],
				userIntents: [],
				outcome: "partial",
				shouldCreateEpisode: true,
			};
		}

		const parsed = JSON.parse(jsonMatch[0]);

		return {
			title: parsed.title || "Untitled Conversation",
			summary: parsed.summary || "",
			keyTopics: Array.isArray(parsed.keyTopics)
				? parsed.keyTopics.slice(0, 5)
				: [],
			userIntents: Array.isArray(parsed.userIntents)
				? parsed.userIntents.slice(0, 3)
				: [],
			outcome: ["success", "partial", "abandoned"].includes(
				parsed.outcome,
			)
				? parsed.outcome
				: "partial",
			shouldCreateEpisode: true,
		};
	} catch (error) {
		logger.error("[OrchestratorMemory] Conversation summarization failed", {
			error: error instanceof Error ? error.message : "Unknown error",
		});

		// Return basic fallback
		return {
			title: "Conversation",
			summary: `Conversation with ${input.messages.filter((m) => m.role === "user").length} user messages`,
			keyTopics: [],
			userIntents: [],
			outcome: "partial",
			shouldCreateEpisode: true,
		};
	}
}

/**
 * Create episode from a completed orchestrator execution
 * Combines summarization + episode creation in one activity
 */
export async function createEpisodeFromExecutionActivity(input: {
	userId: string;
	organizationId?: string | null;
	projectId?: string | null;
	workspaceId?: string | null;
	conversationId: string;
	executionId: string;
	taskDescription: string;
	steps: Array<{ id: string; description: string; status: string }>;
	toolsUsed: string[];
	agentsUsed: string[];
	outcome: "success" | "partial" | "failure";
	conversationStartedAt: Date;
	conversationEndedAt?: Date | null;
}): Promise<{ episodeId: string | null; created: boolean }> {
	logger.info("[OrchestratorMemory] Creating episode from execution", {
		executionId: input.executionId,
		stepCount: input.steps.length,
		outcome: input.outcome,
	});

	try {
		// Generate summary using the task and steps
		const stepsText = input.steps
			.map((s) => `- ${s.description} (${s.status})`)
			.join("\n");

		const summary = `Task: ${input.taskDescription}\n\nSteps executed:\n${stepsText}`;

		// Extract key topics from task description and steps
		const keyTopics = extractKeyTopics(input.taskDescription, input.steps);

		// Create the episode
		const result = await createEpisodicMemoryActivity({
			userId: input.userId,
			organizationId: input.organizationId,
			projectId: input.projectId,
			workspaceId: input.workspaceId,
			conversationId: input.conversationId,
			agentId: null,
			title: input.taskDescription.slice(0, 200),
			summary: summary.slice(0, 2000),
			keyTopics,
			userIntents: [
				input.taskDescription.split(" ").slice(0, 5).join(" "),
			],
			outcome: input.outcome,
			messageCount: input.steps.length + 1,
			turnCount: input.steps.length,
			toolsUsed: input.toolsUsed,
			agentsUsed: input.agentsUsed,
			conversationStartedAt: input.conversationStartedAt,
			conversationEndedAt: input.conversationEndedAt,
		});

		return {
			episodeId: result.episodeId,
			created: !!result.episodeId,
		};
	} catch (error) {
		logger.error(
			"[OrchestratorMemory] Failed to create episode from execution",
			{
				error: error instanceof Error ? error.message : "Unknown error",
			},
		);
		return { episodeId: null, created: false };
	}
}

/**
 * Extract key topics from task description and steps
 */
function extractKeyTopics(
	taskDescription: string,
	steps: Array<{ description: string }>,
): string[] {
	const topics: Set<string> = new Set();

	// Common topic keywords to look for
	const keywords = [
		"api",
		"database",
		"frontend",
		"backend",
		"design",
		"plan",
		"research",
		"analyze",
		"create",
		"build",
		"document",
		"test",
		"deploy",
		"fix",
		"debug",
		"optimize",
		"review",
		"product",
		"feature",
		"user",
		"workflow",
		"integration",
		"search",
		"data",
		"report",
	];

	const allText =
		`${taskDescription} ${steps.map((s) => s.description).join(" ")}`.toLowerCase();

	for (const keyword of keywords) {
		if (allText.includes(keyword)) {
			topics.add(keyword);
		}
	}

	// Also extract capitalized words as potential topics (proper nouns)
	const capitalizedWords = allText.match(/\b[A-Z][a-z]+\b/g) || [];
	for (const word of capitalizedWords.slice(0, 3)) {
		if (word.length > 3) {
			topics.add(word.toLowerCase());
		}
	}

	return Array.from(topics).slice(0, 5);
}

// =============================================================================
// PATTERN LEARNING
// =============================================================================

/**
 * Extract and learn user preferences/patterns from conversation
 * Analyzes user messages for explicit preferences like:
 * - "I prefer X"
 * - "Always use Y"
 * - "Remember that I like Z"
 */
export async function extractAndLearnPatternsActivity(input: {
	userId: string;
	organizationId?: string | null;
	messages: Array<{ role: string; content: string }>;
}): Promise<{ patternsLearned: string[]; count: number }> {
	logger.info("[OrchestratorMemory] Extracting patterns from conversation", {
		messageCount: input.messages.length,
	});

	const patternsLearned: string[] = [];

	// Get user messages only
	const userMessages = input.messages
		.filter((m) => m.role === "user")
		.map((m) => m.content);

	// Pattern detection rules
	const preferencePatterns = [
		// Explicit preferences
		/(?:i prefer|i like|i want|i need|please use|always use|use)\s+(.+?)(?:\.|$)/gi,
		// Remember requests - "remember that X", "remember to X", "note that X", "keep in mind X"
		/(?:remember (?:that|to)?|note that|keep in mind|don'?t forget(?: to)?)\s+(.+?)(?:\.|$)/gi,
		// Future behavior - "from now on X", "going forward X", "in the future X"
		/(?:from now on|going forward|in the future|make sure to)\s+(.+?)(?:\.|$)/gi,
		// Style preferences
		/(?:make it|keep it|i want it)\s+(concise|detailed|brief|verbose|simple)/gi,
		// Language preferences
		/(?:use|write in|prefer)\s+(typescript|javascript|python|rust|go|java|c\+\+)/gi,
		// Format preferences - includes tabular/table display
		/(?:use|prefer|give me|show in|display in|format as)\s+(bullet points?|numbered lists?|markdown|code blocks?|tabular form|table format|tables?)/gi,
		// Always patterns - "always show X", "always display X", "always format X"
		// Captures full phrase including "always" for complete context
		/(always\s+(?:show|display|format|present|render|use|include)\s+.+?)(?:\.|$)/gi,
	];

	for (const message of userMessages) {
		for (const pattern of preferencePatterns) {
			const matches = message.matchAll(pattern);
			for (const match of matches) {
				// Handle patterns with multiple capture groups (e.g., "always show X")
				// Combine all capture groups to form the complete pattern
				const groups = match.slice(1).filter(Boolean);
				const extracted = groups.join(" ").trim();

				if (
					extracted &&
					extracted.length > 3 &&
					extracted.length < 100
				) {
					// Clean up and normalize
					const normalized = extracted
						.replace(/[.,!?]+$/, "")
						.toLowerCase()
						.trim();

					if (normalized && !patternsLearned.includes(normalized)) {
						patternsLearned.push(normalized);
					}
				}
			}
		}
	}

	// Save learned patterns
	for (const pattern of patternsLearned.slice(0, 5)) {
		// Limit to 5 new patterns per conversation
		try {
			await learnPattern(input.userId, input.organizationId, pattern);
			logger.info("[OrchestratorMemory] Learned pattern", { pattern });
		} catch (error) {
			logger.warn("[OrchestratorMemory] Failed to save pattern", {
				pattern,
				error: error instanceof Error ? error.message : "Unknown",
			});
		}
	}

	return {
		patternsLearned,
		count: patternsLearned.length,
	};
}

/**
 * Manually add a learned pattern
 * Called when user explicitly says "remember this" or similar
 */
export async function addLearnedPatternActivity(input: {
	userId: string;
	organizationId?: string | null;
	pattern: string;
}): Promise<{ success: boolean }> {
	try {
		await learnPattern(input.userId, input.organizationId, input.pattern);
		logger.info("[OrchestratorMemory] Added learned pattern", {
			pattern: input.pattern,
		});
		return { success: true };
	} catch (error) {
		logger.error("[OrchestratorMemory] Failed to add pattern", {
			error: error instanceof Error ? error.message : "Unknown",
		});
		return { success: false };
	}
}
