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

/** One entry of a project's knowledge artifact type catalog. */
export interface KnowledgeArtifactTypeInfo {
	key: string;
	name: string;
	description: string;
	template: string | null;
	fieldSchema: Record<string, unknown> | null;
	summaryBehavior: "MERGE" | "LATEST_WINS" | "EXCLUDED";
}

export interface KnowledgeArtifactTypes {
	types: KnowledgeArtifactTypeInfo[];
}

export class KnowledgeResource {
	constructor(private readonly http: FabricHttpClient) {}

	/**
	 * The project's knowledge artifact types (the knowledge hub catalog the
	 * Coding Instructions plugin renders into its `fabric-knowledge` skill).
	 * Needs `instructions:read` and the project's CONTEXT_READ permission.
	 */
	getProjectTypes(projectId: string): Promise<KnowledgeArtifactTypes> {
		return this.http.get<KnowledgeArtifactTypes>(
			`/projects/${encodeURIComponent(projectId)}/knowledge/types`,
		);
	}

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
