/**
 * Agent Search
 *
 * Search for available AI agents that can handle specific tasks.
 * Uses semantic (embedding-based) search combined with keyword matching.
 *
 * IMPROVED (Anthropic Tool Search Pattern):
 * - Uses KEYWORDS section for BM25-style deterministic matching
 * - Supports always-available agents that bypass search
 * - Hybrid scoring combines keyword + semantic relevance
 */

import { getAgentsWithEmbeddings, updateAgentEmbedding } from "@repo/database";
import { generateEmbedding } from "@repo/rag/lib/embedding/generator";
import type { TenantContext } from "@repo/rag/lib/embedding/types";
import { CacheKeys, CacheTTL, RedisCache } from "../../../lib/redis-cache";
import { cosineSimilarity } from "./capability-embeddings";
import {
	type CapabilityWithKeywords,
	calculateKeywordMatchScore,
	extractKeywordsFromDescription,
} from "./capability-keywords";
import type {
	SearchAvailableAgentsInput,
	SearchAvailableAgentsOutput,
} from "./types";
import { extractQueryWords } from "./utils";

// =============================================================================
// Always-Available Agents
// Following Anthropic's recommendation to keep 3-5 frequently used capabilities
// non-deferred for optimal performance.
// =============================================================================

/**
 * Agents that should always be considered regardless of search results.
 * These are high-frequency agents that handle common requests.
 */
const ALWAYS_AVAILABLE_AGENTS: CapabilityWithKeywords[] = [
	{
		id: "project_document_generator",
		type: "agent",
		name: "Project Document Generator",
		description:
			"Generate project documents like PRDs, specifications, proposals. KEYWORDS: generate prd, create spec, write document, project document, specification, proposal, requirements document.",
		keywords: [
			"generate prd",
			"create spec",
			"write document",
			"project document",
			"specification",
			"proposal",
			"requirements document",
			"prd",
			"spec",
		],
	},
	{
		id: "task_planner",
		type: "agent",
		name: "Task Planner",
		description:
			"Break down complex tasks into actionable steps. KEYWORDS: plan tasks, break down, decompose task, create plan, task breakdown, step by step.",
		keywords: [
			"plan tasks",
			"break down",
			"decompose task",
			"create plan",
			"task breakdown",
			"step by step",
			"planning",
		],
	},
];

/**
 * Check always-available agents for keyword matches.
 */
function matchAlwaysAvailableAgents(query: string): Array<{
	agent: CapabilityWithKeywords;
	score: number;
	matchReason: string;
}> {
	const queryLower = query.toLowerCase();
	const matches: Array<{
		agent: CapabilityWithKeywords;
		score: number;
		matchReason: string;
	}> = [];

	for (const agent of ALWAYS_AVAILABLE_AGENTS) {
		const { score, matchedKeywords } = calculateKeywordMatchScore(
			queryLower,
			agent.keywords,
		);
		if (score >= 0.5) {
			matches.push({
				agent,
				score,
				matchReason: `Always-available agent, keyword match: ${matchedKeywords.join(", ")}`,
			});
		}
	}

	return matches.sort((a, b) => b.score - a.score);
}

/**
 * Search for available agents that match the query.
 *
 * HYBRID BM25-FIRST SEARCH (Anthropic Tool Search Pattern):
 * 1. Check always-available agents first
 * 2. Extract KEYWORDS from agent descriptions for BM25-style matching
 * 3. Combine with semantic search using hybrid scoring
 */
