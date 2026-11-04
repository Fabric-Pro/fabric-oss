import {
	contextQualitySourceRevision,
	evaluateContextQuality,
} from "@repo/rag/lib/context-quality";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	access: vi.fn(),
	binding: vi.fn(),
	credentials: vi.fn(),
	admit: vi.fn(),
	byRequest: vi.fn(),
	get: vi.fn(),
	list: vi.fn(),
	cancel: vi.fn(),
	read: vi.fn(),
	assert: vi.fn(),
	start: vi.fn(),
	cancelWorkflow: vi.fn(),
	audit: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	admitContextQualityRun: m.admit,
	getContextQualityRunByRequest: m.byRequest,
	getContextQualityBinding: m.binding,
	getContextQualityRunSummary: m.get,
	listContextQualityRunSummaries: m.list,
	requestContextQualityRunCancellation: m.cancel,
	fetchContextQualityExecutionCredentials: m.credentials,
	recordAudit: m.audit,
}));
vi.mock("@repo/temporal/client", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: m.start,
			getHandle: () => ({ cancel: m.cancelWorkflow }),
		},
	}),
}));
vi.mock("../saved-access", () => ({ requireSavedEvaluationAccess: m.access }));
vi.mock("../context-reader", () => ({ readProjectContextSnapshot: m.read }));
vi.mock("@repo/rag/lib/context-quality/project-reader", () => ({
	assertProjectContextSourceAccess: m.assert,
}));

import {
	cancelContextQualityRun,
	compareContextQualityRuns,
	createContextQualityRun,
	getContextQualityRun,
	listContextQualityRuns,
} from "../saved-commands";

