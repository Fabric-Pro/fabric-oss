import type { FabricHttpClient } from "../client.js";
import type {
	FabricWorkspace,
	FabricWorkspaceDetail,
	ListOptions,
} from "../types.js";

export interface ListWorkspacesOptions extends ListOptions {
	status?: "ACTIVE" | "ARCHIVED";
}

export interface QueryWorkspaceOptions {
	query: string;
	/** Max chunks to return. Server clamps to [1, 50]. Default 10. */
	limit?: number;
	/** Restrict the search to a subset of documents inside the workspace. */
	documentIds?: string[];
	org?: string;
	personal?: boolean;
}

/**
 * Pointer-style hit from `workspaces.query`. The chunk content itself
 * is intentionally not returned — fetch the document if you need text.
 */
export interface WorkspaceQueryHit {
	chunkId: string;
	documentId: string;
	filename: string | null;
	score: number;
	chunkIndex: number;
	pageNumber: number | null;
	headings: string[];
}

export class WorkspacesResource {
	constructor(private readonly http: FabricHttpClient) {}

	list(options: ListWorkspacesOptions = {}): Promise<FabricWorkspace[]> {
		const q = buildQuery(options);
		return this.http.get<FabricWorkspace[]>(`/workspaces${q}`);
	}

	get(
		id: string,
		options: { org?: string; personal?: boolean } = {},
	): Promise<FabricWorkspaceDetail> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const q = params.toString() ? `?${params.toString()}` : "";
		return this.http.get<FabricWorkspaceDetail>(`/workspaces/${id}${q}`);
	}

	/**
	 * Semantic + sparse hybrid RAG search over a workspace's documents.
	 * Server-side resolves the tenant's embedding provider — no API key
	 * required from the SDK consumer. Returns pointer hits (document +
	 * chunk + headings + score) without chunk text; fetch the document
	 * to read the full content.
	 */
	async query(
		workspaceId: string,
		options: QueryWorkspaceOptions,
	): Promise<WorkspaceQueryHit[]> {
		const { org, personal, ...body } = options;
		const params = new URLSearchParams();
		if (org) {
			params.set("org", org);
		}
		if (personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.post<WorkspaceQueryHit[]>(
			`/workspaces/${workspaceId}/query${qs ? `?${qs}` : ""}`,
			body,
		);
	}
}

function buildQuery(opts: object): string {
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(opts)) {
		if (v !== undefined && v !== null) {
			params.set(k, k === "personal" ? (v ? "1" : "") : String(v));
		}
	}
	const s = params.toString();
	return s ? `?${s}` : "";
}
