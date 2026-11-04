/**
 * Workflow-level test for the self-cancel backstop in
 * `templateInstanceExecutionWorkflow`. Follows the light harness the other
 * workflow tests use (e.g. `security-finding-grouping.test.ts`): mock
 * `@temporalio/workflow` so `proxyActivities` returns plain `vi.fn()` stubs, then
 * invoke the workflow as a regular async function with full control over each
 * activity's return value.
 *
 * Property under test: when the RUNNING status write is guard-blocked (the
 * execution was already flipped to CANCELLED by a user cancel), the workflow
 * aborts BEFORE running the token-heavy data-gathering / AI / render / artifact
 * pipeline — instead of relying solely on Temporal `terminate()` to stop it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	fetchTemplateInstanceWithTemplate: vi.fn(),
	updateInstanceExecutionStatus: vi.fn(),
	renderInstanceReport: vi.fn(),
	storeInstanceArtifact: vi.fn(),
	indexInstanceArtifactForRag: vi.fn(),
	fetchReportTemplateSkills: vi.fn(),
	emitReportExecutionNotification: vi.fn(),
	sendReportExecutionEmail: vi.fn(),
	fetchDataSources: vi.fn(),
	executeAiAnalysis: vi.fn(),
	cleanupRagCollection: vi.fn(),
	executeAgentDataGatheringLoop: vi.fn(),
	resolveReportConnections: vi.fn(),
	checkFabricHealth: vi.fn(),
	applyFabricPatternEnrichment: vi.fn(),
	generateEvidenceReport: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: vi.fn(() => activityStubs),
	patched: vi.fn(() => false),
	ApplicationFailure: class ApplicationFailure extends Error {
		static create(opts?: { message?: string }) {
			return new ApplicationFailure(opts?.message);
		}
	},
}));

import {
	type TemplateInstanceExecutionInput,
	templateInstanceExecutionWorkflow,
} from "../template-instance-execution";

const INPUT: TemplateInstanceExecutionInput = {
	executionId: "exec-1",
	instanceId: "inst-1",
	userId: "user-1",
	organizationId: "org-1",
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("templateInstanceExecutionWorkflow — self-cancel backstop", () => {
	it("aborts to CANCELLED and skips the pipeline when the RUNNING write is guard-blocked", async () => {
		// finalize guard returned false → the row is already CANCELLED.
		activityStubs.updateInstanceExecutionStatus.mockResolvedValue(false);

		const out = await templateInstanceExecutionWorkflow(INPUT);

		expect(out.status).toBe("CANCELLED");
		expect(out.artifacts).toEqual([]);
		expect(out.executionId).toBe("exec-1");

		// Only the RUNNING write was attempted; the token-heavy pipeline never ran.
		expect(
			activityStubs.updateInstanceExecutionStatus,
		).toHaveBeenCalledTimes(1);
		expect(
			activityStubs.updateInstanceExecutionStatus,
		).toHaveBeenCalledWith(expect.objectContaining({ status: "RUNNING" }));
		expect(
			activityStubs.fetchTemplateInstanceWithTemplate,
		).not.toHaveBeenCalled();
		expect(
			activityStubs.executeAgentDataGatheringLoop,
		).not.toHaveBeenCalled();
		expect(activityStubs.executeAiAnalysis).not.toHaveBeenCalled();
		expect(activityStubs.renderInstanceReport).not.toHaveBeenCalled();
		expect(activityStubs.storeInstanceArtifact).not.toHaveBeenCalled();
	});

	it("proceeds into the pipeline when the RUNNING write lands", async () => {
		activityStubs.updateInstanceExecutionStatus.mockResolvedValue(true);
		// Return no instance so the run stops right after the checkpoint — we only
		// assert the workflow got PAST the self-cancel gate into the fetch step.
		activityStubs.fetchTemplateInstanceWithTemplate.mockResolvedValue(null);

		await expect(
			templateInstanceExecutionWorkflow(INPUT),
		).rejects.toThrow();

		expect(
			activityStubs.fetchTemplateInstanceWithTemplate,
		).toHaveBeenCalledTimes(1);
	});
});

describe("templateInstanceExecutionWorkflow — a spent ChatGPT plan (Fizzy #2770)", () => {
	// Shaped as Temporal hands a workflow the failure of a plan-refused step.
	const planSpent = () =>
		Object.assign(new Error("Activity task failed"), {
			name: "ActivityFailure",
			cause: {
				type: "SubscriptionPlanExhaustedError",
				message: "Every ChatGPT plan is spent.",
			},
		});

	beforeEach(async () => {
		const workflow = await import("@temporalio/workflow");
		// Every gate on except the plan wait, whose sleep this harness lacks.
		vi.mocked(workflow.patched).mockImplementation(
			(id: string) => id !== "chatgpt-plan-wait",
		);
		activityStubs.updateInstanceExecutionStatus.mockResolvedValue(true);
	});

	const failedWith = async (
		error: Error,
		input: TemplateInstanceExecutionInput,
	) => {
		activityStubs.fetchTemplateInstanceWithTemplate.mockRejectedValue(
			error,
		);
		await expect(
			templateInstanceExecutionWorkflow(input),
		).rejects.toThrow();
		expect(
			activityStubs.updateInstanceExecutionStatus,
		).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED" }));
	};

	it("does not tell the owner a scheduled run failed, since its next tick retries it", async () => {
		await failedWith(planSpent(), {
			...INPUT,
			jobType: "scheduled-report",
		});

		expect(activityStubs.sendReportExecutionEmail).not.toHaveBeenCalled();
		expect(
			activityStubs.emitReportExecutionNotification,
		).not.toHaveBeenCalled();
		expect(
			activityStubs.updateInstanceExecutionStatus,
		).toHaveBeenCalledWith(
			expect.objectContaining({ error: "Every ChatGPT plan is spent." }),
		);
	});

	it("still emails the owner when a scheduled run fails for another reason", async () => {
		await failedWith(new Error("All data sources failed"), {
			...INPUT,
			jobType: "scheduled-report",
		});

		expect(activityStubs.sendReportExecutionEmail).toHaveBeenCalledWith(
			expect.objectContaining({ status: "FAILED" }),
		);
		expect(
			activityStubs.emitReportExecutionNotification,
		).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED" }));
	});

	it("still emails the owner of an Execute-now run the plan refused, which nothing retries", async () => {
		await failedWith(planSpent(), INPUT);

		expect(activityStubs.sendReportExecutionEmail).toHaveBeenCalledWith(
			expect.objectContaining({ status: "FAILED" }),
		);
	});
});

describe("report admission protocol compatibility", () => {
	it("retains the legacy activity arguments when no protocol is present", async () => {
		activityStubs.updateInstanceExecutionStatus.mockResolvedValue(true);
		activityStubs.fetchTemplateInstanceWithTemplate.mockResolvedValue(null);
		await expect(
			templateInstanceExecutionWorkflow(INPUT),
		).rejects.toThrow();
		expect(
			activityStubs.fetchTemplateInstanceWithTemplate,
		).toHaveBeenCalledWith({
			instanceId: INPUT.instanceId,
			userId: INPUT.userId,
			organizationId: INPUT.organizationId,
		});
	});
	it("loads the admitted snapshot and fails strict completeness before reading or publishing evidence", async () => {
		activityStubs.updateInstanceExecutionStatus.mockResolvedValue(true);
		activityStubs.fetchTemplateInstanceWithTemplate.mockResolvedValue({
			reportingExecution: { config: { partialData: "require_complete" } },
		});
		await expect(
			templateInstanceExecutionWorkflow({
				...INPUT,
				reportingProtocol: 1,
			}),
		).rejects.toThrow(/complete historical evidence/);
		expect(
			activityStubs.fetchTemplateInstanceWithTemplate,
		).toHaveBeenCalledWith({
			instanceId: INPUT.instanceId,
			userId: INPUT.userId,
			organizationId: INPUT.organizationId,
			executionId: INPUT.executionId,
		});
		expect(activityStubs.fetchDataSources).not.toHaveBeenCalled();
		expect(
			activityStubs.executeAgentDataGatheringLoop,
		).not.toHaveBeenCalled();
		expect(activityStubs.storeInstanceArtifact).not.toHaveBeenCalled();
	});
});

it("runs pinned primary and comparison periods through rendering with bounded provenance for organization reports", async () => {
	activityStubs.updateInstanceExecutionStatus.mockResolvedValue(true);
	const window = {
		start: "2026-10-01T00:00:00.000Z",
		end: "2026-11-01T00:00:00.000Z",
		cutoff: "2026-11-02T09:00:00.000Z",
		timezone: "UTC",
		comparison: {
			start: "2026-09-01T00:00:00.000Z",
			end: "2026-10-01T00:00:00.000Z",
		},
	};
	activityStubs.fetchTemplateInstanceWithTemplate.mockResolvedValue({
		id: "inst-1",
		name: "Delivery",
		parameterDefaults: {},
		connections: {},
		fabricConfig: {},
		template: {
			id: "template-1",
			name: "Delivery summary",
			definition: {
				dataSources: [
					{
						id: "source-1",
						type: "mcp",
						provider: "example",
						operation: "read",
						config: {},
					},
				],
			},
			fabricConfig: null,
			outputFormat: "MARKDOWN",
		},
		reportingParameters: { team: "Example" },
		reportingExecution: {
			config: {
				period: "monthly",
				partialData: "allow_with_notice",
				publication: "draft",
			},
			window,
		},
	});
	activityStubs.fetchReportTemplateSkills.mockResolvedValue([]);
	activityStubs.resolveReportConnections.mockResolvedValue({
		mcpConfigs: [],
		mcpBindings: {},
		healed: [],
		unresolved: [],
	});
	activityStubs.checkFabricHealth.mockResolvedValue({ healthy: false });
	activityStubs.fetchDataSources.mockImplementation(async () => ({
		results: [
			{
				sourceId: "source-1",
				sourceType: "mcp",
				provider: "example",
				data: [{ title: "Example" }],
				recordCount: 1,
			},
		],
		fetchStates: {},
		totalRecords: 1,
	}));
	activityStubs.renderInstanceReport.mockResolvedValue({
		markdown: "# Delivery summary",
		title: "Delivery",
		generatedAt: window.cutoff,
	});
	activityStubs.storeInstanceArtifact.mockResolvedValue({ id: "artifact-1" });
	const result = await templateInstanceExecutionWorkflow({
		...INPUT,
		reportingProtocol: 1,
	});
	expect(result.status).toBe("COMPLETED");
	expect(activityStubs.fetchDataSources).toHaveBeenNthCalledWith(
		1,
		expect.objectContaining({
			reportingProtocol: 1,
			dateRange: {
				start: window.start,
				end: window.end,
				period: "monthly",
			},
		}),
	);
	expect(activityStubs.fetchDataSources).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({
			dateRange: window.comparison,
			parameters: expect.objectContaining({
				reportEvidenceRole: "comparison",
			}),
		}),
	);
	expect(activityStubs.renderInstanceReport).toHaveBeenCalledWith(
		expect.objectContaining({
			dataResults: [
				expect.objectContaining({ sourceId: "source-1" }),
				expect.objectContaining({ sourceId: "comparison:source-1" }),
			],
		}),
	);
	expect(activityStubs.storeInstanceArtifact).toHaveBeenCalledWith(
		expect.objectContaining({
			content: expect.stringContaining("Evidence notice"),
			metadata: expect.objectContaining({
				reporting: expect.objectContaining({
					state: "partial",
					window,
				}),
			}),
		}),
	);
	expect(activityStubs.indexInstanceArtifactForRag).toHaveBeenCalledOnce();
});
