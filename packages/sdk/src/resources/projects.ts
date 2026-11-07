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
import {
	implementationSessionMethods,
	type StartImplementationOptions,
} from "./implementation-sessions.js";
import { privateTriageMethods } from "./triage.js";

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
	/** Proposal visual palette; CLIENT requires the reviewed version from branding.get. */
	proposalBranding?: "CLIENT" | "COMPANY";
	recipientBrandVersion?: number;
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

export interface ProjectDeliverySnapshot {
	version: 1;
	projectId: string;
	observedAt: string;
	work: {
		available: boolean;
		runsAvailable: boolean;
		hasMore: boolean;
		items: Array<{
			id: string;
			identifier: string;
			title: string;
			stage: string;
			sourceRef: string | null;
			dependsOnRefs: string[];
			updatedAt: string;
			tasks: Array<{
				id: string;
				identifier: string;
				title: string;
				isCompleted: boolean;
				agentStatus: string | null;
				artifactType: string | null;
			}>;
			runs: Array<{
				id: string;
				storyTaskId: string | null;
				status: string;
				kind: string;
				createdAt: string;
				startedAt: string | null;
				mergedAt: string | null;
				pullRequestNumber: number | null;
				deliveryEvidence:
					| "PR_MERGED"
					| "PR_OPENED"
					| "NO_MERGE_EVIDENCE";
				deployment: "UNKNOWN";
			}>;
		}>;
	};
	context: {
		available: boolean;
		hasMore: boolean;
		inspected: number;
		indexed: number;
		attention: number;
		excluded: number;
		sources: Array<{
			id: string;
			title: string;
			type: string;
			state:
				| "EXCLUDED"
				| "INDEXED"
				| "STORED"
				| "NEEDS_ATTENTION"
				| "PROCESSING";
			updatedAt: string;
			lastSyncedAt: string | null;
		}>;
	};
	decisions: {
		available: boolean;
		items: Array<{
			id: string;
			identifier: string;
			title: string;
			status: string;
			currentVersion: number;
			updatedAt: string;
		}>;
	};
	documents: {
		available: boolean;
		items: Array<{
			id: string;
			title: string;
			type: string;
			status: string;
			updatedAt: string;
		}>;
	};
	nextAction: {
		kind: "REVIEW_CONTEXT" | "ADD_CONTEXT" | "REVIEW_WORK";
		label: string;
	};
	limitations: {
		deploymentEvidence: "NOT_COLLECTED";
		externalAgentCost: "NOT_REPORTED";
		leadTime: "NOT_COMPUTED";
		relationships: "EXPLICIT_REFERENCES_ONLY";
	};
}

import {
	deliverySignalMethods,
	type ListDeliverySignalsOptions,
} from "./delivery-signals.js";

import { deliverySourceMethods } from "./delivery-sources.js";
export class ProjectsResource {
	constructor(private readonly http: FabricHttpClient) {}

	listTriageRuns(
		...args: Parameters<
			ReturnType<typeof privateTriageMethods>["listTriageRuns"]
		>
	) {
		return privateTriageMethods(this.http).listTriageRuns(...args);
	}

	startTriage(
		...args: Parameters<
			ReturnType<typeof privateTriageMethods>["startTriage"]
		>
	) {
		return privateTriageMethods(this.http).startTriage(...args);
	}

	getTriageRun(
		...args: Parameters<
			ReturnType<typeof privateTriageMethods>["getTriageRun"]
		>
	) {
		return privateTriageMethods(this.http).getTriageRun(...args);
	}

	getTriageResult(
		...args: Parameters<
			ReturnType<typeof privateTriageMethods>["getTriageResult"]
		>
	) {
		return privateTriageMethods(this.http).getTriageResult(...args);
	}

	cancelTriageRun(
		...args: Parameters<
			ReturnType<typeof privateTriageMethods>["cancelTriageRun"]
		>
	) {
		return privateTriageMethods(this.http).cancelTriageRun(...args);
	}

	reviewTriageProposal(
		...args: Parameters<
			ReturnType<typeof privateTriageMethods>["reviewTriageProposal"]
		>
	) {
		return privateTriageMethods(this.http).reviewTriageProposal(...args);
	}

	listDeliverySources(
		...args: Parameters<
			ReturnType<typeof deliverySourceMethods>["listDeliverySources"]
		>
	) {
		return deliverySourceMethods(this.http).listDeliverySources(...args);
	}

	testDeliverySource(
		...args: Parameters<
			ReturnType<typeof deliverySourceMethods>["testDeliverySource"]
		>
	) {
		return deliverySourceMethods(this.http).testDeliverySource(...args);
	}

	configureDeliverySource(
		...args: Parameters<
			ReturnType<typeof deliverySourceMethods>["configureDeliverySource"]
		>
	) {
		return deliverySourceMethods(this.http).configureDeliverySource(
			...args,
		);
	}

