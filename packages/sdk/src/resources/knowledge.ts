/**
 * KnowledgeResource — RAG search over a tenant's project / chat documents.
 *
 *   const hits = await fabric.knowledge.search({
 *     query: "refund policy",
 *     scope: { kind: "chat", id: "chat_abc" },
 *     topK: 5,
 *   });
 *
 * Backed by `POST /api/v1/knowledge/search`, which resolves the workspace's
 * AI provider config server-side (the SDK consumer never holds an embedding
 * API key).
 */

import type { FabricHttpClient } from "../client.js";

/** What collection the query runs against. */
export type KnowledgeScope =
	| { kind: "chat"; id: string }
	| { kind: "project"; id: string };

export interface KnowledgeSearchOptions {
	query: string;
	scope: KnowledgeScope;
	topK?: number;
	minSimilarity?: number;
	/** Optional filter — only retrieve chunks from these document IDs. */
	documentIds?: string[];
	org?: string;
	personal?: boolean;
}

export interface KnowledgeChunk {
	id: string;
	content: string;
	similarity: number;
	documentId?: string;
	documentName?: string;
	chunkIndex?: number;
	metadata?: Record<string, unknown>;
}

export class KnowledgeResource {
	constructor(private readonly http: FabricHttpClient) {}

	/** Retrieve the top-K most relevant chunks for `query` within `scope`. */
	search(options: KnowledgeSearchOptions): Promise<KnowledgeChunk[]> {
		const { org, personal, ...body } = options;
		const params = new URLSearchParams();
		if (org) {
			params.set("org", org);
		}
		if (personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.post<KnowledgeChunk[]>(
			`/knowledge/search${qs ? `?${qs}` : ""}`,
			body,
		);
	}
}
