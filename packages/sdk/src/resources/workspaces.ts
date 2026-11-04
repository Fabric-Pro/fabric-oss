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

/** Direct extracted-text reads do not require an AI provider or vector index. */
export interface ReadWorkspaceDocumentOptions {
	org?: string;
	/** Unicode code point offset. Continuations require expectedRevision. */
	offset?: number;
	/** 1..20,000 Unicode code points; default 12,000. */
	limit?: number;
	expectedRevision?: string;
}
export interface WorkspaceDocumentContentPage {
	id: string;
	workspaceId: string;
	organizationId: string;
	sourceKind: "workspace_document";
	filename: string;
	mimeType: string;
	status: "READY";
	text: string;
	revision: string;
	contentHash: string;
	offset: number;
	limit: number;
	totalCharacters: number;
	totalBytes: number;
	nextOffset: number | null;
	truncated: boolean;
	offsetUnit: "unicode_code_points";
	readMode: "direct";
	historicalVersionsAvailable: false;
}
export interface WorkspaceDocumentListPage {
	documents: {
		id: string;
		filename: string;
		mimeType: string;
		status: string;
		updatedAt: string;
	}[];
	total: number;
	nextOffset: number | null;
	/** Inserts/deletes between requests can shift offsets. */
	paginationMode: "live_offset";
	snapshotConsistent: false;
}
export interface ListWorkspaceDocumentsOptions {
	org?: string;
	offset?: number;
	limit?: number;
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

	/** Discover IDs/status with live offset pagination, not a snapshot; requires no AI provider. */
	listDocuments(
		workspaceId: string,
		options: ListWorkspaceDocumentsOptions = {},
	): Promise<WorkspaceDocumentListPage> {
		return this.http.get(
			`/workspaces/${encodeURIComponent(workspaceId)}/documents${buildQuery(options)}`,
		);
	}

	/** Read one bounded page. Pin expectedRevision on every continuation; stale revisions return 409. */
	readDocument(
		workspaceId: string,
		documentId: string,
		options: ReadWorkspaceDocumentOptions = {},
	): Promise<WorkspaceDocumentContentPage> {
		return this.http.get(
			`/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(documentId)}/content${buildQuery(options)}`,
		);
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
