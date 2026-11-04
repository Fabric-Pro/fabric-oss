import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {},
	fetchContextQualityExecutionCredentials: vi.fn(),
}));
vi.mock("@repo/database/prisma/queries/projects/context-quality-runs", () => ({
	CONTEXT_QUALITY_RUN_STATUSES: [
		"QUEUED",
		"EXPORTING",
		"DISPATCHING",
		"RUNNING",
		"CANCEL_REQUESTED",
		"SUCCEEDED",
		"FAILED",
		"CANCELLED",
		"RECONCILIATION_REQUIRED",
	],
	CONTEXT_QUALITY_TERMINAL_STATUSES: ["SUCCEEDED", "FAILED", "CANCELLED"],
	getContextQualityRunForWorker: vi.fn(),
	transitionContextQualityRun: vi.fn(),
	purgeSettledContextQualityRunSnapshot: vi.fn(),
}));
vi.mock("@repo/rag/lib/context-quality/project-reader", () => ({
	assertProjectContextSourceAccess: vi.fn(),
	readProjectContextSnapshot: vi.fn(),
}));
vi.mock("@repo/utils", () => ({ decryptApiKey: vi.fn() }));

import {
	computeDatabricksEvaluationPrincipalFingerprint,
	DatabricksEvaluationError,
} from "@repo/databricks";
import {
	contextQualitySourceRevision,
	evaluateContextQuality,
} from "@repo/rag/lib/context-quality";
import {
	type ContextQualityEvaluationDependencies,
	createContextQualityEvaluationActivities,
} from "../context-quality-evaluation";

type Run = NonNullable<
	Awaited<ReturnType<ContextQualityEvaluationDependencies["load"]>>
