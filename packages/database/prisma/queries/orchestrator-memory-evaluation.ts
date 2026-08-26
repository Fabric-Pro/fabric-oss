/**
 * Orchestrator Memory Evaluation
 *
 * Functions for measuring the effectiveness of the memory system:
 * - Track memory usage and impact
 * - Calculate relevance scores
 * - Measure user engagement with memory features
 */

import { db } from "../client";

// =============================================================================
// TYPES
// =============================================================================

export interface MemoryUsageStats {
	totalEpisodes: number;
	totalPreferencesSet: number;
	avgEpisodesPerUser: number;
	episodesByOutcome: Record<string, number>;
	mostCommonTopics: Array<{ topic: string; count: number }>;
	avgEpisodeSummaryLength: number;
	episodesWithEmbeddings: number;
}

export interface MemoryEffectivenessMetrics {
	userId: string;
	organizationId: string | null;
	metrics: {
		preferencesSet: boolean;
		learnedPatternsCount: number;
		episodeCount: number;
		recentEpisodeCount: number;
		avgRelevanceScore: number;
		successfulEpisodeRate: number;
		topicsCapture: number;
		memoryAge: {
			oldestEpisode: Date | null;
			newestEpisode: Date | null;
		};
	};
	recommendations: string[];
}

export interface MemoryRetrievalMetrics {
	queryCount: number;
	avgRelevanceScore: number;
	hitRate: number;
	avgResultCount: number;
	topRetrievedTopics: string[];
}

// =============================================================================
// USAGE STATISTICS
// =============================================================================

/**
 * Get overall memory usage statistics
 */
export async function getMemoryUsageStats(): Promise<MemoryUsageStats> {
	// Get episode stats
	const episodeStats = await db.episodicMemory.aggregate({
		_count: true,
		_avg: {
			messageCount: true,
		},
	});

	// Get episodes by outcome
	const outcomeGroups = await db.episodicMemory.groupBy({
		by: ["outcome"],
		_count: true,
	});

	const episodesByOutcome: Record<string, number> = {};
	for (const group of outcomeGroups) {
		episodesByOutcome[group.outcome] = group._count;
	}

	// Get preferences count
	const preferencesCount = await db.orchestratorMemoryPreferences.count();

	// Get unique user count for episode average
	const uniqueUsers = await db.episodicMemory.findMany({
		select: { userId: true },
		distinct: ["userId"],
	});

	// Get topic frequency (sample for performance)
	const recentEpisodes = await db.episodicMemory.findMany({
		select: { keyTopics: true },
		orderBy: { createdAt: "desc" },
		take: 500,
	});

	const topicCounts: Record<string, number> = {};
	for (const ep of recentEpisodes) {
		for (const topic of ep.keyTopics) {
			topicCounts[topic] = (topicCounts[topic] || 0) + 1;
		}
	}

	const mostCommonTopics = Object.entries(topicCounts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 20)
		.map(([topic, count]) => ({ topic, count }));

	// Count episodes with embeddings
	const episodesWithEmbeddings = await db.episodicMemory.count({
		where: { qdrantPointId: { not: null } },
	});

	// Get average summary length (sample)
	const summaryLengths = recentEpisodes.map(
		(ep) => (ep as any).summary?.length || 0,
	);
	const avgSummaryLength =
		summaryLengths.length > 0
			? summaryLengths.reduce((a, b) => a + b, 0) / summaryLengths.length
			: 0;

	return {
		totalEpisodes: episodeStats._count,
		totalPreferencesSet: preferencesCount,
		avgEpisodesPerUser:
			uniqueUsers.length > 0
				? episodeStats._count / uniqueUsers.length
				: 0,
		episodesByOutcome,
		mostCommonTopics,
		avgEpisodeSummaryLength: avgSummaryLength,
		episodesWithEmbeddings,
	};
}

/**
 * Get memory effectiveness metrics for a specific user
 */
export async function getUserMemoryEffectiveness(
	userId: string,
	organizationId?: string | null,
): Promise<MemoryEffectivenessMetrics> {
	const normalizedOrgId = organizationId ?? null;

	// Get user preferences
	const preferences = await db.orchestratorMemoryPreferences.findFirst({
		where: { userId, organizationId: normalizedOrgId },
	});

	// Get episode stats
	const episodes = await db.episodicMemory.findMany({
		where: { userId, organizationId: normalizedOrgId },
		select: {
			id: true,
			outcome: true,
			keyTopics: true,
			createdAt: true,
			conversationEndedAt: true,
		},
		orderBy: { createdAt: "desc" },
	});

	// Calculate metrics
	const successfulEpisodes = episodes.filter(
		(e) => e.outcome === "success",
	).length;
	const successRate =
		episodes.length > 0 ? successfulEpisodes / episodes.length : 0;

	const recentEpisodes = episodes.slice(0, 10);
	const allTopics = new Set(episodes.flatMap((e) => e.keyTopics));

	const learnedPatterns =
		(preferences?.preferences as any)?.learnedPatterns || [];

	const recommendations: string[] = [];

	// Generate recommendations
	if (!preferences?.responseStyle) {
		recommendations.push(
			"Set a preferred response style to get more personalized responses",
		);
	}
	if (learnedPatterns.length === 0) {
		recommendations.push(
			"Continue using Fabric AI to let it learn your preferences",
		);
	}
	if (episodes.length < 5) {
		recommendations.push(
			"Use Fabric AI more to build up conversation history for better context",
		);
	}
	if (successRate < 0.7 && episodes.length > 5) {
		recommendations.push(
			"Try providing more specific instructions to improve success rate",
		);
	}

	return {
		userId,
		organizationId: normalizedOrgId,
		metrics: {
			preferencesSet:
				!!preferences?.responseStyle ||
				!!preferences?.verbosity ||
				!!preferences?.codeLanguage,
			learnedPatternsCount: learnedPatterns.length,
			episodeCount: episodes.length,
			recentEpisodeCount: recentEpisodes.length,
			avgRelevanceScore: 0, // TODO: Calculate from Qdrant searches
			successfulEpisodeRate: successRate,
			topicsCapture: allTopics.size,
			memoryAge: {
				oldestEpisode: episodes[episodes.length - 1]?.createdAt || null,
				newestEpisode: episodes[0]?.createdAt || null,
			},
		},
		recommendations,
	};
}

