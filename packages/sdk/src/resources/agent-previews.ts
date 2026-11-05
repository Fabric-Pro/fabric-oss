import type { FabricHttpClient } from "../client.js";

export interface AgentPreviewDraft {
	instanceId?: string;
	name?: string;
	instructions: string;
	projectId?: string;
	workspaceIds?: string[];
	workspaceDocumentFilters?: Array<{
		workspaceId: string;
		documentIds: string[];
	}>;
	skillIds?: string[];
	capabilityIds?: string[];
	mcpConfigIds?: string[];
	integrationIds?: string[];
	executionMode?: "single_turn" | "goal_oriented";
	goal?: string;
	maxIterations?: number;
	expectedOutput?: string;
	model?: string;
}
export interface AgentPreviewStartInput {
	draft: AgentPreviewDraft;
	userMessage: string;
	/** Reuse this UUID only when retrying the exact same request. */
	idempotencyKey: string;
	history?: Array<{ role: "user" | "assistant"; content: string }>;
}
export interface AgentPreviewOptions {
	org?: string;
	runId?: string;
}
export interface AgentPreviewResult {
	workflowId: string;
	runId: string;
	draftHash: string;
	state: {
		status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
		phase: string;
		response?: string;
		error?: string;
		draftHash: string;
		toolCalls: Array<{
			id: string;
			name: string;
			status: "success" | "error";
			durationMs: number;
			message?: string;
		}>;
		sources: Array<{
			id: string;
			title: string;
			kind: string;
			revision?: string;
			truncated?: boolean;
		}>;
	};
}
export interface AgentPreviewCancelResult {
	workflowId: string;
	runId: string;
	requested: boolean;
}
const query = (options: AgentPreviewOptions) => {
	const params = new URLSearchParams();
	if (options.org) {
		params.set("org", options.org);
	}
	if (options.runId) {
		params.set("runId", options.runId);
	}
	return params.size ? `?${params}` : "";
};
/** Read-only single-turn draft tests. Goal loops and external connections require saved runs. */
export class AgentPreviewsResource {
	constructor(private readonly http: FabricHttpClient) {}
	start(
		input: AgentPreviewStartInput,
		options: Pick<AgentPreviewOptions, "org"> = {},
	): Promise<AgentPreviewResult> {
		return this.http.post(`/agent-previews${query(options)}`, input, {
			retry: { maxRetries: 0 },
		});
	}
	get(
		workflowId: string,
		options: AgentPreviewOptions = {},
	): Promise<AgentPreviewResult> {
		return this.http.get(
			`/agent-previews/${encodeURIComponent(workflowId)}${query(options)}`,
		);
	}
	/** A cancellation request is not a terminal outcome; inspect the preview afterwards. */
	cancel(
		workflowId: string,
		options: AgentPreviewOptions = {},
	): Promise<AgentPreviewCancelResult> {
		return this.http.post(
			`/agent-previews/${encodeURIComponent(workflowId)}/cancel${query(options)}`,
			{},
			{ retry: { maxRetries: 0 } },
		);
	}
}
