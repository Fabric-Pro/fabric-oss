import type { FabricHttpClient } from "../client.js";
import type { FabricExecution, FabricWorkflow, ListOptions } from "../types.js";
import type {
	ResultQualityChecks,
	ResultQualityGrade,
} from "./result-quality.js";

export interface ListWorkflowsOptions extends ListOptions {
	status?: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
	triggerType?: "MANUAL" | "SCHEDULED" | "WEBHOOK" | "EVENT";
}

export interface TriggerOptions {
	org?: string;
	personal?: boolean;
	triggerInput?: Record<string, unknown>;
	/** @deprecated Use triggerInput instead */
	triggerData?: Record<string, unknown>;
	variables?: Record<string, unknown>;
}

export type FabricExecutionStatus =
	| "PENDING"
	| "RUNNING"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED"
	| "TIMED_OUT";

export interface ListExecutionsOptions extends ListOptions {
	status?: FabricExecutionStatus;
}

export interface WorkflowStarter {
	id:
		| "delivery-brief"
		| "action-plan"
		| "release-notes"
		| "decision-digest"
		| "risk-review";
	name: string;
	description: string;
}
export interface WorkflowReadiness {
	ready: boolean;
	errors: string[];
	warnings: string[];
	checks: {
		nodeId: string;
		label: string;
		status: "configured" | "needs-setup" | "runtime-check";
		message: string;
	}[];
	checkedAt: string;
	limitation: string;
}
export interface WorkflowScheduleState {
	configurationIssue: string | null;
	workflowId: string;
	status: string;
	draft: {
		cron: string;
		timezone?: string | null;
		description: string;
	} | null;
	published: {
		cron: string;
		timezone?: string | null;
		description: string;
	} | null;
	publishRequired: boolean;
	state:
		| "active"
		| "paused"
		| "inactive"
		| "missing"
		| "out-of-sync"
		| "unavailable"
		| "unverified";
	nextRunAt: string | null;
}
export interface WorkflowVersionSummary {
	id: string;
	version: number;
	changelog: string | null;
	isPublished: boolean;
	publishedAt: string | null;
	createdAt: string;
}
export interface WorkflowLifecycleResult {
	workflowId: string;
	success?: boolean;
	status?: string;
	version?: number;
	message?: string;
	validation?: { valid: boolean; errors: string[]; warnings: string[] };
	schedule?: { outcome: string; reason?: string; cron?: string };
	webhookUrl?: string;
	webhookSecret?: string;
}
export interface WorkflowCheck extends ResultQualityChecks {
	id: string;
	revision: string;
	name: string;
	nodeId: string;
	baselineExecutionId: string;
	baselineVersion: number;
	baselineRevision: string;
	createdAt: string;
	requiredPhrases: string[];
	forbiddenPhrases: string[];
}
export interface WorkflowResultInspection {
	workflowId: string;
	executionId: string;
	nodeId: string;
	version: number;
	completedAt: string | null;
	outputHash: string;
	revision: string;
	recordedAnswer: string;
	mode: "recorded-workflow-result";
	targetInvoked: false;
	retrievalEvidence: "not-evaluated";
}
export interface WorkflowCheckScore {
	quality?: ResultQualityGrade;
	report: {
		status: "passed" | "failed" | "not-assessed";
		scorerVersion: string;
		counts?: { cases: number; passed: number; failed: number };
		[key: string]: unknown;
	};
	expectations: {
		kind: "required" | "forbidden";
		phrase: string;
		passed: boolean;
	}[];
}
export interface WorkflowCheckComparison {
	check: WorkflowCheck;
	baseline: {
		executionId: string;
		version: number;
		status: "passed" | "failed" | "not-assessed";
	};
	candidate: WorkflowCheckScore & { executionId: string; version: number };
	change: "unchanged" | "improved" | "regressed";
	targetInvoked: false;
	retrievalEvidence: "not-evaluated";
}
export class WorkflowsResource {
	private resultCheck<T>(
		id: string,
		action: string,
		input: object,
		options: { org?: string },
	): Promise<T> {
		return this.http.request(
			"POST",
			`/workflows/${encodeURIComponent(id)}/checks/${action}${buildQuery(options)}`,
			{ body: input, retry: { maxRetries: 0 } },
		);
	}
	listChecks(
		id: string,
		options: { org?: string } = {},
	): Promise<{ cases: WorkflowCheck[]; canManage: boolean }> {
		return this.http.get(
			`/workflows/${encodeURIComponent(id)}/checks${buildQuery(options)}`,
		);
	}
	inspectResult(
		id: string,
		input: { executionId: string; nodeId: string },
		options: { org?: string } = {},
	): Promise<WorkflowResultInspection> {
		return this.resultCheck(id, "inspect", input, options);
	}
	previewCheck(
		id: string,
		input: {
			executionId: string;
			nodeId: string;
			expectedRevision: string;
		} & ResultQualityChecks,
		options: { org?: string } = {},
	): Promise<WorkflowCheckScore & { saved: false }> {
		return this.resultCheck(id, "preview", input, options);
	}
	saveCheck(
		id: string,
		input: {
			executionId: string;
			nodeId: string;
			expectedRevision: string;
			name: string;
		} & ResultQualityChecks,
		options: { org?: string } = {},
	): Promise<{ check: WorkflowCheck }> {
		return this.resultCheck(id, "save", input, options);
	}
	applyCheck(
		id: string,
		input: {
			checkId: string;
			expectedCaseRevision: string;
			executionId: string;
		},
		options: { org?: string } = {},
	): Promise<WorkflowCheckComparison> {
		return this.resultCheck(id, "apply", input, options);
	}
	removeCheck(
		id: string,
		input: { checkId: string; expectedCaseRevision: string },
		options: { org?: string } = {},
	): Promise<{ removed: true }> {
		return this.resultCheck(id, "remove", input, options);
	}
	private lifecycle(
		id: string,
		action: string,
		input: object,
		options: { org?: string },
	): Promise<WorkflowLifecycleResult> {
		return this.http.request(
			"POST",
			`/workflows/${encodeURIComponent(id)}/${action}${buildQuery(options)}`,
			{ body: input, retry: { maxRetries: 0 } },
		);
	}
	publish(
		id: string,
		input: { changelog?: string; enableWebhook?: boolean } = {},
		options: { org?: string } = {},
	) {
		return this.lifecycle(id, "publish", input, options);
	}
	unpublish(id: string, options: { org?: string } = {}) {
		return this.lifecycle(id, "unpublish", {}, options);
	}
	pause(id: string, options: { org?: string } = {}) {
		return this.lifecycle(id, "pause", {}, options);
	}
	resume(id: string, options: { org?: string } = {}) {
		return this.lifecycle(id, "resume", {}, options);
	}
	rollback(
		id: string,
		targetVersion: number,
		options: { org?: string } = {},
	) {
		return this.lifecycle(id, "rollback", { targetVersion }, options);
	}
	listVersions(
		id: string,
		options: { org?: string; limit?: number; offset?: number } = {},
	): Promise<{ versions: WorkflowVersionSummary[]; total: number }> {
		return this.http.get(
			`/workflows/${encodeURIComponent(id)}/versions${buildQuery(options)}`,
		);
	}
	getSchedule(
		id: string,
		options: { org?: string } = {},
	): Promise<WorkflowScheduleState> {
		return this.http.get(
			`/workflows/${encodeURIComponent(id)}/schedule${buildQuery(options)}`,
		);
	}
	configureSchedule(
		id: string,
		input: { cron: string; timezone?: string },
		options: { org?: string } = {},
	): Promise<{
		workflowId: string;
		saved: true;
		publishRequired: boolean;
		message: string;
	}> {
		return this.http.request(
			"PUT",
			`/workflows/${encodeURIComponent(id)}/schedule${buildQuery(options)}`,
			{ body: input, retry: { maxRetries: 0 } },
		);
	}