// =============================================================================
// MEMORY HEALTH CHECK
// =============================================================================

export interface MemoryHealthStatus {
	healthy: boolean;
	issues: string[];
	stats: {
		orphanedEpisodes: number;
		episodesWithoutEmbeddings: number;
		stalePreferences: number;
	};
}

/**
 * Check health of the memory system
 */
export async function checkMemoryHealth(): Promise<MemoryHealthStatus> {
	const issues: string[] = [];

	// Check for episodes without embeddings
	const noEmbeddingCount = await db.episodicMemory.count({
		where: { qdrantPointId: null },
	});

	if (noEmbeddingCount > 0) {
		issues.push(
			`${noEmbeddingCount} episodes missing embeddings - semantic search may be incomplete`,
		);
	}

	// Check for stale preferences (not updated in 90 days)
	const staleDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
	const stalePreferences = await db.orchestratorMemoryPreferences.count({
		where: { lastActiveAt: { lt: staleDate } },
	});

	if (stalePreferences > 100) {
		issues.push(
			`${stalePreferences} users haven't been active in 90+ days`,
		);
	}

	// Check for orphaned episodes (user deleted but episodes remain)
	// This is a lightweight check - full cleanup should be done separately
	const orphanedEpisodes = 0; // Would require join query

	return {
		healthy: issues.length === 0,
		issues,
		stats: {
			orphanedEpisodes,
			episodesWithoutEmbeddings: noEmbeddingCount,
			stalePreferences,
		},
	};
}

// =============================================================================
// CLEANUP UTILITIES
// =============================================================================

/**
 * Archive old episodes to reduce active data size
 * Episodes older than retentionDays are marked for archival
 */
export async function archiveOldEpisodes(
	retentionDays = 365,
): Promise<{ archivedCount: number }> {
	const cutoffDate = new Date(
		Date.now() - retentionDays * 24 * 60 * 60 * 1000,
	);

	// For now, just count - actual archival would move to cold storage
	const oldEpisodes = await db.episodicMemory.count({
		where: { conversationEndedAt: { lt: cutoffDate } },
	});

	return { archivedCount: oldEpisodes };
}

/**
 * Consolidate learned patterns (remove duplicates, merge similar)
 */
export async function consolidateLearnedPatterns(
	userId: string,
	organizationId?: string | null,
): Promise<{ originalCount: number; consolidatedCount: number }> {
	const normalizedOrgId = organizationId ?? null;

	const preferences = await db.orchestratorMemoryPreferences.findFirst({
		where: { userId, organizationId: normalizedOrgId },
	});

	if (!preferences) {
		return { originalCount: 0, consolidatedCount: 0 };
	}

	const patterns: string[] =
		(preferences.preferences as any)?.learnedPatterns || [];
	const originalCount = patterns.length;

	// Remove exact duplicates
	const uniquePatterns = [...new Set(patterns)];

	// Remove very similar patterns (simple string distance)
	const consolidatedPatterns: string[] = [];
	for (const pattern of uniquePatterns) {
		const isDuplicate = consolidatedPatterns.some((existing) => {
			const similarity = stringSimilarity(pattern, existing);
			return similarity > 0.8;
		});
		if (!isDuplicate) {
			consolidatedPatterns.push(pattern);
		}
	}

	// Update if changed
	if (consolidatedPatterns.length !== originalCount) {
		await db.orchestratorMemoryPreferences.update({
			where: { id: preferences.id },
			data: {
				preferences: {
					...(preferences.preferences as object),
					learnedPatterns: consolidatedPatterns,
				},
			},
		});
	}

	return {
		originalCount,
		consolidatedCount: consolidatedPatterns.length,
	};
}

/**
 * Simple string similarity (Jaccard index on words)
 */
function stringSimilarity(a: string, b: string): number {
	const wordsA = new Set(a.toLowerCase().split(/\s+/));
	const wordsB = new Set(b.toLowerCase().split(/\s+/));

	const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
	const union = new Set([...wordsA, ...wordsB]);

	return union.size > 0 ? intersection.size / union.size : 0;
}
