/**
 * Semantic Intent Matcher
 *
 * Replaces hardcoded pattern matching with embedding-based semantic similarity.
 * This enables dynamic capability discovery without code changes.
 *
 * Part of Improvement 4: Remove Hardcoded Patterns
 */

import { embed } from "@repo/ai";
import { db } from "@repo/database";
import { logger } from "@repo/logs";

/**
 * Capability descriptor for semantic matching.
 */
export interface CapabilityDescriptor {
	id: string;
	type: "agent" | "mcp_tool" | "workflow";
	name: string;
	displayName: string;
	description: string;
	skills: string[];
	triggerPhrases: string[];
	limitations?: string[];
	riskLevel: "low" | "medium" | "high" | "critical";
	requiresApproval: boolean;
	embedding?: number[];
}

/**
 * Result of semantic intent matching.
 */
export interface SemanticIntentResult {
	bestMatch: CapabilityMatch | null;
	alternatives: CapabilityMatch[];
	confidence: number;
	reasoning: string;
	detectedIntents: DetectedIntent[];
	userPreferences: UserPreference[];
}

export interface CapabilityMatch {
	capability: CapabilityDescriptor;
	score: number;
	matchReason: string;
	matchedSkills: string[];
	matchedPhrases: string[];
}

export interface DetectedIntent {
	intent: string;
	confidence: number;
	source: "explicit" | "inferred" | "semantic";
}

export interface UserPreference {
	key: string;
	value: string;
	source: "message" | "history" | "profile";
}

/**
 * Cache for capability embeddings.
 */
const embeddingCache = new Map<string, number[]>();

/**
 * Generates embedding for text using the AI service.
 */
