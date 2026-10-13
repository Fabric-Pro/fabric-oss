/**
 * "Run now on API billing" for a scan, review or grouping paused for a
 * ChatGPT plan reset, and the batch generation's paused-batch procedures
 * (Fizzy #2770): refused without an LLM provider of the organization's own,
 * refused for anyone but an organization admin or owner and while acting as
 * someone else, refused for a run that is no longer paused, and otherwise the scheduled
 * resume is stopped, a resume starts at once with `allowApiFallback`, and a
 * warning-severity audit row names who approved it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	hasProjectAccess: vi.fn(),
	getProjectScan: vi.fn(),
	getScanFindingReview: vi.fn(),
	getScanFindingGrouping: vi.fn(),
	organizationHasLlmApiProvider: vi.fn(),
	revertBulkRunApiOverride: vi.fn(),
	approveBulkRunApiOverride: vi.fn(),
	moveQueuedDocumentsToRun: vi.fn(),
	getPausedDocumentBatch: vi.fn(),
	cancelPausedBulkRun: vi.fn(),
	failQueuedDocumentsOfRun: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	start: vi.fn(),
	terminate: vi.fn(),
	getHandle: vi.fn(),
	requireOrgMembership: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	getProjectScan: mocks.getProjectScan,
	getScanFindingReview: mocks.getScanFindingReview,
	getScanFindingGrouping: mocks.getScanFindingGrouping,
	organizationHasLlmApiProvider: mocks.organizationHasLlmApiProvider,
	revertBulkRunApiOverride: mocks.revertBulkRunApiOverride,
	approveBulkRunApiOverride: mocks.approveBulkRunApiOverride,
	moveQueuedDocumentsToRun: mocks.moveQueuedDocumentsToRun,
	getPausedDocumentBatch: mocks.getPausedDocumentBatch,
	cancelPausedBulkRun: mocks.cancelPausedBulkRun,
	failQueuedDocumentsOfRun: mocks.failQueuedDocumentsOfRun,
	bulkRunResumeWorkflowId: (base: string, count: number) =>
		`${base}-resume-${count}`,
}));
vi.mock("@repo/logs", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.start, getHandle: mocks.getHandle },
	}),
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAuditFromRequest,
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));
vi.mock("../../../../organizations/lib/membership", () => ({
	requireOrgMembership: mocks.requireOrgMembership,
}));
vi.mock("../../../lib/project-organization", () => ({
	resolveProjectOrganizationId: async () => "org-1",
}));

const { proceduresMockFactory } = vi.hoisted(() => ({
	proceduresMockFactory: () => {
		const chainable: Record<string, unknown> = {};
		Object.assign(chainable, {
			use: () => chainable,
			route: () => chainable,
			input: () => chainable,
			output: () => chainable,
			handler: (fn: unknown) => ({ _handler: fn }),
		});
		return {
			tenantProtectedProcedure: chainable,
			Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
			requireProjectPermission: () => (c: unknown) => c,
		};
	},
}));
vi.mock("../../../../../orpc/procedures", proceduresMockFactory);

import {
	cancelPausedBatchProcedure,
	getPausedBatchProcedure,
	runPausedBatchOnApiProcedure,
} from "../../documents/paused-batch";
import {
	pausedRunOptionsProcedure,
	runPausedOnApiProcedure,
} from "../paused-run";

type Handler = (args: {
	input: Record<string, unknown>;
	context: {
		user: { id: string };
		session: { impersonatedBy?: string | null };
	};
}) => Promise<unknown>;
const handler = (procedure: unknown) =>
	(procedure as { _handler: Handler })._handler;

const ctx = { user: { id: "user-2" }, session: { impersonatedBy: null } };
const resumeState = {
	workflowType: "securityAccessibilityScanWorkflow",
	taskQueue: "fabric-worker",
	executionTimeoutMs: 5_400_000,
	workflowIdBase: "security-scan-scan-1",
	input: { scanId: "scan-1", jobType: "security-scan" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.getProjectScan.mockResolvedValue({ id: "scan-1" });
	mocks.organizationHasLlmApiProvider.mockResolvedValue(true);
	mocks.requireOrgMembership.mockResolvedValue({ role: "admin" });
	mocks.getHandle.mockImplementation(() => ({ terminate: mocks.terminate }));
	mocks.approveBulkRunApiOverride.mockResolvedValue({
		pauseCount: 2,
		resumeState,
		workflowId: "security-scan-scan-1-resume-2-api",
		scheduledWorkflowId: "security-scan-scan-1-resume-2",
		resumesAt: new Date("2026-10-12T18:00:00.000Z"),
	});
});

describe("runPausedOnApiProcedure", () => {
	const input = {
		projectId: "project-1",
		kind: "scan",
		runId: "scan-1",
	};

	it("starts the resume now with the API override, stops the scheduled one, and audits a warning", async () => {
		await expect(
			handler(runPausedOnApiProcedure)({ input, context: ctx }),
		).resolves.toEqual({ workflowId: "security-scan-scan-1-resume-2-api" });

		expect(mocks.approveBulkRunApiOverride).toHaveBeenCalledWith({
			kind: "PROJECT_SCAN",
			runId: "scan-1",
			userId: "user-2",
		});
		expect(mocks.getHandle).toHaveBeenCalledWith(
			"security-scan-scan-1-resume-2",
		);
		expect(mocks.terminate).toHaveBeenCalled();
		expect(mocks.start).toHaveBeenCalledWith(
			"securityAccessibilityScanWorkflow",
			{
				taskQueue: "fabric-worker",
				workflowId: "security-scan-scan-1-resume-2-api",
				args: [
					{
						scanId: "scan-1",
						jobType: "security-scan",
						resumeOf: {
							runId: "scan-1",
							pauseCount: 2,
							workflowIdBase: "security-scan-scan-1",
						},
						allowApiFallback: true,
					},
				],
				workflowExecutionTimeout: 5_400_000,
			},
		);
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "org.chatgpt_plan.api_override_approved",
				severity: "warning",
				organizationId: "org-1",
				resource: { type: "project_scan", id: "scan-1", name: null },
				metadata: {
					kind: "PROJECT_SCAN",
					projectId: "project-1",
					pauseCount: 2,
				},
			}),
		);
		expect(mocks.moveQueuedDocumentsToRun).not.toHaveBeenCalled();
	});

	it("refuses a project editor who is not an organization admin or owner", async () => {
		mocks.requireOrgMembership.mockResolvedValue(null);

		await expect(
			handler(runPausedOnApiProcedure)({ input, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.requireOrgMembership).toHaveBeenCalledWith(
			"user-2",
			"org-1",
			["admin", "owner"],
		);
		expect(mocks.approveBulkRunApiOverride).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("refuses while acting as another user", async () => {
		await expect(
			handler(runPausedOnApiProcedure)({
				input,
				context: { ...ctx, session: { impersonatedBy: "app-admin" } },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.approveBulkRunApiOverride).not.toHaveBeenCalled();
	});

	it("refuses without an AI provider of the organization's own", async () => {
		mocks.organizationHasLlmApiProvider.mockResolvedValue(false);

		await expect(
			handler(runPausedOnApiProcedure)({ input, context: ctx }),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(mocks.approveBulkRunApiOverride).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("puts the run back to wait for its scheduled resume when the start fails", async () => {
		mocks.start.mockRejectedValueOnce(new Error("temporal down"));

		await expect(
			handler(runPausedOnApiProcedure)({ input, context: ctx }),
		).rejects.toThrow("temporal down");
		expect(mocks.revertBulkRunApiOverride).toHaveBeenCalledWith({
			kind: "PROJECT_SCAN",
			runId: "scan-1",
			pauseCount: 2,
			resumesAt: new Date("2026-10-12T18:00:00.000Z"),
			scheduledWorkflowId: "security-scan-scan-1-resume-2",
		});
		// The scheduled resume is left to run; nothing is audited.
		expect(mocks.terminate).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("refuses a run that is no longer paused, and audits nothing", async () => {
		mocks.approveBulkRunApiOverride.mockResolvedValue(null);

		await expect(
			handler(runPausedOnApiProcedure)({ input, context: ctx }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("refuses a run from another project", async () => {
		mocks.getScanFindingReview.mockResolvedValue(null);

		await expect(
			handler(runPausedOnApiProcedure)({
				input: { ...input, kind: "review", runId: "review-9" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.approveBulkRunApiOverride).not.toHaveBeenCalled();
	});

	it("refuses without project access", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			handler(runPausedOnApiProcedure)({ input, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("pausedRunOptionsProcedure", () => {
	const read = () =>
		handler(pausedRunOptionsProcedure)({
			input: { projectId: "project-1" },
			context: ctx,
		});

	it("offers Run now to an admin or owner when there is a provider to bill", async () => {
		await expect(read()).resolves.toEqual({
			canRunOnApi: true,
			askAdminToRunOnApi: false,
		});
	});

	it("tells anyone else to ask an admin", async () => {
		mocks.requireOrgMembership.mockResolvedValue(null);

		await expect(read()).resolves.toEqual({
			canRunOnApi: false,
			askAdminToRunOnApi: true,
		});
	});

	it("offers neither without a provider to bill", async () => {
		mocks.organizationHasLlmApiProvider.mockResolvedValue(false);

		await expect(read()).resolves.toEqual({
			canRunOnApi: false,
			askAdminToRunOnApi: false,
		});
	});
});

describe("paused batch generation", () => {
	const batch = {
		id: "task-1",
		resumesAt: new Date("2026-10-12T18:00:00.000Z"),
		pauseCount: 1,
		pendingDocumentCount: 2,
	};
	const batchState = {
		...resumeState,
		workflowType: "batchDocumentGenerationWorkflow",
		taskQueue: "project-documents",
		workflowIdBase: "batch-document-generation-project-1-1",
	};

	it("reads the paused batch with whether it may run on the API", async () => {
		mocks.getPausedDocumentBatch.mockResolvedValue(batch);

		await expect(
			handler(getPausedBatchProcedure)({
				input: { projectId: "project-1" },
				context: ctx,
			}),
		).resolves.toEqual({
			batch: { ...batch, canRunOnApi: true, askAdminToRunOnApi: false },
		});
		// The organization's own provider, never the viewer's personal key.
		expect(mocks.organizationHasLlmApiProvider).toHaveBeenCalledWith(
			"org-1",
		);
		expect(mocks.getPausedDocumentBatch).toHaveBeenCalledWith({
			projectId: "project-1",
			organizationId: "org-1",
			userId: "user-2",
		});
	});

	it("Run now moves the queued documents to the new resume", async () => {
		mocks.getPausedDocumentBatch.mockResolvedValue(batch);
		mocks.approveBulkRunApiOverride.mockResolvedValue({
			pauseCount: 1,
			resumeState: batchState,
			workflowId: "batch-document-generation-project-1-1-resume-1-api",
			scheduledWorkflowId:
				"batch-document-generation-project-1-1-resume-1",
		});

		await handler(runPausedBatchOnApiProcedure)({
			input: { projectId: "project-1", runId: "task-1" },
			context: ctx,
		});

		expect(mocks.moveQueuedDocumentsToRun).toHaveBeenCalledWith({
			fromWorkflowId: "batch-document-generation-project-1-1-resume-1",
			toWorkflowId: "batch-document-generation-project-1-1-resume-1-api",
		});
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				resource: { type: "agent_task", id: "task-1", name: null },
			}),
		);
	});

	it("refuses Run now on a batch for a project editor who is not an admin", async () => {
		mocks.getPausedDocumentBatch.mockResolvedValue(batch);
		mocks.requireOrgMembership.mockResolvedValue(null);

		await expect(
			handler(runPausedBatchOnApiProcedure)({
				input: { projectId: "project-1", runId: "task-1" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.approveBulkRunApiOverride).not.toHaveBeenCalled();
	});

	it("refuses a batch id that is not the project's paused batch", async () => {
		mocks.getPausedDocumentBatch.mockResolvedValue(batch);

		await expect(
			handler(runPausedBatchOnApiProcedure)({
				input: { projectId: "project-1", runId: "task-other" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.approveBulkRunApiOverride).not.toHaveBeenCalled();
	});

	it("Cancel fails the queued documents and stops the scheduled resume", async () => {
		mocks.getPausedDocumentBatch.mockResolvedValue(batch);
		mocks.cancelPausedBulkRun.mockResolvedValue({
			pauseCount: 1,
			resumeState: batchState,
		});

		await expect(
			handler(cancelPausedBatchProcedure)({
				input: { projectId: "project-1", runId: "task-1" },
				context: ctx,
			}),
		).resolves.toEqual({ cancelled: true });
		expect(mocks.failQueuedDocumentsOfRun).toHaveBeenCalledWith({
			workflowId: "batch-document-generation-project-1-1-resume-1",
			message: expect.stringContaining("Cancelled"),
		});
		expect(mocks.getHandle).toHaveBeenCalledWith(
			"batch-document-generation-project-1-1-resume-1",
		);
	});
});
