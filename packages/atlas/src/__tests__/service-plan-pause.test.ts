/**
 * An analysis whose run paused for a ChatGPT plan reset (Fizzy #2770), in
 * `AtlasService`: the status reports it waiting and the stale-run sweep
 * leaves it alone however long it waits; "Cancel analysis" cancels the
 * paused run row, stops its scheduled resume and fails the analysis, but
 * leaves a run its resume already claimed; and the workflow's status writes
 * reach the pause mirror.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listProjectRepositories: vi.fn(),
	findAnalysis: vi.fn(),
	findInFlightAnalysis: vi.fn(),
	finalizeAnalysis: vi.fn(),
	completeLatestRun: vi.fn(),
	markAnalysisAnalyzing: vi.fn(),
	recordAudit: vi.fn(),
	cancelPausedBulkRun: vi.fn(),
	getPausedAtlasRun: vi.fn(),
	markAtlasAnalysisWaitingForPlan: vi.fn(),
	markAtlasAnalysisResumed: vi.fn(),
}));

vi.mock("../credentials", () => ({ ensureFreshRepoCredentials: vi.fn() }));
vi.mock("../commits", () => ({ countCommitsSince: vi.fn() }));
vi.mock("../queries", () => ({
	listProjectRepositories: mocks.listProjectRepositories,
	findAnalysis: mocks.findAnalysis,
	findLatestAnalysisForIntegration: vi.fn(async () => null),
	findLatestAnalysisForProject: vi.fn(async () => null),
	findInFlightAnalysis: mocks.findInFlightAnalysis,
	finalizeAnalysis: mocks.finalizeAnalysis,
	completeLatestRun: mocks.completeLatestRun,
	markAnalysisAnalyzing: mocks.markAnalysisAnalyzing,
	// No credentials: a READY snapshot skips the commits-behind probe.
	resolveRepoCredentials: vi.fn(async () => null),
}));
vi.mock("@repo/database", () => ({
	recordAudit: mocks.recordAudit,
	cancelPausedBulkRun: mocks.cancelPausedBulkRun,
	getPausedAtlasRun: mocks.getPausedAtlasRun,
	markAtlasAnalysisWaitingForPlan: mocks.markAtlasAnalysisWaitingForPlan,
	markAtlasAnalysisResumed: mocks.markAtlasAnalysisResumed,
	bulkRunResumeWorkflowId: (base: string, count: number) =>
		`${base}-resume-${count}`,
}));
vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {},
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
	streamText: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("simple-git", () => ({ simpleGit: vi.fn() }));

import { AtlasService } from "../service";

const ctx = { userId: "user-1", organizationId: "org-1" };
const HOUR = 60 * 60_000;

function waitingAnalysis(overrides: Record<string, unknown> = {}) {
	return {
		id: "an-1",
		projectId: "p1",
		status: "WAITING_FOR_PLAN",
		activeRunStatus: "WAITING_FOR_PLAN",
		// Far past the 5h20m stale-run window.
		activeRunStartedAt: new Date(Date.now() - 10 * HOUR),
		repositoryIntegrationId: "int-1",
		analyzedCommitSha: null,
		analyzedAt: null,
		analyzedCommitAt: null,
		branch: "main",
		updatedAt: new Date(Date.now() - 10 * HOUR),
		nodeCount: 0,
		edgeCount: 0,
		filesAnalyzed: 0,
		techStack: null,
		businessTour: null,
		error: null,
		workflowId: "atlas-an-1",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.listProjectRepositories.mockResolvedValue([
		{
			repositoryIntegrationId: "int-1",
			provider: "GITHUB",
			authMethod: "OAUTH",
			repositoryName: "widgets",
			repositoryUrl: "https://github.com/example/widgets",
			defaultBranch: "main",
			pinnedBranches: [],
			status: "ACTIVE",
			isDefault: true,
		},
	]);
	mocks.getPausedAtlasRun.mockResolvedValue({
		id: "run-1",
		analysisId: "an-1",
		resumesAt: new Date("2026-10-12T18:00:00.000Z"),
		pauseCount: 1,
	});
	mocks.cancelPausedBulkRun.mockResolvedValue({
		pauseCount: 1,
		resumeState: { workflowIdBase: "atlas-an-1" },
	});
});

describe("getStatus while the run waits for a plan reset", () => {
	it("reports it waiting, with no active run, and never sweeps it as stale", async () => {
		mocks.findAnalysis.mockResolvedValue(waitingAnalysis());

		const status = await new AtlasService(ctx).getStatus({
			projectId: "p1",
			repositoryIntegrationId: "int-1",
		});

		expect(status).toMatchObject({
			status: "WAITING_FOR_PLAN",
			waitingForPlan: true,
			activeRun: null,
			inFlightSince: null,
		});
		expect(mocks.finalizeAnalysis).not.toHaveBeenCalled();
	});

	it("reports a waiting re-run over its READY snapshot", async () => {
		mocks.findAnalysis.mockResolvedValue(
			waitingAnalysis({ status: "READY", analyzedCommitSha: "abc" }),
		);

		const status = await new AtlasService(ctx).getStatus({
			projectId: "p1",
			repositoryIntegrationId: "int-1",
		});

		expect(status).toMatchObject({ status: "READY", waitingForPlan: true });
	});
});

describe("cancelAnalysis on a paused run", () => {
	const cancelInput = {
		projectId: "p1",
		repositoryIntegrationId: "int-1",
	};

	it("cancels the run row, stops the scheduled resume and fails the analysis", async () => {
		mocks.findInFlightAnalysis.mockResolvedValue(waitingAnalysis());
		const service = new AtlasService(ctx);
		vi.spyOn(service, "getStatus").mockResolvedValue({} as never);
		const cancelWorkflow = vi.fn();

		await service.cancelAnalysis({ ...cancelInput, cancelWorkflow });

		expect(mocks.getPausedAtlasRun).toHaveBeenCalledWith({
			analysisId: "an-1",
			projectId: "p1",
			organizationId: "org-1",
			userId: "user-1",
		});
		expect(mocks.cancelPausedBulkRun).toHaveBeenCalledWith({
			kind: "ATLAS_ANALYSIS",
			runId: "run-1",
			message: "Cancelled by user",
		});
		expect(cancelWorkflow).toHaveBeenCalledWith("atlas-an-1-resume-1");
		expect(mocks.finalizeAnalysis).toHaveBeenCalledWith("an-1", {
			status: "FAILED",
			error: "Cancelled by user",
		});
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "atlas.analysis.cancelled" }),
		);
		// Never the first run's closed workflow.
		expect(cancelWorkflow).not.toHaveBeenCalledWith("atlas-an-1");
	});

	it("leaves a run its resume already claimed", async () => {
		mocks.findInFlightAnalysis.mockResolvedValue(waitingAnalysis());
		mocks.cancelPausedBulkRun.mockResolvedValue(null);
		const service = new AtlasService(ctx);
		vi.spyOn(service, "getStatus").mockResolvedValue({} as never);
		const cancelWorkflow = vi.fn();

		await service.cancelAnalysis({ ...cancelInput, cancelWorkflow });

		expect(mocks.finalizeAnalysis).not.toHaveBeenCalled();
		expect(cancelWorkflow).not.toHaveBeenCalled();
	});
});

describe("markStatus and the pause mirror", () => {
	it("WAITING_FOR_PLAN marks the analysis waiting", async () => {
		await new AtlasService(ctx).markStatus({
			analysisId: "an-1",
			status: "WAITING_FOR_PLAN",
		});

		expect(mocks.markAtlasAnalysisWaitingForPlan).toHaveBeenCalledWith(
			"an-1",
		);
	});

	it("ANALYZING from a resume records the resume's workflow", async () => {
		await new AtlasService(ctx).markStatus({
			analysisId: "an-1",
			status: "ANALYZING",
			resumedWorkflowId: "atlas-an-1-resume-1",
		});

		expect(mocks.markAtlasAnalysisResumed).toHaveBeenCalledWith({
			analysisId: "an-1",
			workflowId: "atlas-an-1-resume-1",
		});
		expect(mocks.markAnalysisAnalyzing).not.toHaveBeenCalled();
	});

	it("a first run's ANALYZING is unchanged", async () => {
		await new AtlasService(ctx).markStatus({
			analysisId: "an-1",
			status: "ANALYZING",
		});

		expect(mocks.markAnalysisAnalyzing).toHaveBeenCalledWith("an-1");
		expect(mocks.markAtlasAnalysisResumed).not.toHaveBeenCalled();
	});
});
