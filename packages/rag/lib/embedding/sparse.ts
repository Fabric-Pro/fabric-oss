/**
 * BM25 Sparse Vector Generator
 *
 * Generates sparse vectors from text using BM25-style term frequencies.
 * These complement dense embeddings for hybrid search: dense captures
 * semantic meaning while sparse captures exact keyword/term matches.
 *
 * No external model needed — pure tokenization + term frequency math.
 *
 * Used by Qdrant's hybrid search with Reciprocal Rank Fusion (RRF).
 */

/**
 * Sparse vector representation for Qdrant.
 * Only stores non-zero entries (term indices + weights).
 */
export interface SparseVector {
	indices: number[];
	values: number[];
}

// Simple hash function to map terms to indices in a fixed vocabulary space
const VOCAB_SIZE = 30000;

function hashTerm(term: string): number {
	let hash = 0;
	for (let i = 0; i < term.length; i++) {
		const char = term.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash |= 0; // Convert to 32bit integer
	}
	return Math.abs(hash) % VOCAB_SIZE;
}

/**
 * Tokenize text into terms.
 * Lowercases, removes punctuation, splits on whitespace,
 * and filters out very short tokens and stop words.
 */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\w\s-]/g, " ")
		.split(/\s+/)
		.filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/**
 * Generate a BM25-style sparse vector from text.
 *
 * Uses term frequency with sublinear scaling (1 + log(tf))
 * to produce sparse representations suitable for keyword matching.
 *
 * @param text - Input text to vectorize
 * @returns Sparse vector with term indices and TF weights
 */
export function generateSparseVector(text: string): SparseVector {
	const tokens = tokenize(text);

	if (tokens.length === 0) {
		return { indices: [], values: [] };
	}

	// Count term frequencies
	const termFreqs = new Map<number, number>();
	for (const token of tokens) {
		const idx = hashTerm(token);
		termFreqs.set(idx, (termFreqs.get(idx) || 0) + 1);
	}

	// Apply sublinear TF scaling: weight = 1 + log(tf)
	// This dampens the effect of repeated terms
	const indices: number[] = [];
	const values: number[] = [];

	for (const [idx, tf] of termFreqs) {
		indices.push(idx);
		values.push(1 + Math.log(tf));
	}

	return { indices, values };
}

/**
 * Generate sparse vectors for multiple texts in batch.
 */
export function generateSparseVectors(texts: string[]): SparseVector[] {
	return texts.map(generateSparseVector);
}

// Common English stop words to exclude from sparse vectors
const STOP_WORDS = new Set([
	"a",
	"an",
	"the",
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
	"is",
	"it",
	"as",
	"be",
	"was",
	"are",
	"were",
	"been",
	"being",
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
	"can",
	"shall",
	"this",
	"that",
	"these",
	"those",
	"am",
	"not",
	"no",
	"if",
	"so",
	"we",
	"he",
	"she",
	"they",
	"me",
	"him",
	"her",
	"us",
	"them",
	"my",
	"his",
	"its",
	"our",
	"your",
	"their",
	"what",
	"which",
	"who",
	"whom",
	"how",
	"when",
	"where",
	"why",
	"all",
	"each",
	"every",
	"both",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"than",
	"too",
	"very",
]);
