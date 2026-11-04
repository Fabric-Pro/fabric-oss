import type { FabricHttpClient } from "../client.js";
import type { FabricAgentInstanceExecution } from "../types.js";

export interface AgentRunScheduleInput {
	cronExpression: string;
	timezone: string;
	input: { message: string };
	enabled: boolean;
}
export interface AgentRunScheduleState {
	schedule: null | (AgentRunScheduleInput & { id: string });
	schedulingState: "UNKNOWN" | "ACTIVE" | "PAUSED";
}
export interface AgentRunList extends AgentRunScheduleState {
	deployment: null | { id: string; status: string };
	executions: Array<{
		id: string;
		status: string;
		lastRecordedStatus: string;
		queuedAt: string;
		createdAt: string;
		completedAt: string | null;
		duration: number | null;
		error: string | null;
		triggerType: string;
	}>;
}
export interface AgentRunHistoryOptions extends AgentRunOptions {
	instanceId?: string;
	status?: "ACTIVE" | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
	triggerType?: "MANUAL" | "SCHEDULE" | "API" | "WEBHOOK" | "EVENT" | "SLACK";
	from?: string;
	to?: string;
	query?: string;
	cursor?: string;
	limit?: number;
}
export interface AgentRunHistory {
	executions: Array<{
		id: string;
		/** Current owned logical agent version to open. */
		instanceId: string;
		/** Immutable admitted version, or null for legacy runs without admission provenance. */
		executionInstanceId: string | null;
		agentName: string;
		task: string;
		status: string;
		lastRecordedStatus: string;
		queuedAt: string;
		createdAt: string;
		completedAt: string | null;
		duration: number | null;
		triggerType: string;
	}>;
	nextCursor: string | null;
}
export interface AgentRunCancelResult {
	requested: boolean;
	executionId: string;
	status: string;
}
export interface AgentRunOptions {
	org?: string;
}
const query = (options: AgentRunOptions & { limit?: number }) => {
	const params = new URLSearchParams();
	if (options.org) {
		params.set("org", options.org);
	}
	if (options.limit !== undefined) {
		params.set("limit", String(options.limit));
	}
	return params.size ? `?${params}` : "";
};
/** Owner run controls. Invocation remains agents.invokeInstance with explicit API opt-in. */
export class AgentRunsResource {
	constructor(private readonly http: FabricHttpClient) {}
	/** Search bounded run metadata. Continuation is opaque and bound to the actor and filters. */
	search(options: AgentRunHistoryOptions = {}): Promise<AgentRunHistory> {
		const params = new URLSearchParams();
		for (const [name, value] of Object.entries(options)) {
			if (value !== undefined) {
				params.set(name, String(value));
			}
		}
		return this.http.get(`/agent-runs${params.size ? `?${params}` : ""}`);
	}
	list(
		instanceId: string,
		options: AgentRunOptions & { limit?: number } = {},
	): Promise<AgentRunList> {
		return this.http.get(
			`/agent-instances/${encodeURIComponent(instanceId)}/runs${query(options)}`,
		);
	}
	get(
		executionId: string,
		options: AgentRunOptions = {},
	): Promise<FabricAgentInstanceExecution> {
		return this.http.get(
			`/agent-executions/${encodeURIComponent(executionId)}${query(options)}`,
		);
	}
	/** Requests cooperative cancellation; requested:true is not a terminal outcome or an undo. */
	cancel(
		executionId: string,
		options: AgentRunOptions = {},
	): Promise<AgentRunCancelResult> {
		return this.http.post(
			`/agent-executions/${encodeURIComponent(executionId)}/cancel${query(options)}`,
			{},
			{ retry: { maxRetries: 0 } },
		);
	}
	getSchedule(
		instanceId: string,
		options: AgentRunOptions = {},
	): Promise<AgentRunScheduleState> {
		return this.http.get(
			`/agent-instances/${encodeURIComponent(instanceId)}/run-schedule${query(options)}`,
		);
	}
	/** Requires agents:execute + agents:schedule. No automatic transport retry: inspect state after an unresolved acknowledgement. */
	setSchedule(
		instanceId: string,
		input: AgentRunScheduleInput,
		options: AgentRunOptions = {},
	): Promise<AgentRunScheduleState> {
		return this.http.put(
			`/agent-instances/${encodeURIComponent(instanceId)}/run-schedule${query(options)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
}
