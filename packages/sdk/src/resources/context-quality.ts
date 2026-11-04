/**
 * Revisioned context reads, deterministic quick checks and saved evaluations.
 * Saved runs export pinned evidence to the project's approved connection.
 * Source authorization is checked by Fabric before evidence is returned.
 */
import type { FabricHttpClient } from "../client.js";
import { FabricError } from "../types.js";

export interface AgentResultSnapshot {
	executionId: string;
	instanceId: string;
	projectId: string;
	workflowId: string | null;
	runId: string | null;
	executionStateSource: "temporal" | "database";
	completedAt: string | null;
	outputHash: string;
	revision: string;
	recordedAnswer: string;
	mode: "recorded-agent-result";
	targetInvoked: false;
	historicalReplay: false;
	retrievalEvidence: "not-evaluated";
	saved: false;
}
export interface AgentResultCheckInput {
	expectedRevision: string;
	requiredPhrases: string[];
	forbiddenPhrases: string[];
}
export type AgentResultCheck = ContextQualityResult & {
	origin: AgentResultSnapshot;
	expectationResults: {
		kind: "required" | "forbidden";
		phrase: string;
		passed: boolean;
	}[];
	expectations: { requiredPhrases: string[]; forbiddenPhrases: string[] };
};

export interface ContextQualityOptions {
	/** Overrides the client's bound project. */
	projectId?: string;
	/** Optional organization slug. The project determines the resource tenant. */
	org?: string;
	signal?: AbortSignal;
}

export interface ContextQualitySourceSnapshot {
	sourceId: string;
	sourceKind: "project_context";
	projectId: string;
	organizationId: string;
	title: string;
	content: string;
	/** SHA-256 hex digest of the exact UTF-8 content returned. */
	revision: string;
	byteLength: number;
	indexingExcluded: boolean;
	readMode: "direct";
}

export interface ContextQualityRecordedCase {
	id: string;
	recordedAnswer: string;
	retrievedSourceIds: string[];
	citedSourceIds: string[];
	expectations: {
		expectedSourceIds: string[];
		requiredPhrases: string[];
		forbiddenPhrases: string[];
	};
}

export interface ContextQualityEvaluationInput {
	version: 1;
	/**
	 * One to eight sources. Content is loaded and authorized server-side, never
	 * accepted from this input. The JSON request is limited to 128 KiB.
	 */
	sources: { sourceId: string; expectedRevision: string }[];
	cases: ContextQualityRecordedCase[];
}

export type ContextQualityCheckId =
	| "recorded-answer-present"
	| "retrieved-sources-available"
	| "cited-sources-available"
	| "citations-retrieved"
	| "expected-sources-available"
	| "expected-sources-retrieved"
	| "expected-sources-cited"
	| "citation-precision"
	| "required-phrases"
	| "forbidden-phrases";

export interface ContextQualityReport {
	version: 1;
	mode: "recorded-output";
	scorerVersion: "fabric-deterministic-context-v1";
	datasetHash: string;
	configurationHash: string;
	snapshotHash: string;
	status: "passed" | "failed";
	counts: {
		cases: number;
		passed: number;
		failed: number;
		integrityFailures: number;
		qualityFailures: number;
	};
	sources: { id: string; revision: string }[];
	cases: {
		id: string;
		status: "passed" | "failed";
		checks: {
			id: ContextQualityCheckId;
			category: "integrity" | "quality";
			status: "passed" | "failed";
		}[];
		retrieval: { precision: number | null; recall: number | null };
		citations: { precision: number | null; recall: number | null };
	}[];
}

export interface ContextQualityResult extends ContextQualityReport {
	projectId: string;
	organizationId: string;
}

export type ContextQualityRunStatus =
	| "QUEUED"
	| "EXPORTING"
	| "DISPATCHING"
	| "RUNNING"
	| "CANCEL_REQUESTED"
	| "SUCCEEDED"
	| "FAILED"
	| "CANCELLED"
	| "RECONCILIATION_REQUIRED";

export type ContextQualityCleanupStatus =
	| "NOT_REQUIRED"
	| "PENDING"
	| "CONFIRMED"
	| "BLOCKED";

export interface ContextQualitySavedRun {
	id: string;
	projectId: string;
	organizationId: string;
	name: string;
	status: ContextQualityRunStatus;
	/** Execution success does not mean the report's checks passed. */
	report: ContextQualityReport | null;
	/** Reports and external links may only be shown when this is true. */
	evidenceAvailable: boolean;
	sourceRefs: { sourceId: string; expectedRevision: string }[];
	errorCode: string | null;
	cleanupStatus: ContextQualityCleanupStatus;
	remoteRunUrl: string | null;
	mlflowRunUrl: string | null;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
}

export interface ContextQualityRunCapabilities {
	configured: boolean;
	canCreate: boolean;
	canCancel: boolean;
	canConfigure: boolean;
	bindingId?: string;
	reason: string | null;
}

export interface ContextQualityCreateRunInput {
	bindingId: string;
	/** Reuse this key when reconciling an ambiguous create response. */
	idempotencyKey: string;
	name?: string;
	evaluation: ContextQualityEvaluationInput;
}

export interface ContextQualityRunComparison {
	baseline: ContextQualitySavedRun;
	candidate: ContextQualitySavedRun;
	compatible: boolean;
	differences: { dataset: boolean; configuration: boolean; scorer: boolean };
	passedDelta: number | null;
}

export interface ContextQualityRunListOptions extends ContextQualityOptions {
	cursor?: string;
	limit?: number;
}

export interface ContextQualityRunResponse {
	run: ContextQualitySavedRun;
}