	pauseDeliverySource(
		...args: Parameters<
			ReturnType<typeof deliverySourceMethods>["pauseDeliverySource"]
		>
	) {
		return deliverySourceMethods(this.http).pauseDeliverySource(...args);
	}

	resumeDeliverySource(
		...args: Parameters<
			ReturnType<typeof deliverySourceMethods>["resumeDeliverySource"]
		>
	) {
		return deliverySourceMethods(this.http).resumeDeliverySource(...args);
	}

	disconnectDeliverySource(
		...args: Parameters<
			ReturnType<typeof deliverySourceMethods>["disconnectDeliverySource"]
		>
	) {
		return deliverySourceMethods(this.http).disconnectDeliverySource(
			...args,
		);
	}

	startDeliverySourceCapture(
		...args: Parameters<
			ReturnType<
				typeof deliverySourceMethods
			>["startDeliverySourceCapture"]
		>
	) {
		return deliverySourceMethods(this.http).startDeliverySourceCapture(
			...args,
		);
	}

	getDeliverySourceCapture(
		...args: Parameters<
			ReturnType<typeof deliverySourceMethods>["getDeliverySourceCapture"]
		>
	) {
		return deliverySourceMethods(this.http).getDeliverySourceCapture(
			...args,
		);
	}

	cancelDeliverySourceCapture(
		...args: Parameters<
			ReturnType<
				typeof deliverySourceMethods
			>["cancelDeliverySourceCapture"]
		>
	) {
		return deliverySourceMethods(this.http).cancelDeliverySourceCapture(
			...args,
		);
	}

	listDeliverySourceObservations(
		...args: Parameters<
			ReturnType<
				typeof deliverySourceMethods
			>["listDeliverySourceObservations"]
		>
	) {
		return deliverySourceMethods(this.http).listDeliverySourceObservations(
			...args,
		);
	}

	getDeliverySourceEvidence(
		...args: Parameters<
			ReturnType<
				typeof deliverySourceMethods
			>["getDeliverySourceEvidence"]
		>
	) {
		return deliverySourceMethods(this.http).getDeliverySourceEvidence(
			...args,
		);
	}

	listDeliverySignals(
		projectId: string,
		options: ListDeliverySignalsOptions = {},
	) {
		return deliverySignalMethods(this.http).listDeliverySignals(
			projectId,
			options,
		);
	}
	getDeliverySignal(
		projectId: string,
		id: string,
		options: { org?: string } = {},
	) {
		return deliverySignalMethods(this.http).getDeliverySignal(
			projectId,
			id,
			options,
		);
	}
	getDeliverySignalSourceConfiguration(
		projectId: string,
		options: { org?: string } = {},
	) {
		return deliverySignalMethods(
			this.http,
		).getDeliverySignalSourceConfiguration(projectId, options);
	}
	listImplementationSessions(
		...args: Parameters<
			ReturnType<
				typeof implementationSessionMethods
			>["listImplementationSessions"]
		>
	) {
		return implementationSessionMethods(
			this.http,
		).listImplementationSessions(...args);
	}
	getImplementationSession(
		...args: Parameters<
			ReturnType<
				typeof implementationSessionMethods
			>["getImplementationSession"]
		>
	) {
		return implementationSessionMethods(this.http).getImplementationSession(
			...args,
		);
	}
	startImplementationSession(
		projectId: string,
		options: StartImplementationOptions,
	) {
		return implementationSessionMethods(
			this.http,
		).startImplementationSession(projectId, options);
	}
	cancelImplementationSession(
		...args: Parameters<
			ReturnType<
				typeof implementationSessionMethods
			>["cancelImplementationSession"]
		>
	) {
		return implementationSessionMethods(
			this.http,
		).cancelImplementationSession(...args);
	}
	followUpImplementationSession(
		...args: Parameters<
			ReturnType<
				typeof implementationSessionMethods
			>["followUpImplementationSession"]
		>
	) {
		return implementationSessionMethods(
			this.http,
		).followUpImplementationSession(...args);
	}
	getImplementationMessages(
		...args: Parameters<
			ReturnType<
				typeof implementationSessionMethods
			>["getImplementationMessages"]
		>
	) {
		return implementationSessionMethods(
			this.http,
		).getImplementationMessages(...args);
	}

	/** Current project evidence; merging a PR does not establish deployment. */
	delivery(
		projectId: string,
		options: { org?: string } = {},
	): Promise<ProjectDeliverySnapshot> {
		const query = options.org
			? `?org=${encodeURIComponent(options.org)}`
			: "";
		return this.http.get(
			`/projects/${encodeURIComponent(projectId)}/delivery${query}`,
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
			{ retry: { maxRetries: 0 } },
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