async function generateEmbedding(
	text: string,
	_apiKey?: string,
): Promise<number[]> {
	const cacheKey = text.slice(0, 100);
	const cached = embeddingCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	try {
		const result = await embed({
			model: "openai:text-embedding-3-small",
			value: text,
		});

		if (result.embedding) {
			embeddingCache.set(cacheKey, result.embedding);
			return result.embedding;
		}
	} catch (error) {
		logger.warn("[SemanticMatcher] Embedding generation failed", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}

	return [];
}

/**
 * Computes cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length === 0 || b.length === 0 || a.length !== b.length) {
		return 0;
	}

	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
	return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Loads capability descriptors from registered agents and MCP tools.
 */
export async function loadCapabilities(
	userId: string,
	organizationId?: string,
	enabledAgentIds?: string[],
	_enabledMcpConfigIds?: string[],
): Promise<CapabilityDescriptor[]> {
	const capabilities: CapabilityDescriptor[] = [];

	// Load agents
	try {
		const agents = await db.registeredAgent.findMany({
			where: {
				status: "ACTIVE",
				OR: [
					{ scope: "SYSTEM" },
					{ scope: "USER", userId },
					...(organizationId
						? [{ scope: "ORGANIZATION", organizationId }]
						: []),
				],
			},
		});

		for (const agent of agents) {
			if (enabledAgentIds && !enabledAgentIds.includes(agent.agentId)) {
				continue;
			}

			const metadata = agent.metadata as Record<string, unknown> | null;
			const skills = (metadata?.skills as Array<{ name: string }>) || [];
			const triggerPhrases = (metadata?.triggerPhrases as string[]) || [];
			const limitations = (metadata?.limitations as string[]) || [];

			capabilities.push({
				id: agent.agentId,
				type: "agent",
				name: agent.agentId,
				displayName: agent.displayName,
				description: agent.description || "",
				skills: skills.map((s) => s.name),
				triggerPhrases,
				limitations,
				riskLevel:
					(metadata?.riskLevel as CapabilityDescriptor["riskLevel"]) ||
					"medium",
				requiresApproval:
					(metadata?.requiresApproval as boolean) || false,
			});
		}
	} catch (error) {
		logger.warn("[SemanticMatcher] Failed to load agents", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}

	// Load MCP tool capabilities from search results (already computed)
	// MCP tools are loaded dynamically during routing via searchAvailableTools

	return capabilities;
}

/**
 * Detects user intent using semantic matching.
 * This replaces the hardcoded pattern matching in detectUserIntent().
 */
export async function detectUserIntentSemantic(
	message: string,
	capabilities: CapabilityDescriptor[],
	apiKey?: string,
): Promise<SemanticIntentResult> {
	logger.info("[SemanticMatcher] Detecting intent semantically", {
		messageLength: message.length,
		capabilityCount: capabilities.length,
	});

	const detectedIntents: DetectedIntent[] = [];
	const userPreferences: UserPreference[] = [];
	const matches: CapabilityMatch[] = [];

	// Generate embedding for user message
	const messageEmbedding = await generateEmbedding(message, apiKey);

	// Score each capability
	for (const capability of capabilities) {
		const match = await scoreCapabilityMatch(
			message,
			messageEmbedding,
			capability,
			apiKey,
		);
		if (match.score > 0.2) {
			matches.push(match);
		}
	}

	// Sort by score
	matches.sort((a, b) => b.score - a.score);

	// Extract intents from matches
	if (matches.length > 0) {
		for (const match of matches.slice(0, 3)) {
			detectedIntents.push({
				intent:
					match.capability.type === "agent"
						? match.capability.id
						: `use_${match.capability.name}`,
				confidence: match.score,
				source: "semantic",
			});
		}
	}

	// Detect explicit intent indicators
	const explicitIntents = detectExplicitIntents(message);
	detectedIntents.push(...explicitIntents);

	// Extract user preferences from message
	const preferences = extractPreferences(message);
	userPreferences.push(...preferences);

	const bestMatch = matches[0] || null;
	const alternatives = matches.slice(1, 4);

	const reasoning = bestMatch
		? `Matched "${bestMatch.capability.displayName}" with ${Math.round(bestMatch.score * 100)}% confidence. ${bestMatch.matchReason}`
		: "No strong capability match found. Will use default routing.";

	logger.info("[SemanticMatcher] Intent detection complete", {
		bestMatch: bestMatch?.capability.id,
		confidence: bestMatch?.score || 0,
		alternativeCount: alternatives.length,
		intentCount: detectedIntents.length,
	});

	return {
		bestMatch,
		alternatives,
		confidence: bestMatch?.score || 0,
		reasoning,
		detectedIntents,
		userPreferences,
	};
}

/**
 * Scores how well a capability matches the user message.
 */
async function scoreCapabilityMatch(
	message: string,
	messageEmbedding: number[],
	capability: CapabilityDescriptor,
	apiKey?: string,
): Promise<CapabilityMatch> {
	let score = 0;
	const matchedSkills: string[] = [];
	const matchedPhrases: string[] = [];
	const reasons: string[] = [];

	const messageLower = message.toLowerCase();

	// 1. Semantic similarity (40% weight)
	if (messageEmbedding.length > 0) {
		const capabilityText = `${capability.displayName}: ${capability.description}. Skills: ${capability.skills.join(", ")}`;
		const capabilityEmbedding =
			capability.embedding ||
			(await generateEmbedding(capabilityText, apiKey));

		if (capabilityEmbedding.length > 0) {
			const semanticScore = cosineSimilarity(
				messageEmbedding,
				capabilityEmbedding,
			);
			score += semanticScore * 0.4;
			if (semanticScore > 0.5) {
				reasons.push(
					`High semantic similarity (${Math.round(semanticScore * 100)}%)`,
				);
			}
		}
	}

	// 2. Trigger phrase matching (30% weight)
	for (const phrase of capability.triggerPhrases) {
		if (messageLower.includes(phrase.toLowerCase())) {
			matchedPhrases.push(phrase);
			score += 0.3 / Math.max(capability.triggerPhrases.length, 1);
		}
	}
	if (matchedPhrases.length > 0) {
		reasons.push(`Matched phrases: ${matchedPhrases.join(", ")}`);
	}

	// 3. Skill matching (20% weight)
	for (const skill of capability.skills) {
		const skillWords = skill.toLowerCase().split(/\s+/);
		if (skillWords.some((word) => messageLower.includes(word))) {
			matchedSkills.push(skill);
			score += 0.2 / Math.max(capability.skills.length, 1);
		}
	}
	if (matchedSkills.length > 0) {
		reasons.push(`Matched skills: ${matchedSkills.join(", ")}`);
	}

	// 4. Name/ID matching (10% weight)
	const nameWords = capability.displayName.toLowerCase().split(/\s+/);
	if (
		nameWords.some((word) => word.length > 3 && messageLower.includes(word))
	) {
		score += 0.1;
		reasons.push("Name match");
	}

	// Cap at 1.0
	score = Math.min(score, 1.0);

	return {
		capability,
		score,
		matchReason: reasons.join(". ") || "Low confidence match",
		matchedSkills,
		matchedPhrases,
	};
}

/**
 * Detects explicit intent indicators in the message.
 * These are clear signals that don't require semantic matching.
 */
function detectExplicitIntents(message: string): DetectedIntent[] {
	const intents: DetectedIntent[] = [];
	const messageLower = message.toLowerCase();

	// Workspace/RAG intent
	if (
		messageLower.includes("my documents") ||
		messageLower.includes("my files") ||
		messageLower.includes("workspace") ||
		messageLower.includes("attached")
	) {
		intents.push({
			intent: "workspace_query",
			confidence: 0.9,
			source: "explicit",
		});
	}

	// Workflow intent
	if (
		messageLower.includes("run workflow") ||
		messageLower.includes("execute workflow") ||
		messageLower.includes("trigger workflow")
	) {
		intents.push({
			intent: "workflow_execution",
			confidence: 0.95,
			source: "explicit",
		});
	}

	// Browser/code execution intent
	if (
		messageLower.includes("run code") ||
		messageLower.includes("execute code") ||
		messageLower.includes("browser") ||
		messageLower.includes("automate")
	) {
		intents.push({
			intent: "code_execution",
			confidence: 0.85,
			source: "explicit",
		});
	}

	// External service intent
	const servicePatterns = [
		{ pattern: "jira", service: "jira" },
		{ pattern: "github", service: "github" },
		{ pattern: "slack", service: "slack" },
		{ pattern: "linear", service: "linear" },
		{ pattern: "trello", service: "trello" },
		{ pattern: "notion", service: "notion" },
	];

	for (const { pattern, service } of servicePatterns) {
		if (messageLower.includes(pattern)) {
			intents.push({
				intent: `use_${service}`,
				confidence: 0.9,
				source: "explicit",
			});
		}
	}

	return intents;
}

/**
 * Extracts user preferences from the message.
 */
function extractPreferences(message: string): UserPreference[] {
	const preferences: UserPreference[] = [];
	const messageLower = message.toLowerCase();

	// Format preferences
	if (messageLower.includes("markdown")) {
		preferences.push({
			key: "format",
			value: "markdown",
			source: "message",
		});
	} else if (messageLower.includes("json")) {
		preferences.push({ key: "format", value: "json", source: "message" });
	}

	// Verbosity preferences
	if (
		messageLower.includes("brief") ||
		messageLower.includes("short") ||
		messageLower.includes("concise")
	) {
		preferences.push({
			key: "verbosity",
			value: "brief",
			source: "message",
		});
	} else if (
		messageLower.includes("detailed") ||
		messageLower.includes("comprehensive")
	) {
		preferences.push({
			key: "verbosity",
			value: "detailed",
			source: "message",
		});
	}

	// Speed preferences
	if (messageLower.includes("quick") || messageLower.includes("fast")) {
		preferences.push({ key: "speed", value: "fast", source: "message" });
	} else if (
		messageLower.includes("thorough") ||
		messageLower.includes("careful")
	) {
		preferences.push({
			key: "speed",
			value: "thorough",
			source: "message",
		});
	}

	return preferences;
}

/**
 * Converts semantic intent result to routing hints.
 */
export function intentToRoutingHints(result: SemanticIntentResult): {
	suggestedAgent?: string;
	useMcpDirect?: boolean;
	requestedWorkspace?: boolean;
	requestedWorkflow?: boolean;
	mentionedCapabilities: string[];
} {
	const hints: ReturnType<typeof intentToRoutingHints> = {
		mentionedCapabilities: [],
	};

	// Check detected intents
	for (const intent of result.detectedIntents) {
		if (intent.confidence > 0.7) {
			if (intent.intent === "workspace_query") {
				hints.requestedWorkspace = true;
			} else if (intent.intent === "workflow_execution") {
				hints.requestedWorkflow = true;
			} else if (intent.intent.startsWith("use_")) {
				hints.useMcpDirect = true;
				hints.mentionedCapabilities.push(
					intent.intent.replace("use_", ""),
				);
			}
		}
	}

	// Set suggested agent from best match
	if (result.bestMatch && result.bestMatch.score > 0.5) {
		if (result.bestMatch.capability.type === "agent") {
			hints.suggestedAgent = result.bestMatch.capability.id;
		} else if (result.bestMatch.capability.type === "mcp_tool") {
			hints.useMcpDirect = true;
		}
		hints.mentionedCapabilities.push(result.bestMatch.capability.name);
	}

	return hints;
}

/**
 * Pre-computes embeddings for capabilities.
 * Should be called during system initialization or agent registration.
 */
export async function precomputeCapabilityEmbeddings(
	capabilities: CapabilityDescriptor[],
	apiKey?: string,
): Promise<CapabilityDescriptor[]> {
	logger.info("[SemanticMatcher] Pre-computing capability embeddings", {
		count: capabilities.length,
	});

	for (const capability of capabilities) {
		if (!capability.embedding) {
			const text = `${capability.displayName}: ${capability.description}. Skills: ${capability.skills.join(", ")}`;
			capability.embedding = await generateEmbedding(text, apiKey);
		}
	}

	return capabilities;
}

/**
 * Clears the embedding cache.
 */
export function clearEmbeddingCache(): void {
	embeddingCache.clear();
}