>;
const input = {
	evaluationRunId: "example-run",
	organizationId: "example-org",
	projectId: "example-project",
	requesterUserId: "example-user",
};
const now = new Date("2026-01-01T00:00:00Z");
function setup() {
	const content = "Example source booking policy";
	const revision = contextQualitySourceRevision(content);
	const snapshot = {
		version: 1,
		sources: [{ id: "example-source", content, revision }],
		cases: [
			{
				id: "example-case",
				recordedAnswer: "Bookings online",
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
	const payload = JSON.stringify(snapshot);
	const report = evaluateContextQuality(snapshot);
	const binding = {
		id: "example-binding",
		organizationId: input.organizationId,
		projectId: input.projectId,
		integrationId: "example-integration",
		workspaceOrigin: "https://example.cloud.databricks.com",
		jobId: "123",
		experimentId: "456",
		volumeRoot: "/Volumes/example_catalog/example_schema/example_volume",
		notebookPath: "/Shared/example-evaluator",
		notebookSha256: "a".repeat(64),
		principalFingerprint: computeDatabricksEvaluationPrincipalFingerprint(
			"https://example.cloud.databricks.com",
			"example-client",
		),
		configHash: "b".repeat(64),
		configVersion: 1,
	};
	let run = {
		id: input.evaluationRunId,
		organizationId: input.organizationId,
		projectId: input.projectId,
		requestedBy: input.requesterUserId,
		stateVersion: 0,
		status: "QUEUED",
		sourceRefsJson: [
			{ sourceId: "example-source", expectedRevision: revision },
		],
		snapshotPayload: payload,
		payloadHash: createHash("sha256").update(payload).digest("hex"),
		snapshotHash: report.snapshotHash,
		bindingConfigJson: binding,
		bindingConfigHash: binding.configHash,
		localResultJson: report,
		binding: { ...binding, isEnabled: true, exportApprovedAt: now },
		createdAt: now,
		deadlineAt: new Date(now.getTime() + 600000),
		snapshotExpiresAt: new Date(now.getTime() + 1200000),
		cancelRequestedAt: null,
		cleanupStatus: "NOT_REQUIRED",
		remoteRunId: null,
		remoteState: null,
		resultJson: null,
	} as unknown as Run;
	const transport = {
		qualifyJob: vi.fn().mockResolvedValue(undefined),
		uploadSnapshot: vi.fn().mockResolvedValue(undefined),
		admit: vi.fn().mockResolvedValue("789"),
		findAdmittedRun: vi.fn().mockResolvedValue(null),
		getRun: vi.fn().mockResolvedValue({
			runId: "789",
			jobId: "123",
			taskRunId: "790",
			lifecycle: "TERMINATED",
			result: "SUCCESS",
			terminal: true,
			parametersMatch: true,
		}),
		output: vi.fn().mockImplementation(async () => ({
			version: 1,
			fabricRunId: run.id,
			payloadHash: run.payloadHash,
			experimentId: "456",
			mlflowRunId: "c".repeat(32),
			report,
		})),
		cancel: vi.fn().mockResolvedValue(undefined),
		deleteSnapshot: vi.fn().mockResolvedValue(undefined),
	};
	const calls: { scope: unknown; patch: unknown }[] = [];
	const deps: ContextQualityEvaluationDependencies = {
		load: vi.fn(async () => structuredClone(run)),
		transition: vi.fn(async (request) => {
			calls.push({
				scope: {
					organizationId: request.organizationId,
					projectId: request.projectId,
					runId: request.runId,
				},
				patch: request.patch,
			});
			if (
				run.stateVersion !== request.expectedStateVersion ||
				(run.cancelRequestedAt &&
					request.patch.status &&
					![
						"CANCELLED",
						"CANCEL_REQUESTED",
						"RECONCILIATION_REQUIRED",
					].includes(request.patch.status))
			) {
				return { updated: false, run: structuredClone(run) };
			}
			run = {
				...run,
				...request.patch,
				stateVersion: run.stateVersion + 1,
			} as Run;
			return { updated: true, run: structuredClone(run) };
		}),
		readSource: vi
			.fn()
			.mockResolvedValue({ id: "example-source", content, revision }),
		assertSourceAccess: vi.fn().mockResolvedValue(undefined),
		assertCanExecute: vi.fn().mockResolvedValue(undefined),
		purgeSnapshot: vi.fn().mockResolvedValue(0),
		credentials: vi.fn().mockResolvedValue({
			DATABRICKS_HOST: binding.workspaceOrigin,
			DATABRICKS_CLIENT_ID: "example-client",
			DATABRICKS_CLIENT_SECRET: "private-token",
		}),
		client: vi.fn(() => transport),
		now: () => now,
		sleep: vi.fn().mockResolvedValue(undefined),
	};
	return {
		deps,
		transport,
		calls,
		report,
		worker: createContextQualityEvaluationActivities(deps),
		get run() {
			return run;
		},
		set run(value: Run) {
			run = value;
		},
	};
}
describe("saved context quality worker", () => {
	it("qualifies, exports, runs, verifies the entire report and erases input, returning status only", async () => {
		const f = setup();
		expect(await f.worker.execute(input)).toEqual({ status: "SUCCEEDED" });
		expect(f.run.resultJson).toEqual(f.report);
		expect(f.run.cleanupStatus).toBe("CONFIRMED");
		expect(f.run.remoteMlflowRunId).toBe("c".repeat(32));
		expect(f.transport.qualifyJob).toHaveBeenCalledTimes(2);
		expect(f.deps.readSource).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: input.organizationId,
				projectId: input.projectId,
				userId: input.requesterUserId,
				sourceId: "example-source",
				expectedRevision: f.report.sources[0]?.revision,
			}),
		);
		expect(
			f.calls.every(
				(call) =>
					JSON.stringify(call.scope) ===
					JSON.stringify({
						organizationId: input.organizationId,
						projectId: input.projectId,
						runId: input.evaluationRunId,
					}),
			),
		).toBe(true);
		const pending = f.calls.findIndex((call) =>
			JSON.stringify(call.patch).includes('"cleanupStatus":"PENDING"'),
		);
		expect(pending).toBeGreaterThanOrEqual(0);
		expect(JSON.stringify(f.calls)).not.toContain("private-token");
	});
	it("does not dispatch when source revision or permission changes", async () => {
		const f = setup();
		vi.mocked(f.deps.readSource).mockRejectedValue(
			new Error("private source unavailable"),
		);
		expect(await f.worker.execute(input)).toEqual({ status: "FAILED" });
		expect(f.transport.uploadSnapshot).not.toHaveBeenCalled();
		expect(f.transport.admit).not.toHaveBeenCalled();
		expect(f.run.errorCode).toBe("SOURCE_CHANGED_OR_REVOKED");
	});
	it("checks sources again after code qualification before uploading", async () => {
		const f = setup();
		f.transport.qualifyJob.mockImplementationOnce(async () => {
			vi.mocked(f.deps.readSource).mockRejectedValue(
				new Error("revoked"),
			);
		});
		expect(await f.worker.execute(input)).toEqual({ status: "FAILED" });
		expect(f.transport.uploadSnapshot).not.toHaveBeenCalled();
	});
	it("rejects a disabled binding without reading snapshots or making cloud calls", async () => {
		const f = setup();
		if (!f.run.binding) {
			throw new Error("Fixture binding missing");
		}
		f.run.binding.isEnabled = false;
		expect(await f.worker.execute(input)).toEqual({ status: "FAILED" });
		expect(f.deps.readSource).not.toHaveBeenCalled();
		expect(f.transport.qualifyJob).not.toHaveBeenCalled();
	});
	it("does not dispatch with a different frozen principal", async () => {
		const f = setup();
		vi.mocked(f.deps.credentials).mockResolvedValue({
			DATABRICKS_HOST: "https://example.cloud.databricks.com",
			DATABRICKS_CLIENT_ID: "different-client",
			DATABRICKS_CLIENT_SECRET: "private-token",
		});
		expect(await f.worker.execute(input)).toEqual({ status: "FAILED" });
		expect(f.transport.admit).not.toHaveBeenCalled();
	});
	it("rejects payload/hash tampering before any export", async () => {
		const f = setup();
		f.run.snapshotPayload += " changed";
		expect(await f.worker.execute(input)).toEqual({ status: "FAILED" });
		expect(f.transport.uploadSnapshot).not.toHaveBeenCalled();
		expect(f.run.errorCode).toBe("INVALID_SNAPSHOT");
	});
	it("withholds output when the safe remote report differs from the canonical local report", async () => {
		const f = setup();
		f.transport.output.mockResolvedValue({
			version: 1,
			fabricRunId: input.evaluationRunId,
			payloadHash: f.run.payloadHash,
			experimentId: "456",
			mlflowRunId: "c".repeat(32),
			report: {
				...f.report,
				status: f.report.status === "passed" ? "failed" : "passed",
			},
		});
		expect(await f.worker.execute(input)).toEqual({ status: "FAILED" });
		expect(f.run.resultJson).toBeNull();
		expect(f.run.cleanupStatus).toBe("CONFIRMED");
	});
	it("withholds results if live access is revoked while native output is fetched", async () => {
		const f = setup();
		f.transport.output.mockImplementationOnce(async () => {
			vi.mocked(f.deps.assertSourceAccess).mockRejectedValue(
				new Error("revoked"),
			);
			return {
				version: 1,
				fabricRunId: f.run.id,
				payloadHash: f.run.payloadHash,
				experimentId: "456",
				mlflowRunId: "c".repeat(32),
				report: f.report,
			};
		});
		expect(await f.worker.execute(input)).toEqual({ status: "FAILED" });
		expect(f.run.errorCode).toBe("SOURCE_ACCESS_REVOKED");
		expect(f.run.resultJson).toBeNull();
	});
	it("retains success separately from unconfirmed remote input cleanup", async () => {
		const f = setup();
		f.transport.deleteSnapshot.mockRejectedValue(
			new Error("private provider failure"),
		);
		expect(await f.worker.execute(input)).toEqual({ status: "SUCCEEDED" });
		expect(f.run.cleanupStatus).toBe("BLOCKED");
		expect(f.run.cleanupErrorCode).toBe("REMOTE_ERASURE_UNCONFIRMED");
	});
	it("cancels before dispatch without starting a job or requiring current actor credentials", async () => {
		const f = setup();
		f.run.status = "CANCEL_REQUESTED";
		f.run.cancelRequestedAt = now;
		vi.mocked(f.deps.credentials).mockResolvedValue(null);
		expect(await f.worker.execute(input)).toEqual({ status: "CANCELLED" });
		expect(f.transport.admit).not.toHaveBeenCalled();
		expect(f.transport.findAdmittedRun).not.toHaveBeenCalled();
	});
	it("reconciles a lost admission response through read-only lookup and cancellation", async () => {
		const f = setup();
		f.transport.admit.mockImplementationOnce(async () => {
			f.run.cancelRequestedAt = now;
			f.run.status = "CANCEL_REQUESTED";
			throw new DatabricksEvaluationError("REMOTE_UNAVAILABLE");
		});
		f.transport.findAdmittedRun.mockResolvedValue("789");
		f.transport.getRun
			.mockResolvedValueOnce({
				runId: "789",
				jobId: "123",
				taskRunId: "790",
				lifecycle: "RUNNING",
				result: null,
				terminal: false,
				parametersMatch: true,
			})
			.mockResolvedValueOnce({
				runId: "789",
				jobId: "123",
				taskRunId: "790",
				lifecycle: "TERMINATED",
				result: "CANCELED",
				terminal: true,
				parametersMatch: true,
			});
		expect(await f.worker.execute(input)).toEqual({ status: "CANCELLED" });
		expect(f.transport.admit).toHaveBeenCalledTimes(1);
		expect(f.transport.cancel).toHaveBeenCalledTimes(1);
		expect(f.run.remoteRunId).toBe("789");
	});
	it("keeps unknown admission unresolved after cancellation and never repeats run-now", async () => {
		const f = setup();
		f.run.status = "CANCEL_REQUESTED";
		f.run.cancelRequestedAt = now;
		f.run.cleanupStatus = "PENDING";
		f.run.remoteState = "ADMISSION_PENDING";
		expect(await f.worker.execute(input)).toEqual({
			status: "RECONCILIATION_REQUIRED",
		});
		expect(f.transport.admit).not.toHaveBeenCalled();
		expect(f.transport.findAdmittedRun).toHaveBeenCalledTimes(1);
		expect(f.run.completedAt).toBeUndefined();
	});
	it("resumes an admitted run instead of creating another job", async () => {
		const f = setup();
		f.run.status = "RUNNING";
		f.run.remoteRunId = "789";
		f.run.cleanupStatus = "PENDING";
		expect(await f.worker.execute(input)).toEqual({ status: "SUCCEEDED" });
		expect(f.transport.admit).not.toHaveBeenCalled();
		expect(f.transport.uploadSnapshot).not.toHaveBeenCalled();
		expect(f.deps.readSource).not.toHaveBeenCalled();
	});
	it("does not accept results or cancel a native run with mismatched identity", async () => {
		const f = setup();
		f.transport.getRun.mockResolvedValue({
			runId: "789",
			jobId: "999",
			taskRunId: "790",
			lifecycle: "TERMINATED",
			result: "SUCCESS",
			terminal: true,
			parametersMatch: false,
		});
		expect(await f.worker.execute(input)).toEqual({
			status: "RECONCILIATION_REQUIRED",
		});
		expect(f.transport.output).not.toHaveBeenCalled();
		expect(f.transport.cancel).not.toHaveBeenCalled();
	});
	it("renews cleanup before re-exporting an authorized ambiguous admission", async () => {
		const f = setup();
		f.run.status = "RECONCILIATION_REQUIRED";
		f.run.remoteState = "ADMISSION_PENDING";
		f.run.cleanupStatus = "CONFIRMED";
		f.transport.uploadSnapshot.mockImplementationOnce(async () => {
			expect(f.run.cleanupStatus).toBe("PENDING");
			expect(f.run.remoteState).toBe("ADMISSION_PENDING");
		});
		expect(await f.worker.execute(input)).toEqual({ status: "SUCCEEDED" });
		expect(f.transport.findAdmittedRun).toHaveBeenCalledTimes(1);
		expect(f.transport.admit).toHaveBeenCalledTimes(1);
		expect(f.transport.deleteSnapshot).toHaveBeenCalledTimes(1);
		expect(f.run.cleanupStatus).toBe("CONFIRMED");
	});
	it("stops dispatch after a requester loses project edit access while retaining source read", async () => {
		const f = setup();
		vi.mocked(f.deps.assertCanExecute).mockRejectedValue(
			new Error("Example downgraded to viewer"),
		);
		expect(await f.worker.execute(input)).toEqual({ status: "FAILED" });
		expect(f.transport.admit).not.toHaveBeenCalled();
		expect(f.transport.uploadSnapshot).not.toHaveBeenCalled();
		expect(f.run.errorCode).toBe("PROJECT_ACCESS_REVOKED");
	});

	it("retries a transient poll failure without cancelling a healthy native run or erasing input", async () => {
		const f = setup();
		f.transport.getRun.mockRejectedValueOnce(
			new DatabricksEvaluationError("REMOTE_UNAVAILABLE", 503),
		);
		await expect(f.worker.execute(input)).rejects.toThrow(
			"temporarily unavailable",
		);
		expect(f.run.status).toBe("RUNNING");
		expect(f.transport.cancel).not.toHaveBeenCalled();
		expect(f.transport.deleteSnapshot).not.toHaveBeenCalled();
		expect(await f.worker.execute(input)).toEqual({ status: "SUCCEEDED" });
		expect(f.transport.admit).toHaveBeenCalledTimes(1);
	});
	it("retains input after a lost admission response and resumes the existing native run on retry", async () => {
		const f = setup();
		f.transport.admit.mockRejectedValueOnce(
			new DatabricksEvaluationError("REMOTE_UNAVAILABLE"),
		);
		await expect(f.worker.execute(input)).rejects.toThrow(
			"temporarily unavailable",
		);
		expect(f.run.remoteState).toBe("ADMISSION_PENDING");
		expect(f.transport.deleteSnapshot).not.toHaveBeenCalled();
		f.transport.findAdmittedRun.mockResolvedValue("789");
		expect(await f.worker.execute(input)).toEqual({ status: "SUCCEEDED" });
		expect(f.transport.admit).toHaveBeenCalledTimes(1);
	});
});
