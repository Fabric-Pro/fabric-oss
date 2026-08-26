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
