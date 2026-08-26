/**
 * Capability Keywords
 *
 * Implements BM25-style keyword matching for tool/agent/capability selection.
 * Following Anthropic's Tool Search Tool pattern, this provides deterministic
 * matching based on explicit KEYWORDS in capability descriptions.
 *
 * The KEYWORDS section contains user-language phrases that help match capabilities
 * to user requests without relying solely on semantic similarity.
 *
 * Priority Order:
 * 1. KEYWORDS match (most deterministic)
 * 2. Name/ID exact match
 * 3. Semantic similarity (fallback)
 */

// =============================================================================
// Types
// =============================================================================

export interface KeywordMatch {
	/** Capability ID (tool name, agent ID, etc.) */
	id: string;
	/** Type of capability */
	type: "mcp_tool" | "agent" | "workflow" | "integration" | "workspace";
	/** Name for display */
	name: string;
	/** Description */
	description: string;
	/** Keywords that matched */
	matchedKeywords: string[];
	/** Confidence score (0-1) */
	confidence: number;
	/** Why this matched */
	matchReason: string;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

export interface KeywordSearchOptions {
	/** Original user message (prioritized for matching) */
	userMessage: string;
	/** LLM-generated step description (secondary) */
	stepDescription?: string;
	/** Capability type filter */
	type?: "mcp_tool" | "agent" | "workflow" | "integration" | "workspace";
	/** Maximum results */
	limit?: number;
	/** Minimum confidence to include */
	minConfidence?: number;
}

export interface CapabilityWithKeywords {
	id: string;
	type: "mcp_tool" | "agent" | "workflow" | "integration" | "workspace";
	name: string;
	description: string;
	/** Explicit keywords for BM25-style matching */
	keywords: string[];
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

// =============================================================================
// KEYWORDS Extraction
// =============================================================================

/**
 * Extract KEYWORDS section from a capability description.
 *
 * Format: "KEYWORDS: keyword1, keyword2, phrase three, another phrase."
 *
 * These keywords are user-language phrases that help with BM25-style matching.
 * They should be written in the language users would naturally use when
 * requesting this capability.
 */
export function extractKeywordsFromDescription(description: string): string[] {
	// Match KEYWORDS: section (case-insensitive)
	// Supports formats:
	// - "KEYWORDS: word1, word2, phrase."
	// - "KEYWORDS: word1, word2, phrase\n"
	// - "Keywords: word1, word2"
	const keywordsMatch = description.match(
		/KEYWORDS?:\s*([^.]+?)(?:\.\s|$|\n)/i,
	);

	if (!keywordsMatch) {
		return [];
	}

	// Split on commas and clean up
	return keywordsMatch[1]
		.split(",")
		.map((kw) => kw.trim().toLowerCase())
		.filter((kw) => kw.length > 0);
}

/**
 * Extract implicit keywords from name and description.
 * Used when no explicit KEYWORDS section is present.
 */
export function extractImplicitKeywords(
	name: string,
	description: string,
): string[] {
	const keywords: string[] = [];

	// Extract from name (split camelCase and snake_case)
	const nameWords = name
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/_/g, " ")
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 2);
	keywords.push(...nameWords);

	// Add the full name as a keyword (for exact matches)
	keywords.push(name.toLowerCase());

	// Extract significant words from description (skip stop words)
	const stopWords = new Set([
		"the",
		"a",
		"an",
		"and",
		"or",
		"but",
		"in",
		"on",
		"at",
		"to",
		"for",
		"of",
		"with",
		"by",
		"from",
		"as",
		"is",
		"was",
		"are",
		"were",
		"been",
		"be",
		"have",
		"has",
		"had",
		"do",
		"does",
		"did",
		"will",
		"would",
		"could",
		"should",
		"may",
		"might",
		"must",
		"shall",
		"can",
		"this",
		"that",
		"these",
		"those",
		"it",
		"its",
		"use",
		"when",
		"user",
		"returns",
		"returns",
	]);

	const descWords = description
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 3 && !stopWords.has(w))
		.slice(0, 15); // Limit to avoid noise

	keywords.push(...descWords);

	return [...new Set(keywords)];
}

