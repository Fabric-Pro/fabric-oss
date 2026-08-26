/**
 * Type definitions for project context RAG operations
 */

import type { SparseVector } from "../embedding/sparse";

/**
 * Options for storing a project context in Qdrant
 */
export interface ProjectContextStoreOptions {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	content: string;
	embedding: number[];
	/** Sparse BM25 vector for hybrid search (auto-generated from content if not provided) */
	sparseVector?: SparseVector;
	metadata?: {
		type?: string;
		filename?: string;
		mimeType?: string;
		size?: number;
		[key: string]: any;
	};
}

/**
 * Options for searching project contexts
 */
export interface ProjectContextSearchOptions {
	projectId: string;
	userId: string;
	organizationId?: string;
	queryEmbedding: number[];
	/** Sparse vector for hybrid search (auto-generated from query if not provided) */
	querySparseVector?: SparseVector;
	topK?: number;
	minSimilarity?: number;
	contextIds?: string[]; // Optional: filter by specific context IDs
	/**
	 * Exclude points that came from a ProjectDocument (their payload carries a
	 * non-null `documentId`; every other context type leaves it null).
	 *
	 * Set by the Living Documents auto-refresh path so an unattended cycle can
	 * never read AI-written documents back in as if they were source material.
	 * Today those points already fail hydration — `getRetrievableContextById`
	 * resolves ProjectContext and ProjectContextUrlPage only — so this changes
	 * nothing about what reaches a prompt. What it does change: those points stop
	 * consuming topK slots they were only going to be discarded from, and the
	 * exclusion becomes an enforced invariant rather than an accident of the
	 * hydration path. Anyone "fixing" hydration to resolve ProjectDocument (it
	 * reads like a bug) would otherwise silently open an AI-reads-its-own-output
	 * loop on a schedule.
	 *
	 * Defaults off: every existing caller keeps its current behavior byte for byte.
	 */
	excludeDocumentChunks?: boolean;
}

/**
 * Result from project context retrieval
 */
export interface ProjectRetrievalResult {
	contextId: string;
	projectId: string;
	score: number;
	type: string;
	filename?: string;
	/**
	 * The text of the chunk that matched, when available in the Qdrant
	 * payload. Populated for chunks stored after the payload began carrying
	 * `content`; legacy points predate that change and this field is
	 * `undefined` — callers should fall back to the parent document content
	 * (typically truncated).
	 */
	content?: string;
}
