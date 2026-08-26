import type { FabricHttpClient } from "../client.js";
import type { FabricExecution, FabricWorkflow, ListOptions } from "../types.js";

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

export class WorkflowsResource {
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
