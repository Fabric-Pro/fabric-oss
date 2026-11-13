import type { FabricHttpClient } from "../client.js";
import type {
	FabricDocument,
	FabricDocumentStatus,
	FabricDocumentSummary,
	FabricDocumentWriteStatus,
	FabricFeature,
	FabricProject,
	FabricTask,
	ListOptions,
} from "../types.js";

export type { FabricDocumentStatus, FabricDocumentWriteStatus };

/**
 * `FabricError.code` values the document routes answer with. A hand-kept
 * mirror of the server's codes: the strings are the public contract.
 */
export const DOCUMENT_ERROR_CODES = {
	/**
	 * 409 from `updateDocument`: the document changed since the read that
	 * `expectedVersion` and `expectedContentHash` came from. Read it again
	 * and retry on top of the newer body.
	 */
	DOCUMENT_VERSION_CONFLICT: "DOCUMENT_VERSION_CONFLICT",
	/**
	 * 409 from `updateDocument`: a generation run is queued for or writing a
	 * Proposal, so its content and status are refused until the run ends.
	 * A title-only update is still accepted.
	 */
	DOCUMENT_GENERATION_IN_PROGRESS: "DOCUMENT_GENERATION_IN_PROGRESS",
	/**
	 * 400 from `createDocument` or `updateDocument`: QUEUED and GENERATING
	 * are set by generation runs only.
	 */
	DOCUMENT_STATUS_GENERATION_OWNED: "DOCUMENT_STATUS_GENERATION_OWNED",
	/**
	 * 409 from `updateDocument`: an integration contract's status belongs to
	 * its discovery run, so a changed status is refused. Its content and
	 * title can still be updated.
	 */
	INTEGRATION_CONTRACT_STATUS_MANAGED: "INTEGRATION_CONTRACT_STATUS_MANAGED",
} as const;

export type FabricDocumentErrorCode =
	(typeof DOCUMENT_ERROR_CODES)[keyof typeof DOCUMENT_ERROR_CODES];

export type FabricDocumentType =
	| "GENERAL"
	| "PRD"
	| "PROPOSAL"
	| "BUSINESS_CASE"
	| "ARCHITECTURE"
	| "TECHNICAL_SPEC"
	| "USER_STORY"
	| "API_SPEC";

export interface ListDocumentsOptions extends ListOptions {
	type?: FabricDocumentType;
	status?: FabricDocumentStatus;
}

export interface CreateDocumentOptions {
	type: FabricDocumentType;
	title: string;
	content: string;
	status?: FabricDocumentWriteStatus;
	org?: string;
	personal?: boolean;
}

export interface UpdateDocumentOptions {
	title?: string;
	content?: string;
	status?: FabricDocumentWriteStatus;
	changeDescription?: string;
	/**
	 * The `version` of the document this update is based on. Send it with
	 * `expectedContentHash`, or send neither (the server answers 400 to
	 * one alone). With both, an update made after a newer save is refused
	 * with 409 `DOCUMENT_VERSION_CONFLICT` instead of overwriting it.
	 *
	 * Take both from `getDocument`, or from the document the previous
	 * `updateDocument` returned.
	 */
	expectedVersion?: number;
	/**
	 * The `contentHash` of the document this update is based on; see
	 * `expectedVersion`. Use the value the server returned rather than
	 * hashing the body you sent: the saved body can differ from it, for
	 * example when the document holds a visual slot Fabric manages.
	 */
	expectedContentHash?: string;
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

/**
 * A named Coding Instructions set: its own instructions, applying to the code
 * repositories chosen for it. Every project has one default set.
 */
export interface InstructionSet {
	id: string;
	name: string;
	/** Stable; names the set's folders and plugin. */
	slug: string;
	isDefault: boolean;
	/** The code repositories it applies to (ids of `listCodeRepositories`). */
	repositoryIntegrationIds: string[];
	/**
	 * The set's folder in the project's instructions: `instructions/<slug>/`,
	 * or `""` for the default set (the root). A set's files are the ones
	 * under it, relative to it.
	 */
	folder: string;
	/** Folders under `folder` that are other sets' (the default set's only). */
	excludedFolders: string[];
}

/** A repository connected to a project that holds the software being built. */
export interface ProjectCodeRepository {
	id: string;
	provider: "GITHUB" | "GITLAB" | "AZURE_DEVOPS";
	/** `owner/name`. */
	name: string;
	/** Credential-free HTTPS address; the clone uses the developer's own git sign-in. */
	cloneUrl: string;
	defaultBranch: string;
	roleTag: string | null;
	/** Its folder in the agent workspace: `repos/<folder>`. */
	folder: string;
}

export class ProjectsResource {
	constructor(private readonly http: FabricHttpClient) {}

