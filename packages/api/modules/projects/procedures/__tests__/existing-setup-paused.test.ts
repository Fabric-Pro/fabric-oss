/**
 * The project setup paused for a ChatGPT plan reset (Fizzy #2770): the page's
 * getter, Cancel and "Run now on API billing". A run id is honoured only for
 * a setup run of this project in its own tenant (NOT_FOUND otherwise); Run now
 * is refused to anyone but an organization admin or owner; Cancel closes the
 * project's analysis and the documents queued for the resume.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	hasProjectAccess: vi.fn(),
	getPausedProjectSetup: vi.fn(),
	getProjectSetupRun: vi.fn(),
	cancelPausedBulkRun: vi.fn(),
	closePausedProjectSetup: vi.fn(),
	organizationHasLlmApiProvider: vi.fn(),
	approveBulkRunApiOverride: vi.fn(),
	revertBulkRunApiOverride: vi.fn(),
	moveQueuedDocumentsToRun: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	requireOrgMembership: vi.fn(),
	start: vi.fn(),
	terminate: vi.fn(),
	getHandle: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	BULK_RUN_WAITING_STATUS: "WAITING_FOR_PLAN",
	bulkRunResumeWorkflowId: (base: string, count: number) =>
		`${base}-resume-${count}`,
	hasProjectAccess: mocks.hasProjectAccess,
	getPausedProjectSetup: mocks.getPausedProjectSetup,
	getProjectSetupRun: mocks.getProjectSetupRun,
	cancelPausedBulkRun: mocks.cancelPausedBulkRun,
	closePausedProjectSetup: mocks.closePausedProjectSetup,
	organizationHasLlmApiProvider: mocks.organizationHasLlmApiProvider,
	approveBulkRunApiOverride: mocks.approveBulkRunApiOverride,
	revertBulkRunApiOverride: mocks.revertBulkRunApiOverride,
	moveQueuedDocumentsToRun: mocks.moveQueuedDocumentsToRun,
}));
vi.mock("@repo/logs", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.start, getHandle: mocks.getHandle },
	}),
}));
vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAuditFromRequest,
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));
vi.mock("../../../organizations/lib/membership", () => ({
	requireOrgMembership: mocks.requireOrgMembership,
}));
vi.mock("../../lib/project-organization", () => ({
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
vi.mock("../../../../orpc/procedures", proceduresMockFactory);

import {
	cancelPausedSetupProcedure,
	getPausedSetupProcedure,
	runPausedSetupOnApiProcedure,
} from "../existing-setup-paused";

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
	workflowType: "existingProjectSetupWorkflow",
	taskQueue: "project-documents",
	executionTimeoutMs: 7_200_000,
	workflowIdBase: "existing-setup-project-1-1",
	input: {
		projectId: "project-1",
		aiToken: "",
		jobType: "project-setup",
	},
};
const input = { projectId: "project-1", runId: "task-1" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.getProjectSetupRun.mockResolvedValue({
		id: "task-1",
		status: "WAITING_FOR_PLAN",
	});
	mocks.organizationHasLlmApiProvider.mockResolvedValue(true);
	mocks.requireOrgMembership.mockResolvedValue({ role: "admin" });
	mocks.getHandle.mockImplementation(() => ({ terminate: mocks.terminate }));
	mocks.cancelPausedBulkRun.mockResolvedValue({ pauseCount: 1, resumeState });
	mocks.approveBulkRunApiOverride.mockResolvedValue({
		pauseCount: 1,
		resumeState,
		workflowId: "existing-setup-project-1-1-resume-1-api",
		scheduledWorkflowId: "existing-setup-project-1-1-resume-1",
		resumesAt: new Date("2026-10-12T21:00:00.000Z"),
	});
});

describe("getPausedSetupProcedure", () => {
	it("returns the paused setup with what the viewer may do about it", async () => {
		mocks.getPausedProjectSetup.mockResolvedValue({
			id: "task-1",
			resumesAt: new Date("2026-10-12T21:00:00.000Z"),
			pauseCount: 1,
			pendingDocumentCount: 2,
		});
		mocks.requireOrgMembership.mockResolvedValue(null);

		await expect(
			handler(getPausedSetupProcedure)({
				input: { projectId: "project-1" },
				context: ctx,
			}),
		).resolves.toEqual({
			setup: {
				id: "task-1",
				resumesAt: new Date("2026-10-12T21:00:00.000Z"),
				pauseCount: 1,
				pendingDocumentCount: 2,
				canRunOnApi: false,
				askAdminToRunOnApi: true,
			},
		});
		expect(mocks.getPausedProjectSetup).toHaveBeenCalledWith({
			projectId: "project-1",
			organizationId: "org-1",
			userId: "user-2",
		});
	});

	it("refuses a viewer without access to the project", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			handler(getPausedSetupProcedure)({
				input: { projectId: "project-1" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getPausedProjectSetup).not.toHaveBeenCalled();
	});
});

describe("cancelPausedSetupProcedure", () => {
	it("cancels the run, closes the project's analysis and queued documents, and stops the resume", async () => {
		await expect(
			handler(cancelPausedSetupProcedure)({ input, context: ctx }),
		).resolves.toEqual({ cancelled: true });

		expect(mocks.getProjectSetupRun).toHaveBeenCalledWith({
			runId: "task-1",
			projectId: "project-1",
			organizationId: "org-1",
			userId: "user-2",
		});
		expect(mocks.cancelPausedBulkRun).toHaveBeenCalledWith({
			kind: "PROJECT_SETUP",
			runId: "task-1",
			message: expect.stringContaining("Setup cancelled"),
		});
		expect(mocks.closePausedProjectSetup).toHaveBeenCalledWith({
			resumeState,
			pauseCount: 1,
			message: expect.stringContaining("Setup cancelled"),
		});
		expect(mocks.getHandle).toHaveBeenCalledWith(
			"existing-setup-project-1-1-resume-1",
		);
		expect(mocks.terminate).toHaveBeenCalled();
	});

	it("is NOT_FOUND for a run of another project or tenant", async () => {
		mocks.getProjectSetupRun.mockResolvedValue(null);

		await expect(
			handler(cancelPausedSetupProcedure)({
				input: { projectId: "project-1", runId: "task-of-project-2" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.cancelPausedBulkRun).not.toHaveBeenCalled();
		expect(mocks.closePausedProjectSetup).not.toHaveBeenCalled();
	});

	it("is a CONFLICT once the setup is no longer paused", async () => {
		mocks.getProjectSetupRun.mockResolvedValue({
			id: "task-1",
			status: "RUNNING",
		});

		await expect(
			handler(cancelPausedSetupProcedure)({ input, context: ctx }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.cancelPausedBulkRun).not.toHaveBeenCalled();
	});

	it("closes nothing when the resume claimed the run first", async () => {
		mocks.cancelPausedBulkRun.mockResolvedValue(null);

		await expect(
			handler(cancelPausedSetupProcedure)({ input, context: ctx }),
		).resolves.toEqual({ cancelled: false });
		expect(mocks.closePausedProjectSetup).not.toHaveBeenCalled();
		expect(mocks.terminate).not.toHaveBeenCalled();
	});
});

describe("runPausedSetupOnApiProcedure", () => {
	it("resumes now with the API override, moves the queued documents to it, and audits a warning", async () => {
		await expect(
			handler(runPausedSetupOnApiProcedure)({ input, context: ctx }),
		).resolves.toEqual({
			workflowId: "existing-setup-project-1-1-resume-1-api",
		});

		expect(mocks.start).toHaveBeenCalledWith(
			"existingProjectSetupWorkflow",
			expect.objectContaining({
				workflowId: "existing-setup-project-1-1-resume-1-api",
				workflowExecutionTimeout: 7_200_000,
				args: [
					{
						...resumeState.input,
						resumeOf: {
							runId: "task-1",
							pauseCount: 1,
							workflowIdBase: "existing-setup-project-1-1",
						},
						allowApiFallback: true,
					},
				],
			}),
		);
		expect(mocks.moveQueuedDocumentsToRun).toHaveBeenCalledWith({
			fromWorkflowId: "existing-setup-project-1-1-resume-1",
			toWorkflowId: "existing-setup-project-1-1-resume-1-api",
		});
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "org.chatgpt_plan.api_override_approved",
				severity: "warning",
				resource: { type: "agent_task", id: "task-1", name: null },
				metadata: {
					kind: "PROJECT_SETUP",
					projectId: "project-1",
					pauseCount: 1,
				},
			}),
		);
	});

	it("refuses a project editor who is not an organization admin or owner", async () => {
		mocks.requireOrgMembership.mockResolvedValue(null);

		await expect(
			handler(runPausedSetupOnApiProcedure)({ input, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.approveBulkRunApiOverride).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("is NOT_FOUND for a run of another project or tenant", async () => {
		mocks.getProjectSetupRun.mockResolvedValue(null);

		await expect(
			handler(runPausedSetupOnApiProcedure)({
				input: { projectId: "project-1", runId: "task-of-project-2" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.approveBulkRunApiOverride).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
	});
});
