import type { FabricHttpClient } from "../client.js";
export interface AgentTestChecks {
	requiredPhrases?: string[];
	forbiddenPhrases?: string[];
}
export interface AgentTestCaseCreateInput {
	instanceId: string;
	name: string;
	input: string;
	checks: AgentTestChecks;
	sourcePreview?: { workflowId: string; runId?: string };
}
export interface AgentTestCaseUpdateInput {
	revision: number;
	name: string;
	input: string;
	checks: AgentTestChecks;
}
export interface AgentTestRunStartInput {
	caseId: string;
	caseRevision: number;
	instanceId: string;
	idempotencyKey: string;
}
export interface AgentTestOptions {
	org?: string;
}
export interface AgentTestListOptions extends AgentTestOptions {
	limit?: number;
	cursor?: string;
}
export interface AgentTestReport {
	version: 1;
	method: "exact-text";
	outputHash: string;
	passed: number;
	total: number;
	results: Array<{
		kind: "required" | "forbidden";
		index: number;
		passed: boolean;
	}>;
	durationMs: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	totalCost: string | null;
}
export interface AgentTestRun {
	id: string;
	requestKey: string;
	caseId: string;
	instanceId: string;
	agentVersion: number;
	caseRevision: number;
	status: "ADMITTING" | "RUNNING" | "COMPLETED" | "CANCELLED" | "ERROR";
	verdict: "PASSED" | "FAILED" | null;
	executionId: string | null;
	errorCode: string | null;
	report: AgentTestReport | null;
	createdAt: string;
	completedAt: string | null;
}
export interface AgentTestCase {
	id: string;
	agentSId: string;
	originInstanceId: string;
	name: string;
	input: string;
	checks: AgentTestChecks;
	revision: number;
	createdAt: string;
	updatedAt: string;
	latestRun: AgentTestRun | null;
}
export interface AgentTestComparison {
	baseline: AgentTestRun;
	candidate: AgentTestRun;
	changes: {
		passed: number;
		total: number;
		verdictChanged: boolean;
		durationMsDelta: number | null;
		costDelta: string | null;
	};
}
function query(options: Record<string, string | number | undefined>) {
	const p = new URLSearchParams();
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) {
			p.set(key, String(value));
		}
	}
	return p.size ? `?${p}` : "";
}
/** Saved regression examples. Runs execute the saved agent with its live connections. */
export class AgentTestsResource {
	constructor(private readonly http: FabricHttpClient) {}
	listCases(
		instanceId: string,
		options: AgentTestListOptions = {},
	): Promise<{ cases: AgentTestCase[]; nextCursor: string | null }> {
		return this.http.get(
			`/agent-tests/cases${query({ instanceId, ...options })}`,
		);
	}
	createCase(
		input: AgentTestCaseCreateInput,
		options: AgentTestOptions = {},
	): Promise<AgentTestCase> {
		return this.http.post(
			`/agent-tests/cases${query({ ...options })}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	updateCase(
		caseId: string,
		input: AgentTestCaseUpdateInput,
		options: AgentTestOptions = {},
	): Promise<AgentTestCase> {
		return this.http.request(
			"PATCH",
			`/agent-tests/cases/${encodeURIComponent(caseId)}${query({ ...options })}`,
			{ body: input, retry: { maxRetries: 0 } },
		);
	}
	archiveCase(
		caseId: string,
		revision: number,
		options: AgentTestOptions = {},
	): Promise<{ archived: true }> {
		return this.http.request(
			"DELETE",
			`/agent-tests/cases/${encodeURIComponent(caseId)}${query({ revision, ...options })}`,
			{ retry: { maxRetries: 0 } },
		);
	}
	start(
		input: AgentTestRunStartInput,
		options: AgentTestOptions = {},
	): Promise<AgentTestRun> {
		return this.http.post(
			`/agent-tests/runs${query({ ...options })}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	get(
		testRunId: string,
		options: AgentTestOptions = {},
	): Promise<AgentTestRun> {
		return this.http.get(
			`/agent-tests/runs/${encodeURIComponent(testRunId)}${query({ ...options })}`,
		);
	}
	listRuns(
		caseId: string,
		options: AgentTestListOptions = {},
	): Promise<{ runs: AgentTestRun[]; nextCursor: string | null }> {
		return this.http.get(
			`/agent-tests/runs${query({ caseId, ...options })}`,
		);
	}
	cancel(
		testRunId: string,
		options: AgentTestOptions = {},
	): Promise<{ requested: boolean; testRun: AgentTestRun }> {
		return this.http.post(
			`/agent-tests/runs/${encodeURIComponent(testRunId)}/cancel${query({ ...options })}`,
			{},
			{ retry: { maxRetries: 0 } },
		);
	}
	compare(
		baselineRunId: string,
		candidateRunId: string,
		options: AgentTestOptions = {},
	): Promise<AgentTestComparison> {
		return this.http.post(
			`/agent-tests/compare${query({ ...options })}`,
			{ baselineRunId, candidateRunId },
			{ retry: { maxRetries: 0 } },
		);
	}
}