const actor = {
	organizationId: "example-org",
	projectId: "example-project",
	userId: "example-user",
};
const content = "Example cancellation policy";
const revision = contextQualitySourceRevision(content);
const evaluation = {
	version: 1 as const,
	sources: [{ sourceId: "example-source", expectedRevision: revision }],
	cases: [
		{
			id: "example-case",
			recordedAnswer: "Cancel online",
			retrievedSourceIds: ["example-source"],
			citedSourceIds: ["example-source"],
			expectations: {
				expectedSourceIds: ["example-source"],
				requiredPhrases: ["online"],
				forbiddenPhrases: [],
			},
		},
	],
};
const report = evaluateContextQuality({
	version: 1,
	sources: [{ id: "example-source", revision, content }],
	cases: evaluation.cases,
});
function row(overrides = {}) {
	return {
		id: "example-run",
		...actor,
		requestedBy: actor.userId,
		name: "Example evaluation",
		status: "SUCCEEDED",
		sourceRefsJson: evaluation.sources,
		resultJson: report,
		errorCode: null,
		cleanupStatus: "CONFIRMED",
		workspaceOrigin: "https://example.cloud.databricks.com",
		jobId: "123",
		experimentId: "456",
		remoteRunId: "789",
		remoteMlflowRunId: "a".repeat(32),
		workflowId: "context-quality-example-run",
		createdAt: new Date(),
		updatedAt: new Date(),
		completedAt: new Date(),
		...overrides,
	};
}
beforeEach(() => {
	vi.resetAllMocks();
	m.access.mockResolvedValue({ canWrite: true, canConfigure: true });
	m.assert.mockResolvedValue(undefined);
	m.read.mockResolvedValue({ sourceId: "example-source", revision, content });
	m.credentials.mockResolvedValue({
		DATABRICKS_HOST: "https://example.cloud.databricks.com",
	});
	m.binding.mockResolvedValue({
		id: "example-binding",
		isEnabled: true,
		exportApprovedAt: new Date(),
		integrationId: "example-integration",
		workspaceOrigin: "https://example.cloud.databricks.com",
		jobId: "123",
		experimentId: "456",
		volumeRoot: "/Volumes/example_catalog/example_schema/example_volume",
		notebookPath: "/Shared/example-notebook",
		notebookSha256: "a".repeat(64),
		configHash: "b".repeat(64),
	});
	m.byRequest.mockResolvedValue(null);
	m.get.mockResolvedValue(row());
	m.list.mockResolvedValue({ runs: [row()], nextCursor: null });
	m.admit.mockResolvedValue({
		created: true,
		run: row({ status: "QUEUED", resultJson: null }),
	});
	m.cancel.mockResolvedValue(
		row({ status: "CANCEL_REQUESTED", resultJson: null }),
	);
	m.start.mockResolvedValue({});
});
describe("saved evaluation command boundaries", () => {
	it("stores the exact private wire snapshot but starts Temporal with IDs only", async () => {
		await createContextQualityRun(actor, {
			bindingId: "example-binding",
			idempotencyKey: "example-key",
			evaluation,
		});
		const admitted = m.admit.mock.calls[0]![0];
		expect(JSON.parse(admitted.snapshotPayload).sources[0].content).toBe(
			content,
		);
		expect(admitted.localResultJson).toEqual(report);
		const options = m.start.mock.calls[0]![1];
		expect(options.args).toEqual([
			{
				evaluationRunId: "example-run",
				organizationId: actor.organizationId,
				projectId: actor.projectId,
				requesterUserId: actor.userId,
			},
		]);
		expect(JSON.stringify(options)).not.toContain(content);
		expect(m.audit).toHaveBeenCalledTimes(1);
	});
	it("returns a durable queued receipt if Temporal admission response is lost", async () => {
		m.start.mockRejectedValue(new Error("Example unavailable"));
		expect(
			(
				await createContextQualityRun(actor, {
					bindingId: "example-binding",
					idempotencyKey: "example-key",
					evaluation,
				})
			).run.status,
		).toBe("QUEUED");
	});
	it("refuses a viewer before any snapshot or credential read", async () => {
		m.access.mockRejectedValue(new Error("Example denied"));
		await expect(createContextQualityRun(actor, {})).rejects.toThrow(
			"Example denied",
		);
		expect(m.read).not.toHaveBeenCalled();
		expect(m.credentials).not.toHaveBeenCalled();
	});
	it("requires the exact approved project binding", async () => {
		await expect(
			createContextQualityRun(actor, {
				bindingId: "example-other",
				idempotencyKey: "example-key",
				evaluation,
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(m.admit).not.toHaveBeenCalled();
	});
	it("does not release evidence or native links after source access is revoked", async () => {
		m.assert.mockRejectedValue(new Error("Example source removed"));
		const { run } = await getContextQualityRun(actor, {
			runId: "example-run",
		});
		expect(run.evidenceAvailable).toBe(false);
		expect(run.report).toBeNull();
		expect(run.remoteRunUrl).toBeNull();
		expect(run.mlflowRunUrl).toBeNull();
		expect(JSON.stringify(run)).not.toContain(content);
	});
	it("historical evidence checks source access without re-requiring old revision bytes", async () => {
		await getContextQualityRun(actor, { runId: "example-run" });
		expect(m.assert).toHaveBeenCalledWith({
			...actor,
			sourceId: "example-source",
		});
		expect(m.read).not.toHaveBeenCalled();
	});
	it("bounds pagination and never exposes private payload or local result", async () => {
		m.list.mockResolvedValue({
			runs: [
				row({
					snapshotPayload: content,
					localResultJson: report,
					bindingConfigJson: { exampleSecret: "private" },
				}),
			],
			nextCursor: null,
		});
		const result = await listContextQualityRuns(actor, {});
		expect(JSON.stringify(result)).not.toContain(content);
		expect(result.runs[0]).not.toHaveProperty("localResultJson");
		await expect(
			listContextQualityRuns(actor, { limit: 1000 }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
	it("preserves a completion that races with a cancellation request", async () => {
		const { run } = await cancelContextQualityRun(actor, {
			runId: "example-run",
		});
		expect(m.cancel).toHaveBeenCalledWith({
			...actor,
			runId: "example-run",
		});
		expect(m.cancelWorkflow).toHaveBeenCalledTimes(1);
		expect(run.status).toBe("SUCCEEDED");
		expect(m.audit).toHaveBeenCalledTimes(1);
	});
	it("compares only compatible datasets and scorer configurations", async () => {
		m.get.mockResolvedValueOnce(row()).mockResolvedValueOnce(
			row({
				id: "example-candidate",
				resultJson: { ...report, datasetHash: "c".repeat(64) },
			}),
		);
		const result = await compareContextQualityRuns(actor, {
			baselineId: "example-run",
			candidateId: "example-candidate",
		});
		expect(result.compatible).toBe(false);
		expect(result.differences.dataset).toBe(true);
		expect(result.passedDelta).toBeNull();
	});
	it("does not emit a second requested audit when attaching to the same admitted key", async () => {
		m.admit.mockResolvedValue({
			created: false,
			run: row({ status: "RUNNING" }),
		});
		await createContextQualityRun(actor, {
			bindingId: "example-binding",
			idempotencyKey: "example-key",
			evaluation,
		});
		expect(m.audit).not.toHaveBeenCalled();
	});
	it("attaches an admitted retry before re-reading changed source bytes", async () => {
		const { createHash } = await import("node:crypto");
		const requestHash = createHash("sha256")
			.update(
				JSON.stringify({
					bindingId: "example-binding",
					name: "Context quality evaluation",
					evaluation,
				}),
			)
			.digest("hex");
		m.byRequest.mockResolvedValue({ ...row(), requestHash });
		m.read.mockRejectedValue(new Error("Example source changed"));
		expect(
			(
				await createContextQualityRun(actor, {
					bindingId: "example-binding",
					idempotencyKey: "example-key",
					evaluation,
				})
			).run.id,
		).toBe("example-run");
		expect(m.read).not.toHaveBeenCalled();
		expect(m.admit).not.toHaveBeenCalled();
	});
});
