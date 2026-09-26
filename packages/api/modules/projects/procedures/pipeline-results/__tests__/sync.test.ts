/**
 * `projects.pipelineResults.sync` — starts (or joins) the project's
 * `pipeline-results-sync-{projectId}` workflow. Pins that the response carries
 * the RUN id Temporal actually started or joined (`firstExecutionRunId`), which
 * `syncRun` then watches to anchor "this sync finished" to the exact run
 * rather than to a sync-state row's timestamp (Fizzy #2722).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStart = vi.fn();
const mockFindProject = vi.fn();
const mockCountRepos = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: (...a: unknown[]) => mockFindProject(...a) },
		projectRepositoryIntegration: {
			count: (...a: unknown[]) => mockCountRepos(...a),
		},
	},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { start: mockStart } }),
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));

vi.mock("../../../lib/pipeline-results-feature", () => ({
	assertPipelineResultsEnabled: () => undefined,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

const { syncPipelineResultsProcedure, pipelineResultsSyncWorkflowId } =
	await import("../sync");

const context = { user: { id: "user-1" } };

function callSync(input: Record<string, unknown>) {
	return (
		syncPipelineResultsProcedure as unknown as {
			handler: (a: {
				input: unknown;
				context: unknown;
			}) => Promise<unknown>;
		}
	).handler({ input, context });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFindProject.mockResolvedValue({
		id: "p1",
		organizationId: "org-1",
		autoCreateBugsFromFailures: false,
	});
	mockCountRepos.mockResolvedValue(1);
});

describe("pipelineResultsSyncWorkflowId", () => {
	it("is the one id both sync and syncRun derive from a projectId", () => {
		expect(pipelineResultsSyncWorkflowId("p1")).toBe(
			"pipeline-results-sync-p1",
		);
	});
});

describe("syncPipelineResultsProcedure", () => {
	it("returns the handle's firstExecutionRunId as runId", async () => {
		mockStart.mockResolvedValue({
			workflowId: "pipeline-results-sync-p1",
			firstExecutionRunId: "run-xyz",
		});

		await expect(callSync({ projectId: "p1" })).resolves.toEqual(
			expect.objectContaining({
				workflowId: "pipeline-results-sync-p1",
				runId: "run-xyz",
				status: "started",
			}),
		);
	});
});
