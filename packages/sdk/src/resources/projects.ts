import type { FabricHttpClient } from "../client.js";
import type {
	FabricDocument,
	FabricDocumentSummary,
	FabricFeature,
	FabricProject,
	FabricTask,
	ListOptions,
} from "../types.js";

export type FabricDocumentType =
	| "GENERAL"
	| "PRD"
	| "PROPOSAL"
	| "BUSINESS_CASE"
	| "ARCHITECTURE"
	| "TECHNICAL_SPEC"
	| "USER_STORY"
	| "API_SPEC";

export type FabricDocumentStatus =
	| "DRAFT"
	| "GENERATING"
	| "IN_PROGRESS"
	| "REVIEW"
	| "COMPLETE"
	| "FAILED";

export interface ListDocumentsOptions extends ListOptions {
	type?: FabricDocumentType;
	status?: FabricDocumentStatus;
}

export interface CreateDocumentOptions {
	type: FabricDocumentType;
	title: string;
	content: string;
	status?: FabricDocumentStatus;
	org?: string;
	personal?: boolean;
}

export interface UpdateDocumentOptions {
	title?: string;
	content?: string;
	status?: FabricDocumentStatus;
	changeDescription?: string;
	org?: string;
	personal?: boolean;
}

export interface ListProjectsOptions extends ListOptions {
	status?: "DRAFT" | "ACTIVE" | "COMPLETED" | "ARCHIVED";
}

export interface ListFeaturesOptions extends ListOptions {
	priority?: "P0_CRITICAL" | "P1_HIGH" | "P2_MEDIUM" | "P3_LOW";
	statusId?: string;
	assigneeId?: string;
}

export interface CreateProjectOptions {
	name: string;
	description?: string;
	repositoryUrl?: string;
	color?: string;
	icon?: string;
	status?: "DRAFT" | "ACTIVE";
	org?: string;
	personal?: boolean;
}

export interface CreateFeatureOptions {
	title: string;
	description?: string;
	acceptanceCriteria?: string;
	priority?: "P0_CRITICAL" | "P1_HIGH" | "P2_MEDIUM" | "P3_LOW";
	org?: string;
	personal?: boolean;
}

export interface UpdateProjectOptions {
	name?: string;
	description?: string;
	repositoryUrl?: string;
	color?: string;
	icon?: string;
	status?: "DRAFT" | "ACTIVE" | "COMPLETED" | "ARCHIVED";
	org?: string;
	personal?: boolean;
}

export interface UpdateFeatureOptions {
	title?: string;
	description?: string | null;
	acceptanceCriteria?: string | null;
	priority?: "P0_CRITICAL" | "P1_HIGH" | "P2_MEDIUM" | "P3_LOW";
	/** Set or clear the human assignee. Pass `null` to unassign. */
	assigneeId?: string | null;
	org?: string;
	personal?: boolean;
}

export class ProjectsResource {
	constructor(private readonly http: FabricHttpClient) {}

	list(options: ListProjectsOptions = {}): Promise<FabricProject[]> {
		const q = buildQuery(options);
		return this.http.get<FabricProject[]>(`/projects${q}`);
	}