// =============================================================================
// BM25-Style Keyword Matching
// =============================================================================

/**
 * Calculate keyword match score between user input and capability keywords.
 *
 * Returns a score from 0-1 where:
 * - 1.0 = All keywords matched
 * - 0.9+ = Most keywords matched (high confidence)
 * - 0.7-0.9 = Partial match (good confidence)
 * - 0.5-0.7 = Some keywords matched (moderate confidence)
 * - <0.5 = Few keywords matched (low confidence)
 */
export function calculateKeywordMatchScore(
	userInput: string,
	keywords: string[],
): { score: number; matchedKeywords: string[] } {
	if (keywords.length === 0) {
		return { score: 0, matchedKeywords: [] };
	}

	const inputLower = userInput.toLowerCase();
	const matchedKeywords: string[] = [];

	for (const keyword of keywords) {
		// Check for exact phrase match (most important)
		if (inputLower.includes(keyword)) {
			matchedKeywords.push(keyword);
		}
	}

	if (matchedKeywords.length === 0) {
		return { score: 0, matchedKeywords: [] };
	}

	// Calculate score based on matched keywords ratio
	// Bonus for matching longer/more specific keywords
	const matchRatio = matchedKeywords.length / keywords.length;

	// Give bonus for longer keyword matches (more specific)
	const avgMatchedLength =
		matchedKeywords.reduce((sum, kw) => sum + kw.length, 0) /
		matchedKeywords.length;
	const lengthBonus = Math.min(avgMatchedLength / 20, 0.2); // Max 0.2 bonus

	// Score: base ratio + length bonus, capped at 1.0
	const score = Math.min(matchRatio + lengthBonus, 1.0);

	return { score, matchedKeywords };
}

/**
 * Search capabilities using BM25-style keyword matching.
 *
 * This implements Anthropic's recommendation for deterministic tool matching:
 * 1. Extract KEYWORDS from capability descriptions
 * 2. Match against user message (prioritized) and step description
 * 3. Return high-confidence matches that skip semantic search
 */
export function searchByKeywords(
	capabilities: CapabilityWithKeywords[],
	options: KeywordSearchOptions,
): KeywordMatch[] {
	const {
		userMessage,
		stepDescription,
		type,
		limit = 10,
		minConfidence = 0.3,
	} = options;

	const results: KeywordMatch[] = [];

	// Combine user message and step description for matching
	// User message gets priority (checked first)
	const searchTexts = [userMessage];
	if (stepDescription && stepDescription !== userMessage) {
		searchTexts.push(stepDescription);
	}

	for (const capability of capabilities) {
		// Filter by type if specified
		if (type && capability.type !== type) {
			continue;
		}

		// Get keywords (explicit + implicit)
		const explicitKeywords = extractKeywordsFromDescription(
			capability.description,
		);
		const implicitKeywords = extractImplicitKeywords(
			capability.name,
			capability.description,
		);

		// Combine keywords, prioritizing explicit ones
		const allKeywords = [
			...new Set([...explicitKeywords, ...implicitKeywords]),
		];

		// Calculate match scores for each search text
		let bestScore = 0;
		let bestMatchedKeywords: string[] = [];
		let matchSource = "";

		// Check user message first (higher weight)
		const userMatch = calculateKeywordMatchScore(userMessage, allKeywords);
		if (userMatch.score > 0) {
			bestScore = userMatch.score;
			bestMatchedKeywords = userMatch.matchedKeywords;
			matchSource = "user message";
		}

		// Check step description (lower weight, only if better than user match)
		if (stepDescription) {
			const stepMatch = calculateKeywordMatchScore(
				stepDescription,
				allKeywords,
			);
			// Step description match gets 80% weight
			const adjustedStepScore = stepMatch.score * 0.8;
			if (adjustedStepScore > bestScore) {
				bestScore = adjustedStepScore;
				bestMatchedKeywords = stepMatch.matchedKeywords;
				matchSource = "step description";
			}
		}

		// IMPORTANT: Boost for explicit KEYWORDS matches
		// If we matched keywords from the explicit KEYWORDS section, boost confidence
		if (explicitKeywords.length > 0 && bestMatchedKeywords.length > 0) {
			const explicitMatches = bestMatchedKeywords.filter((kw) =>
				explicitKeywords.includes(kw),
			);
			if (explicitMatches.length > 0) {
				// Explicit keyword match gets 20% boost
				bestScore = Math.min(bestScore + 0.2, 1.0);
				matchSource = `explicit KEYWORDS (${matchSource})`;
			}
		}

		if (bestScore >= minConfidence) {
			results.push({
				id: capability.id,
				type: capability.type,
				name: capability.name,
				description: capability.description,
				matchedKeywords: bestMatchedKeywords,
				confidence: bestScore,
				matchReason: `Keyword match via ${matchSource}: ${bestMatchedKeywords.join(", ")}`,
				metadata: capability.metadata,
			});
		}
	}

	// Sort by confidence (descending) and limit
	return results.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}