export async function searchAvailableAgents(
	input: SearchAvailableAgentsInput,
): Promise<SearchAvailableAgentsOutput> {
	const startTime = Date.now();
	console.log(`[SearchAgents] Searching for: "${input.query}"`);

	// ==========================================================================
	// STEP 1: Check always-available agents FIRST
	// ==========================================================================
	const alwaysAvailableMatches = matchAlwaysAvailableAgents(input.query);
	if (alwaysAvailableMatches.length > 0) {
		console.log(
			`[SearchAgents] Always-available matches: ${alwaysAvailableMatches.map((m) => `${m.agent.name}(${(m.score * 100).toFixed(0)}%)`).join(", ")}`,
		);
	}

	// ==========================================================================
	// STEP 2: Query agents from database (includes pre-computed embeddings)
	// ==========================================================================
	const allAgents = await getAgentsWithEmbeddings({
		userId: input.userId,
		organizationId: input.organizationId,
		status: "ACTIVE",
	});

	// Apply enabledAgentIds filter in-memory (mirrors original db-level filter)
	const agents = input.enabledAgentIds
		? allAgents.filter((a) => input.enabledAgentIds?.includes(a.agentId))
		: allAgents;

	if (agents.length === 0) {
		return {
			results: [],
			totalAgentsSearched: 0,
			durationMs: Date.now() - startTime,
		};
	}

	// Filter out stale agents: those with "STALE" status or whose lastHealthCheck is
	// older than 10 minutes — aligned with the health monitor's staleThresholdMinutes
	// default (10 min). Using a shorter window here would incorrectly exclude agents
	// that the health monitor still considers ACTIVE.
	const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);
	const freshAgents = agents.filter((agent) => {
		if (agent.status === "STALE") {
			return false;
		}
		if (
			agent.lastHealthCheck !== null &&
			agent.lastHealthCheck < staleThreshold
		) {
			return false;
		}
		return true;
	});

	if (freshAgents.length < agents.length) {
		console.log(
			`[SearchAgents] Filtered ${agents.length - freshAgents.length} stale agents`,
		);
	}

	const filteredAgents = freshAgents;

	// Generate query embedding for semantic search (Redis L1 cache first).
	// We also capture the resolved model ID so agent embedding caches can be
	// scoped to the same model — preventing cross-model vector comparisons
	// when different tenants configure different embedding providers.
	type CachedQueryEmbedding = {
		embedding: number[];
		model: string;
	};

	let queryEmbedding: number[] | null = null;
	let resolvedEmbeddingModel: string | undefined;
	try {
		const tenantContext: TenantContext = {
			userId: input.userId,
			organizationId: input.organizationId,
		};

		// Check Redis L1 before calling the embedding API.
		// We cache {embedding, model} together so cache hits also recover the
		// model string — without this, resolvedEmbeddingModel would stay
		// undefined on hits and agent embedding caches would lose model scoping.
		const queryCacheKey = CacheKeys.queryEmbedding(
			input.query,
			input.userId,
			input.organizationId,
		);
		const cachedEntry = await RedisCache.get<
			CachedQueryEmbedding | number[]
		>(queryCacheKey);

		if (cachedEntry && !Array.isArray(cachedEntry)) {
			console.log("[SearchAgents] Query embedding cache hit");
			queryEmbedding = cachedEntry.embedding;
			resolvedEmbeddingModel = cachedEntry.model;
		} else {
			if (cachedEntry) {
				console.log(
					"[SearchAgents] Ignoring legacy query embedding cache entry without model metadata",
				);
			}
			// Credentials are fetched internally by generateEmbedding()
			const result = await generateEmbedding(
				input.query,
				tenantContext,
				undefined,
			);
			queryEmbedding = result.embedding;
			resolvedEmbeddingModel = result.model;
			// Cache embedding + model together so hits preserve the model
			RedisCache.set(
				queryCacheKey,
				{ embedding: result.embedding, model: result.model },
				CacheTTL.queryEmbedding,
			).catch(() => {});
		}
	} catch (error) {
		console.warn(
			"[SearchAgents] Failed to generate query embedding:",
			error,
		);
	}

	// Build agent search texts (used for on-demand embedding fallback and cache misses)
	const buildAgentSearchText = (
		agent: (typeof filteredAgents)[0],
	): string => {
		const metadata = agent.metadata as Record<string, unknown> | null;
		const skills =
			(metadata?.skills as Array<{
				name: string;
				description?: string;
			}>) || [];
		const tags = (metadata?.tags as string[]) || [];
		// Combine name, description, skills, and tags for embedding
		return `${agent.displayName}: ${agent.description || ""}. Skills: ${skills.map((s) => s.name).join(", ")}. Tags: ${tags.join(", ")}`;
	};

	// Resolve embeddings for all filtered agents.
	// Priority: cached embedding in metadata → generate on-the-fly and persist
	// for next call (fire-and-forget). This reduces O(n) API calls to O(cache_misses).
	const agentEmbeddings: (number[] | null)[] = await Promise.all(
		filteredAgents.map(async (agent) => {
			// Redis L1: key is scoped to the caller's embedding model so
			// different tenants with different models get separate cache entries.
			const agentEmbedCacheKey = CacheKeys.agentEmbedding(
				agent.agentId,
				resolvedEmbeddingModel,
			);
			const redisEmbedding =
				await RedisCache.get<number[]>(agentEmbedCacheKey);
			if (redisEmbedding) {
				return redisEmbedding;
			}

			// DB L2: only use cached embedding if it was generated by the same
			// model as the caller's query embedding. Without this check, two
			// same-dimension but different-model embeddings would be compared
			// and produce meaningless cosine scores.
			if (agent.cachedEmbedding) {
				const modelMatch =
					!resolvedEmbeddingModel ||
					!agent.cachedEmbeddingModel ||
					agent.cachedEmbeddingModel === resolvedEmbeddingModel;
				const dimsMatch =
					!queryEmbedding ||
					agent.cachedEmbedding.length === queryEmbedding.length;

				if (modelMatch && dimsMatch) {
					// Backfill Redis (model-scoped) so the next call is an L1 hit
					RedisCache.set(
						agentEmbedCacheKey,
						agent.cachedEmbedding,
						CacheTTL.agentEmbedding,
					).catch(() => {});
					return agent.cachedEmbedding;
				}
				console.warn(
					`[SearchAgents] Skipping cached embedding for ${agent.agentId}: ` +
						`cachedModel=${agent.cachedEmbeddingModel || "unknown"}, ` +
						`callerModel=${resolvedEmbeddingModel || "unknown"}. Regenerating.`,
				);
			}

			// Cache miss: generate embedding with caller's tenant context and persist
			if (queryEmbedding) {
				try {
					const tenantContext: TenantContext = {
						userId: input.userId,
						organizationId: input.organizationId,
					};
					const text = buildAgentSearchText(agent);
					const result = await generateEmbedding(
						text,
						tenantContext,
						undefined,
					);
					const embedding = result.embedding;

					// Fire-and-forget: persist to DB (durable L2) with model ID
					updateAgentEmbedding(
						agent.agentId,
						embedding,
						new Date(),
						result.model,
					).catch((err) => {
						console.warn(
							`[SearchAgents] Failed to persist embedding for ${agent.agentId}:`,
							err,
						);
					});
					// Cache in Redis scoped to model (fast L1 reads)
					RedisCache.set(
						agentEmbedCacheKey,
						embedding,
						CacheTTL.agentEmbedding,
					).catch(() => {});

					return embedding;
				} catch (error) {
					console.warn(
						`[SearchAgents] Failed to generate embedding for ${agent.agentId}:`,
						error,
					);
				}
			}

			return null;
		}),
	);

	// ==========================================================================
	// STEP 3: Score each agent using hybrid approach (KEYWORDS + keyword + semantic)
	// ==========================================================================
	const queryLower = input.query.toLowerCase();
	const queryWords = extractQueryWords(input.query);

	const scoredAgents = filteredAgents
		.map((agent, index) => {
			const metadata = agent.metadata as Record<string, unknown> | null;
			const skills =
				(metadata?.skills as Array<{
					name: string;
					description?: string;
				}>) || [];
			const tags = (metadata?.tags as string[]) || [];
			const limitations = (metadata?.limitations as string[]) || [];

			// Filter by limitations if specified
			if (input.excludeLimitations) {
				for (const limitation of limitations) {
					for (const exclude of input.excludeLimitations) {
						if (
							limitation
								.toLowerCase()
								.includes(exclude.toLowerCase())
						) {
							return null; // Exclude this agent
						}
					}
				}
			}

			// PRIORITY 0: Check KEYWORDS section first (BM25-style exact phrase matching)
			// This is the most deterministic - matches user language directly
			const descLower = (agent.description || "").toLowerCase();
			const explicitKeywords = extractKeywordsFromDescription(descLower);
			let keywordsScore = 0;
			if (explicitKeywords.length > 0) {
				const { score, matchedKeywords } = calculateKeywordMatchScore(
					queryLower,
					explicitKeywords,
				);
				if (score > 0) {
					keywordsScore = score;
					console.log(
						`[SearchAgents] KEYWORDS match for ${agent.agentId}: ${matchedKeywords.join(", ")} (${(score * 100).toFixed(0)}%)`,
					);
				}
			}

			// Keyword-based score (traditional BM25-style)
			let keywordScore = 0;
			const matchReasons: string[] = [];

			// Name matching
			const nameLower = agent.displayName.toLowerCase();
			if (
				nameLower.includes(queryLower) ||
				queryLower.includes(nameLower)
			) {
				keywordScore += 0.4;
				matchReasons.push(`Name: ${agent.displayName}`);
			}

			// Description word matching
			for (const word of queryWords) {
				if (descLower.includes(word)) {
					keywordScore += 0.1;
				}
			}

			// Skill matching
			for (const skill of skills) {
				const skillLower = skill.name.toLowerCase();
				if (
					queryLower.includes(skillLower) ||
					skillLower.includes(queryLower)
				) {
					keywordScore += 0.2;
					matchReasons.push(`Skill: ${skill.name}`);
				}
			}

			// Tag matching
			for (const tag of tags) {
				const tagLower = tag.toLowerCase();
				if (queryLower.includes(tagLower)) {
					keywordScore += 0.1;
					matchReasons.push(`Tag: ${tag}`);
				}
			}

			// Semantic similarity score
			const agentEmbedding = agentEmbeddings[index] ?? null;
			let semanticScore = 0;
			if (queryEmbedding && agentEmbedding) {
				semanticScore = cosineSimilarity(
					queryEmbedding,
					agentEmbedding,
				);
				if (semanticScore > 0.5) {
					matchReasons.push(
						`Semantic similarity: ${(semanticScore * 100).toFixed(0)}%`,
					);
				}
			}

			// If KEYWORDS matched with high confidence, use that directly
			if (keywordsScore >= 0.7) {
				return {
					agent,
					score: keywordsScore,
					matchReason: `KEYWORDS match (${(keywordsScore * 100).toFixed(0)}%)`,
					skills: skills.map((s) => s.name),
					limitations,
					semanticScore,
				};
			}

			// Hybrid score: 40% keyword + 60% semantic
			const normalizedKeyword = Math.min(keywordScore, 1);
			const hybridScore =
				queryEmbedding && agentEmbedding
					? 0.4 * normalizedKeyword + 0.6 * semanticScore
					: normalizedKeyword; // Fallback to keyword only if no embeddings

			return {
				agent,
				score: hybridScore,
				matchReason: matchReasons.join("; ") || "Semantic match",
				skills: skills.map((s) => s.name),
				limitations,
				semanticScore,
			};
		})
		.filter((a): a is NonNullable<typeof a> => a !== null)
		.filter((a) => a.score >= (input.minConfidence || 0.2))
		.sort((a, b) => b.score - a.score)
		.slice(0, input.limit || 5);

	// ==========================================================================
	// STEP 4: Merge with always-available agents
	// ==========================================================================
	const durationMs = Date.now() - startTime;
	const semanticUsed = queryEmbedding !== null && agentEmbeddings.length > 0;

	// Build results from scored agents
	const resultMap = new Map<
		string,
		SearchAvailableAgentsOutput["results"][0]
	>();

	for (const sa of scoredAgents) {
		resultMap.set(sa.agent.agentId, {
			agentId: sa.agent.agentId,
			name: sa.agent.name,
			displayName: sa.agent.displayName,
			description: sa.agent.description || "",
			confidence: sa.score,
			matchReason: sa.matchReason,
			skills: sa.skills,
			limitations: sa.limitations.length > 0 ? sa.limitations : undefined,
		});
	}

	// Merge always-available matches (higher confidence wins)
	// Only include always-available agents that are actually registered in the DB
	// to avoid surfacing agents that resolveAgentEndpoint can't find
	const dbAgentIds = new Set(filteredAgents.map((a) => a.agentId));
	for (const match of alwaysAvailableMatches) {
		if (!dbAgentIds.has(match.agent.id)) {
			console.log(
				`[SearchAgents] Skipping always-available agent "${match.agent.id}" - not registered in database`,
			);
			continue;
		}
		const existing = resultMap.get(match.agent.id);
		if (!existing || match.score > existing.confidence) {
			resultMap.set(match.agent.id, {
				agentId: match.agent.id,
				name: match.agent.name,
				displayName: match.agent.name,
				description: match.agent.description,
				confidence: match.score,
				matchReason: match.matchReason,
				skills: match.agent.keywords.slice(0, 5),
				limitations: undefined,
			});
		}
	}

	// Sort by confidence and convert to array
	const results = Array.from(resultMap.values())
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, input.limit || 5);

	console.log(
		`[SearchAgents] Found ${results.length} agents in ${durationMs}ms (semantic: ${semanticUsed}, always-available: ${alwaysAvailableMatches.length})`,
	);

	return {
		results,
		totalAgentsSearched: filteredAgents.length,
		durationMs,
	};
}