	/** The project's Coding Instructions sets, the default set first. */
	listInstructionSets(
		projectId: string,
		options: { org?: string } = {},
	): Promise<{ sets: InstructionSet[] }> {
		const q = options.org ? `?org=${encodeURIComponent(options.org)}` : "";
		return this.http.get<{ sets: InstructionSet[] }>(
			`/projects/${encodeURIComponent(projectId)}/instructions/sets${q}`,
		);
	}

	/**
	 * Create a Coding Instructions set for chosen code repositories. Needs a
	 * key with `projects:write` whose owner may edit the project's Coding
	 * Instructions. The slug comes from the name unless given, and never
	 * changes. A refusal carries `code` (`SLUG_TAKEN`, `REPOSITORY_NOT_FOUND`,
	 * `REPOSITORY_IS_INSTRUCTIONS_SOURCE`, `INVALID_SET_NAME`).
	 */
	createInstructionSet(
		projectId: string,
		input: {
			name: string;
			slug?: string;
			repositoryIntegrationIds?: string[];
		},
		options: { org?: string } = {},
	): Promise<{ set: InstructionSet }> {
		const q = options.org ? `?org=${encodeURIComponent(options.org)}` : "";
		return this.http.post<{ set: InstructionSet }>(
			`/projects/${encodeURIComponent(projectId)}/instructions/sets${q}`,
			input,
		);
	}

	/**
	 * Rename a set and/or replace its code repositories (the full list).
	 * Absent fields stay as they are; the slug never changes.
	 */
	updateInstructionSet(
		projectId: string,
		setId: string,
		input: { name?: string; repositoryIntegrationIds?: string[] },
		options: { org?: string } = {},
	): Promise<{ set: InstructionSet }> {
		const q = options.org ? `?org=${encodeURIComponent(options.org)}` : "";
		return this.http.patch<{ set: InstructionSet }>(
			`/projects/${encodeURIComponent(projectId)}/instructions/sets/${encodeURIComponent(setId)}${q}`,
			input,
		);
	}

	/**
	 * Delete a set from Fabric. Its files stay in the instructions
	 * repository; the default set cannot be deleted (`DEFAULT_SET_UNDELETABLE`).
	 */
	deleteInstructionSet(
		projectId: string,
		setId: string,
		options: { org?: string } = {},
	): Promise<{ id: string; deleted: true }> {
		const q = options.org ? `?org=${encodeURIComponent(options.org)}` : "";
		return this.http.delete<{ id: string; deleted: true }>(
			`/projects/${encodeURIComponent(projectId)}/instructions/sets/${encodeURIComponent(setId)}${q}`,
		);
	}

	/** The Coding Instructions plugin's name in coding tools (`/<name>:<skill>`). */
	getPluginName(
		projectId: string,
		options: { org?: string } = {},
	): Promise<{ name: string }> {
		const q = options.org ? `?org=${encodeURIComponent(options.org)}` : "";
		return this.http.get<{ name: string }>(
			`/projects/${encodeURIComponent(projectId)}/instructions/plugin-name${q}`,
		);
	}

	/**
	 * The project's code repositories: every connected repository except the
	 * one its Coding Instructions read from.
	 */
	listCodeRepositories(
		projectId: string,
		options: { org?: string } = {},
	): Promise<{ repositories: ProjectCodeRepository[] }> {
		const q = options.org ? `?org=${encodeURIComponent(options.org)}` : "";
		return this.http.get<{ repositories: ProjectCodeRepository[] }>(
			`/projects/${encodeURIComponent(projectId)}/code-repositories${q}`,
		);
	}

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