// =============================================================================
// Always-Available Capabilities
// =============================================================================

/**
 * Define capabilities that should ALWAYS be available (not deferred).
 * Following Anthropic's recommendation to keep 3-5 most frequently used
 * tools as non-deferred for optimal performance.
 *
 * These capabilities bypass search entirely and are always included
 * in the routing/planning context.
 */
export const ALWAYS_AVAILABLE_CAPABILITIES: CapabilityWithKeywords[] = [
	// Workspace RAG - most common for document queries
	{
		id: "workspace_rag_query",
		type: "workspace",
		name: "Workspace Document Search",
		description:
			"Search and retrieve information from the user's workspace documents. KEYWORDS: my documents, my files, workspace, attached files, uploaded documents, document search, find in documents.",
		keywords: [
			"my documents",
			"my files",
			"workspace",
			"attached files",
			"uploaded documents",
			"document search",
			"find in documents",
			"project documents",
			"search documents",
		],
	},
	// YouTube Transcript - frequently misrouted
	{
		id: "fabric_youtube_transcript",
		type: "mcp_tool",
		name: "YouTube Transcript",
		description:
			"Get raw transcript/captions from a YouTube video. KEYWORDS: get transcript, youtube transcript, video transcript, captions, subtitles, download transcript.",
		keywords: [
			"get transcript",
			"youtube transcript",
			"video transcript",
			"captions",
			"subtitles",
			"download transcript",
			"transcript for",
			"give me transcript",
			"extract transcript",
		],
	},
	// Web Search - common request
	{
		id: "fabric_web_search",
		type: "mcp_tool",
		name: "Web Search",
		description:
			"Search the web for information. KEYWORDS: search the web, web search, find online, search for, look up online.",
		keywords: [
			"search the web",
			"web search",
			"find online",
			"search for",
			"look up online",
			"search internet",
			"google",
		],
	},
	// URL Scraping - common request
	{
		id: "fabric_scrape_url",
		type: "mcp_tool",
		name: "Scrape URL",
		description:
			"Scrape content from a web page. KEYWORDS: scrape url, scrape website, get content from url, extract from webpage, read url.",
		keywords: [
			"scrape url",
			"scrape website",
			"get content from url",
			"extract from webpage",
			"read url",
			"fetch url",
			"get webpage",
		],
	},
	// YouTube Analysis - distinguish from transcript
	{
		id: "fabric_analyze_youtube",
		type: "mcp_tool",
		name: "Analyze YouTube Video",
		description:
			"Analyze and summarize a YouTube video using AI. KEYWORDS: summarize video, analyze video, what is this video about, video summary, explain video.",
		keywords: [
			"summarize video",
			"analyze video",
			"what is this video about",
			"video summary",
			"explain video",
			"summarize youtube",
			"youtube summary",
		],
	},
	// Feature decisions - reads a feature's Decisions tab (Decision Log threads)
	{
		id: "fabric_list_feature_decisions",
		type: "mcp_tool",
		name: "List Feature Decisions",
		description:
			"List a feature's Decisions tab entries (Decision Log threads) by storyId with status and summaries. KEYWORDS: feature decisions, story decisions, decisions tab, decision log, resolved decisions, open decisions, pending feature decisions, maturation decisions, story question log.",
		keywords: [
			"feature decisions",
			"story decisions",
			"decisions tab",
			"decision log",
			"resolved decisions",
			"open decisions",
			"pending decisions",
			"maturation decisions",
			"story question log",
		],
	},
	// Architecture decisions - reads the project's Decisions tab (ADR log)
	{
		id: "fabric_list_architecture_decisions",
		type: "mcp_tool",
		name: "List Architecture Decisions",
		description:
			"List the attached project's architecture decisions (ADRs) from the Decisions tab with their status (PROPOSED/ACCEPTED/SUPERSEDED/etc.), domain, rationale, and endorsement. KEYWORDS: architecture decisions, ADR, decisions tab, architectural constraints, design decisions, tech decisions, decision log, accepted decisions, proposed decisions, rejected decisions, what was decided.",
		keywords: [
			"architecture decisions",
			"ADR",
			"decisions tab",
			"architectural constraints",
			"design decisions",
			"tech decisions",
			"decision log",
			"ADR list",
			"accepted decisions",
			"proposed decisions",
			"rejected decisions",
			"architectural choices",
			"what was decided",
			"pending decisions",
			"decisions pending review",
		],
	},
	// Security findings - reads the project's Security tab (scan findings)
	{
		id: "fabric_list_security_findings",
		type: "mcp_tool",
		name: "List Security Findings",
		description:
			"List the attached project's Security tab findings (security/accessibility scan results) with severity, status, and remediation. KEYWORDS: security findings, security tab, scan findings, scan results, vulnerabilities, security issues, exposed credentials, secrets, accessibility findings, security triage, create tickets for findings.",
		keywords: [
			"security findings",
			"security tab",
			"scan findings",
			"scan results",
			"vulnerabilities",
			"security issues",
			"exposed credentials",
			"secrets",
			"accessibility findings",
			"what security findings",
			"list security issues",
			"security triage",
			"create tickets for findings",
		],
	},
];

