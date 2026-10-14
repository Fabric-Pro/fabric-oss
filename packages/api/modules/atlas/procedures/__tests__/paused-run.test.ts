/**
 * An Atlas analysis run paused for a ChatGPT plan reset (Fizzy #2770): the
 * paused-run getter says when it resumes and whether the viewer may run it
 * now on API billing; "Run now" is refused for anyone but an organization
 * admin or owner and while acting as someone else, refused for a run that is
 * not this analysis's paused run, and otherwise starts the resume at once
 * with `allowApiFallback`, stops the scheduled one, audits a warning and moves
 * the analysis to PENDING under the new resume.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getPausedRun: vi.fn(),
	organizationHasLlmApiProvider: vi.fn(),
	approveBulkRunApiOverride: vi.fn(),
	revertBulkRunApiOverride: vi.fn(),
	moveQueuedDocumentsToRun: vi.fn(),
	markAtlasAnalysisResumeApproved: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	requireOrgMembership: vi.fn(),
	start: vi.fn(),
	terminate: vi.fn(),
	getHandle: vi.fn(),
	serviceContexts: [] as unknown[],
}));

vi.mock("@repo/atlas", () => ({
	AtlasService: class {
		constructor(ctx: unknown) {
			mocks.serviceContexts.push(ctx);
		}
		getPausedRun = mocks.getPausedRun;
	},
}));
vi.mock("@repo/database", () => ({
	organizationHasLlmApiProvider: mocks.organizationHasLlmApiProvider,
	approveBulkRunApiOverride: mocks.approveBulkRunApiOverride,
	revertBulkRunApiOverride: mocks.revertBulkRunApiOverride,
	moveQueuedDocumentsToRun: mocks.moveQueuedDocumentsToRun,
	markAtlasAnalysisResumeApproved: mocks.markAtlasAnalysisResumeApproved,
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
vi.mock("../../../projects/lib/project-organization", () => ({
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
	atlasPausedRunProcedure,
	atlasRunPausedOnApiProcedure,
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
const pausedRun = {
	id: "run-1",
	analysisId: "analysis-1",
	resumesAt: new Date("2026-10-12T18:00:00.000Z"),
	pauseCount: 1,
};
const resumeState = {
	workflowType: "atlasWorkflow",
	taskQueue: "atlas",
	executionTimeoutMs: 18_000_000,
	workflowIdBase: "atlas-analysis-1",
	input: {
		analysisId: "analysis-1",
		analysisRunId: "run-1",
		jobType: "atlas-analysis",
	},
	progress: { structure: { commitSha: "abc123" } },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.serviceContexts.length = 0;
	process.env.FABRIC_FEATURE_ATLAS = "true";
	mocks.getPausedRun.mockResolvedValue(pausedRun);
	mocks.organizationHasLlmApiProvider.mockResolvedValue(true);
	mocks.requireOrgMembership.mockResolvedValue({ role: "admin" });
	mocks.getHandle.mockImplementation(() => ({ terminate: mocks.terminate }));
	mocks.approveBulkRunApiOverride.mockResolvedValue({
		pauseCount: 1,
		resumeState,
		workflowId: "atlas-analysis-1-resume-1-api",
		scheduledWorkflowId: "atlas-analysis-1-resume-1",
		resumesAt: pausedRun.resumesAt,
	});
});

describe("atlasPausedRunProcedure", () => {
	const input = { projectId: "project-1", analysisId: "analysis-1" };

	it("reports the paused run and that an admin may run it now", async () => {
		await expect(
			handler(atlasPausedRunProcedure)({ input, context: ctx }),
		).resolves.toEqual({
			run: {
				id: "run-1",
				resumesAt: pausedRun.resumesAt,
				pauseCount: 1,
				canRunOnApi: true,
				askAdminToRunOnApi: false,
			},
		});
		// Scoped to the project's own organization, not the caller's input.
		expect(mocks.serviceContexts).toEqual([
			{ userId: "user-2", organizationId: "org-1" },
		]);
		expect(mocks.getPausedRun).toHaveBeenCalledWith({
			projectId: "project-1",
			analysisId: "analysis-1",
		});
	});

	it("tells a member who is not an admin to ask one", async () => {
		mocks.requireOrgMembership.mockResolvedValue(null);

		await expect(
			handler(atlasPausedRunProcedure)({ input, context: ctx }),
		).resolves.toMatchObject({
			run: { canRunOnApi: false, askAdminToRunOnApi: true },
		});
	});

	it("answers null when nothing is paused", async () => {
		mocks.getPausedRun.mockResolvedValue(null);

		await expect(
			handler(atlasPausedRunProcedure)({ input, context: ctx }),
		).resolves.toEqual({ run: null });
	});
});

describe("atlasRunPausedOnApiProcedure", () => {
	const input = {
		projectId: "project-1",
		analysisId: "analysis-1",
		runId: "run-1",
	};

	it("starts the resume now with the API override, stops the scheduled one, audits and marks the analysis PENDING", async () => {
		await expect(
			handler(atlasRunPausedOnApiProcedure)({ input, context: ctx }),
		).resolves.toEqual({ workflowId: "atlas-analysis-1-resume-1-api" });

		expect(mocks.approveBulkRunApiOverride).toHaveBeenCalledWith({
			kind: "ATLAS_ANALYSIS",
			runId: "run-1",
			userId: "user-2",
		});
		expect(mocks.start).toHaveBeenCalledWith(
			"atlasWorkflow",
			expect.objectContaining({
				taskQueue: "atlas",
				workflowId: "atlas-analysis-1-resume-1-api",
				workflowExecutionTimeout: 18_000_000,
				args: [
					{
						...resumeState.input,
						resumeOf: {
							runId: "run-1",
							pauseCount: 1,
							workflowIdBase: "atlas-analysis-1",
						},
						allowApiFallback: true,
					},
				],
			}),
		);
		expect(mocks.getHandle).toHaveBeenCalledWith(
			"atlas-analysis-1-resume-1",
		);
		expect(mocks.terminate).toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "org.chatgpt_plan.api_override_approved",
				severity: "warning",
				organizationId: "org-1",
				resource: {
					type: "atlas_analysis_run",
					id: "run-1",
					name: null,
				},
			}),
		);
		expect(mocks.markAtlasAnalysisResumeApproved).toHaveBeenCalledWith({
			analysisId: "analysis-1",
			workflowId: "atlas-analysis-1-resume-1-api",
		});
	});

	it("is FORBIDDEN for a member who is not an organization admin or owner", async () => {
		mocks.requireOrgMembership.mockResolvedValue(null);

		await expect(
			handler(atlasRunPausedOnApiProcedure)({ input, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.approveBulkRunApiOverride).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.markAtlasAnalysisResumeApproved).not.toHaveBeenCalled();
	});

	it("is FORBIDDEN while acting as another user, even for an admin", async () => {
		await expect(
			handler(atlasRunPausedOnApiProcedure)({
				input,
				context: { ...ctx, session: { impersonatedBy: "admin-9" } },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.approveBulkRunApiOverride).not.toHaveBeenCalled();
	});

	it("refuses a run that is not this analysis's paused run", async () => {
		await expect(
			handler(atlasRunPausedOnApiProcedure)({
				input: { ...input, runId: "run-from-elsewhere" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.approveBulkRunApiOverride).not.toHaveBeenCalled();
	});

	it("puts the run back to wait when the resume cannot start", async () => {
		mocks.start.mockRejectedValue(new Error("temporal down"));

		await expect(
			handler(atlasRunPausedOnApiProcedure)({ input, context: ctx }),
		).rejects.toThrow("temporal down");
		expect(mocks.revertBulkRunApiOverride).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "ATLAS_ANALYSIS", runId: "run-1" }),
		);
		expect(mocks.markAtlasAnalysisResumeApproved).not.toHaveBeenCalled();
	});
});
