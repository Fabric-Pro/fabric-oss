/**
 * Utility Functions for Search Activities
 *
 * Provides common utility functions used across search modules.
 */

/**
 * Calculate cosine similarity between two vectors.
 * Returns a value between -1 and 1 where 1 means identical.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) {
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
	if (magnitude === 0) {
		return 0;
	}

	return dotProduct / magnitude;
}

/**
 * Normalize a keyword score to 0-1 range.
 */
export function normalizeScore(score: number, maxScore = 1): number {
	return Math.min(score / maxScore, 1);
}

/**
 * Calculate hybrid score combining keyword and semantic scores.
 * Default weights: 40% keyword, 60% semantic.
 */
export function hybridScore(
	keywordScore: number,
	semanticScore: number | null,
	keywordWeight = 0.4,
): number {
	const normalizedKeyword = Math.min(keywordScore, 1);

	if (semanticScore === null) {
		return normalizedKeyword;
	}

	const semanticWeight = 1 - keywordWeight;
	return keywordWeight * normalizedKeyword + semanticWeight * semanticScore;
}

/**
 * Extract words from a query for keyword matching.
 * Filters out short words (< 3 chars).
 */
export function extractQueryWords(query: string): string[] {
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 2);
}

/**
 * Check if any of the query words match the target text.
 * Returns the number of matching words.
 */
export function countKeywordMatches(
	queryWords: string[],
	targetText: string,
): number {
	const targetLower = targetText.toLowerCase();
	return queryWords.filter((word) => targetLower.includes(word)).length;
}