/**
 * Get always-available capabilities that match the user's request.
 * These are checked FIRST before any search.
 */
export function matchAlwaysAvailableCapabilities(
	userMessage: string,
	stepDescription?: string,
): KeywordMatch[] {
	return searchByKeywords(ALWAYS_AVAILABLE_CAPABILITIES, {
		userMessage,
		stepDescription,
		minConfidence: 0.5, // Higher threshold for always-available
		limit: 5,
	});
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Convert tool definitions to CapabilityWithKeywords format.
 */
export function toolToCapabilityWithKeywords(tool: {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	configId?: string;
	serverName?: string;
}): CapabilityWithKeywords {
	const description = tool.description || "";
	const explicitKeywords = extractKeywordsFromDescription(description);
	const implicitKeywords = extractImplicitKeywords(tool.name, description);

	return {
		id: tool.name,
		type: "mcp_tool",
		name: tool.name,
		description,
		keywords: [...new Set([...explicitKeywords, ...implicitKeywords])],
		metadata: {
			configId: tool.configId,
			serverName: tool.serverName,
			inputSchema: tool.inputSchema,
		},
	};
}

/**
 * Convert agent to CapabilityWithKeywords format.
 */
export function agentToCapabilityWithKeywords(agent: {
	agentId: string;
	displayName: string;
	description: string;
	skills?: string[];
}): CapabilityWithKeywords {
	const description = agent.description || "";
	const explicitKeywords = extractKeywordsFromDescription(description);
	const implicitKeywords = extractImplicitKeywords(
		agent.agentId,
		description,
	);

	// Add skills as keywords
	const skillKeywords = (agent.skills || []).map((s) => s.toLowerCase());

	return {
		id: agent.agentId,
		type: "agent",
		name: agent.displayName,
		description,
		keywords: [
			...new Set([
				...explicitKeywords,
				...implicitKeywords,
				...skillKeywords,
			]),
		],
		metadata: {
			skills: agent.skills,
		},
	};
}