	listStarters(options: { org?: string } = {}): Promise<WorkflowStarter[]> {
		return this.http.get(`/workflows/starters${buildQuery(options)}`);
	}
	createFromStarter(
		input: { starterId: WorkflowStarter["id"]; name?: string },
		options: { org?: string } = {},
	): Promise<{ workflow: FabricWorkflow }> {
		return this.http.request(
			"POST",
			`/workflows/starters${buildQuery(options)}`,
			{ body: input, retry: { maxRetries: 0 } },
		);
	}
	checkReadiness(
		id: string,
		options: { org?: string } = {},
	): Promise<WorkflowReadiness> {
		return this.http.get(
			`/workflows/${encodeURIComponent(id)}/readiness${buildQuery(options)}`,
		);
	}

	constructor(private readonly http: FabricHttpClient) {}

	list(options: ListWorkflowsOptions = {}): Promise<FabricWorkflow[]> {
		const q = buildQuery(options);
		return this.http.get<FabricWorkflow[]>(`/workflows${q}`);
	}

	get(
		id: string,
		options: { org?: string; personal?: boolean } = {},
	): Promise<FabricWorkflow> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const q = params.toString() ? `?${params.toString()}` : "";
		return this.http.get<FabricWorkflow>(`/workflows/${id}${q}`);
	}

	trigger(
		id: string,
		options: TriggerOptions = {},
	): Promise<{ executionId: string; workflowId: string; status: string }> {
		const { org, personal, triggerInput, triggerData, variables } = options;
		const params = new URLSearchParams();
		if (org) {
			params.set("org", org);
		}
		if (personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.post(`/workflows/${id}/trigger${qs ? `?${qs}` : ""}`, {
			triggerInput: triggerInput ?? triggerData,
			variables,
		});
	}

	getExecution(
		workflowId: string,
		executionId: string,
		options: { org?: string; personal?: boolean } = {},
	): Promise<FabricExecution> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const q = params.toString() ? `?${params.toString()}` : "";
		return this.http.get<FabricExecution>(
			`/workflows/${workflowId}/executions/${executionId}${q}`,
		);
	}

	/**
	 * List executions for a workflow, scoped to the caller's tenant.
	 * Newest first.
	 */
	listExecutions(
		workflowId: string,
		options: ListExecutionsOptions = {},
	): Promise<FabricExecution[]> {
		const q = buildQuery(options);
		return this.http.get<FabricExecution[]>(
			`/workflows/${workflowId}/executions${q}`,
		);
	}

	/**
	 * Cancel a running execution. Best-effort signals the underlying
	 * Temporal handle; always marks the DB row as CANCELLED. Returns
	 * 409 on the server if the execution is already in a terminal
	 * state — the SDK surfaces that as `FabricError` (status 409).
	 */
	cancelExecution(
		workflowId: string,
		executionId: string,
		options: { org?: string; personal?: boolean } = {},
	): Promise<{ executionId: string; workflowId: string; status: string }> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.post(
			`/workflows/${workflowId}/executions/${executionId}/cancel${qs ? `?${qs}` : ""}`,
			{},
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