	get(
		id: string,
		options: { org?: string; personal?: boolean } = {},
	): Promise<FabricProject> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const q = params.toString() ? `?${params.toString()}` : "";
		return this.http.get<FabricProject>(`/projects/${id}${q}`);
	}

	listFeatures(
		projectId: string,
		options: ListFeaturesOptions = {},
	): Promise<FabricFeature[]> {
		const q = buildQuery(options);
		return this.http.get<FabricFeature[]>(
			`/projects/${projectId}/features${q}`,
		);
	}

	getFeature(
		projectId: string,
		featureId: string,
		options: { org?: string; personal?: boolean } = {},
	): Promise<FabricFeature> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const q = params.toString() ? `?${params.toString()}` : "";
		return this.http.get<FabricFeature>(
			`/projects/${projectId}/features/${featureId}${q}`,
		);
	}

	async create(options: CreateProjectOptions): Promise<FabricProject> {
		const { org, personal, ...body } = options;
		const params = new URLSearchParams();
		if (org) {
			params.set("org", org);
		}
		if (personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.post<FabricProject>(
			`/projects${qs ? `?${qs}` : ""}`,
			body,
		);
	}

	listTasks(
		projectId: string,
		featureId: string,
		options: { org?: string; personal?: boolean } = {},
	): Promise<FabricTask[]> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const q = params.toString() ? `?${params.toString()}` : "";
		return this.http.get<FabricTask[]>(
			`/projects/${projectId}/features/${featureId}/tasks${q}`,
		);
	}

	async createFeature(
		projectId: string,
		options: CreateFeatureOptions,
	): Promise<FabricFeature> {
		const { org, personal, ...body } = options;
		const params = new URLSearchParams();
		if (org) {
			params.set("org", org);
		}
		if (personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.post<FabricFeature>(
			`/projects/${projectId}/features${qs ? `?${qs}` : ""}`,
			body,
		);
	}

	async update(
		id: string,
		options: UpdateProjectOptions,
	): Promise<FabricProject> {
		const { org, personal, ...body } = options;
		const params = new URLSearchParams();
		if (org) {
			params.set("org", org);
		}
		if (personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.patch<FabricProject>(
			`/projects/${id}${qs ? `?${qs}` : ""}`,
			body,
		);
	}

	async updateFeature(
		projectId: string,
		featureId: string,
		options: UpdateFeatureOptions,
	): Promise<FabricFeature> {
		const { org, personal, ...body } = options;
		const params = new URLSearchParams();
		if (org) {
			params.set("org", org);
		}
		if (personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.patch<FabricFeature>(
			`/projects/${projectId}/features/${featureId}${qs ? `?${qs}` : ""}`,
			body,
		);
	}

	/**
	 * Assign a feature to a human (by assigneeId) or clear the assignment.
	 * Sugar over `updateFeature` — same backend route, narrower surface.
	 */
	assignFeature(
		projectId: string,
		featureId: string,
		assigneeId: string | null,
		options: { org?: string; personal?: boolean } = {},
	): Promise<FabricFeature> {
		return this.updateFeature(projectId, featureId, {
			assigneeId,
			...options,
		});
	}

	/**
	 * List documents attached to a project (PRDs, technical specs,
	 * architecture notes, etc.). Returns summary records — call
	 * `getDocument` for the full markdown content.
	 */
	listDocuments(
		projectId: string,
		options: ListDocumentsOptions = {},
	): Promise<FabricDocumentSummary[]> {
		const q = buildQuery(options);
		return this.http.get<FabricDocumentSummary[]>(
			`/projects/${projectId}/documents${q}`,
		);
	}

	/**
	 * Get the full document including its markdown content. Document IDs
	 * are globally unique — the v1 route is /documents/:id, not project-
	 * nested, since each document already pins its parent project.
	 */
	getDocument(
		documentId: string,
		options: { org?: string; personal?: boolean } = {},
	): Promise<FabricDocument> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.get<FabricDocument>(
			`/documents/${documentId}${qs ? `?${qs}` : ""}`,
		);
	}

	async createDocument(
		projectId: string,
		options: CreateDocumentOptions,
	): Promise<FabricDocument> {
		const { org, personal, ...body } = options;
		const params = new URLSearchParams();
		if (org) {
			params.set("org", org);
		}
		if (personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.post<FabricDocument>(
			`/projects/${projectId}/documents${qs ? `?${qs}` : ""}`,
			body,
		);
	}

	async updateDocument(
		documentId: string,
		options: UpdateDocumentOptions,
	): Promise<FabricDocument> {
		const { org, personal, ...body } = options;
		const params = new URLSearchParams();
		if (org) {
			params.set("org", org);
		}
		if (personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.patch<FabricDocument>(
			`/documents/${documentId}${qs ? `?${qs}` : ""}`,
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