export interface ContextQualityRunList {
	runs: ContextQualitySavedRun[];
	nextCursor: string | null;
}

/** Durable operations use the same project binding as direct context checks. */
export class ContextQualityRunsResource {
	constructor(
		private readonly http: FabricHttpClient,
		private readonly path: (
			options: ContextQualityOptions,
			suffix: string,
		) => string,
	) {}

	capabilities(
		options: ContextQualityOptions = {},
	): Promise<ContextQualityRunCapabilities> {
		return this.http.request(
			"GET",
			this.path(options, "/runs/capabilities"),
			{ signal: options.signal },
		);
	}

	create(
		input: ContextQualityCreateRunInput,
		options: ContextQualityOptions = {},
	): Promise<ContextQualityRunResponse> {
		if (!input.idempotencyKey?.trim()) {
			throw new FabricError(
				"A stable idempotency key is required to create a saved evaluation.",
				0,
				"MISSING_IDEMPOTENCY_KEY",
			);
		}
		return this.http.request("POST", this.path(options, "/runs"), {
			body: input,
			idempotencyKey: input.idempotencyKey,
			signal: options.signal,
			retry: { maxRetries: 0 },
		});
	}

	list(
		options: ContextQualityRunListOptions = {},
	): Promise<ContextQualityRunList> {
		const path = this.path(options, "/runs");
		const query = new URLSearchParams();
		if (options.cursor !== undefined) {
			query.set("cursor", options.cursor);
		}
		if (options.limit !== undefined) {
			query.set("limit", String(options.limit));
		}
		return this.http.request(
			"GET",
			`${path}${query.size ? `${path.includes("?") ? "&" : "?"}${query}` : ""}`,
			{ signal: options.signal },
		);
	}

	get(
		runId: string,
		options: ContextQualityOptions = {},
	): Promise<ContextQualityRunResponse> {
		return this.http.request(
			"GET",
			this.path(options, `/runs/${encodeURIComponent(runId)}`),
			{ signal: options.signal },
		);
	}

	/** Requests cancellation; only a CANCELLED status confirms it stopped. */
	cancel(
		runId: string,
		options: ContextQualityOptions = {},
	): Promise<ContextQualityRunResponse> {
		return this.http.request(
			"POST",
			this.path(options, `/runs/${encodeURIComponent(runId)}/cancel`),
			{ signal: options.signal, retry: { maxRetries: 0 } },
		);
	}

	compare(
		baselineId: string,
		candidateId: string,
		options: ContextQualityOptions = {},
	): Promise<ContextQualityRunComparison> {
		const path = this.path(options, "/runs/compare");
		const query = new URLSearchParams({ baselineId, candidateId });
		return this.http.request(
			"GET",
			`${path}${path.includes("?") ? "&" : "?"}${query}`,
			{ signal: options.signal },
		);
	}
}

export class ContextQualityResource {
	readonly runs: ContextQualityRunsResource;
	constructor(private readonly http: FabricHttpClient) {
		this.runs = new ContextQualityRunsResource(http, (options, suffix) =>
			this.path(options, suffix),
		);
	}

	/** Owner-only current recorded output. No invocation or shared evaluation save. */
	inspectAgentResult(
		executionId: string,
		options: ContextQualityOptions = {},
	): Promise<AgentResultSnapshot> {
		return this.http.request(
			"GET",
			this.path(
				options,
				`/agent-results/${encodeURIComponent(executionId)}`,
			),
			{ signal: options.signal },
		);
	}
	/** Reloads the server's actual pinned answer; client-supplied answers are not accepted. */
	checkAgentResult(
		executionId: string,
		input: AgentResultCheckInput,
		options: ContextQualityOptions = {},
	): Promise<AgentResultCheck> {
		return this.http.request(
			"POST",
			this.path(
				options,
				`/agent-results/${encodeURIComponent(executionId)}/evaluate`,
			),
			{ body: input, signal: options.signal, retry: { maxRetries: 0 } },
		);
	}
	/** Read an authorized source directly, including STORE_ONLY sources. */
	inspect(
		sourceId: string,
		options: ContextQualityOptions = {},
	): Promise<ContextQualitySourceSnapshot> {
		return this.http.request<ContextQualitySourceSnapshot>(
			"GET",
			this.path(options, `/sources/${encodeURIComponent(sourceId)}`),
			{ signal: options.signal },
		);
	}

	/**
	 * Score supplied recorded answers against revision-pinned authorized sources.
	 * Results contain hashes and check outcomes, without source/answer content.
	 * This is a bounded synchronous check, not a persisted run or live AI replay.
	 */
	evaluate(
		input: ContextQualityEvaluationInput,
		options: ContextQualityOptions = {},
	): Promise<ContextQualityResult> {
		return this.http.request<ContextQualityResult>(
			"POST",
			this.path(options, "/evaluate"),
			{
				body: input,
				signal: options.signal,
				retry: { maxRetries: 0 },
			},
		);
	}

	private path(options: ContextQualityOptions, suffix: string): string {
		if (this.http.defaults.personal) {
			throw new FabricError(
				"Context quality requires an organization project.",
				0,
				"INVALID_CONTEXT",
			);
		}
		const projectId = options.projectId ?? this.http.defaults.project;
		if (!projectId?.trim()) {
			throw new FabricError(
				"A project ID is required for context quality.",
				0,
				"MISSING_PROJECT",
			);
		}
		const org = options.org
			? `?org=${encodeURIComponent(options.org)}`
			: "";
		return `/projects/${encodeURIComponent(projectId)}/context-quality${suffix}${org}`;
	}
}
