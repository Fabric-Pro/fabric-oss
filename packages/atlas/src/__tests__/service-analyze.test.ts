/**
 * `AtlasService.requestAnalysis` — on-demand credential refresh
 * and per-branch analysis persistence.
 *
 * Locks the contract: an expired GitHub OAuth credential is refreshed in-line
 * (force: true — user-initiated, cooldown bypassed) and the analysis proceeds
 * with no error when it succeeds; only a genuine refresh failure throws the
 * unchanged `REPOSITORY_REAUTH_REQUIRED`. Analyses are stored PER BRANCH:
 * analysing a never-analysed monitored branch creates a fresh row (full run)
 * while switching BACK to a previously analysed branch reuses its row and
 * re-analyses incrementally — the existing map is never reset. One run at a
 * time per repository, regardless of branch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnsureFreshRepoCredentials = vi.fn();
const mockCountCommitsSince = vi.fn();
const mockListProjectRepositories = vi.fn();
const mockFindAnalysis = vi.fn();
const mockFindLatestAnalysisForIntegration = vi.fn();
const mockFindLatestAnalysisForProject = vi.fn();
const mockFindInFlightAnalysisForIntegration = vi.fn();
const mockResolveRepoCredentials = vi.fn();
const mockGetOrCreateAnalysis = vi.fn();
const mockBeginAnalysisRun = vi.fn();
const mockCreateAnalysisRun = vi.fn();
const mockRecordAudit = vi.fn();

vi.mock("../credentials", () => ({
	ensureFreshRepoCredentials: (...args: unknown[]) =>
		mockEnsureFreshRepoCredentials(...args),
}));

vi.mock("../commits", () => ({
	countCommitsSince: (...args: unknown[]) => mockCountCommitsSince(...args),
}));

vi.mock("../queries", () => ({
	listProjectRepositories: (...args: unknown[]) =>
		mockListProjectRepositories(...args),
	findAnalysis: (...args: unknown[]) => mockFindAnalysis(...args),
	findLatestAnalysisForIntegration: (...args: unknown[]) =>
		mockFindLatestAnalysisForIntegration(...args),
	findLatestAnalysisForProject: (...args: unknown[]) =>
		mockFindLatestAnalysisForProject(...args),
	findInFlightAnalysisForIntegration: (...args: unknown[]) =>
		mockFindInFlightAnalysisForIntegration(...args),
	resolveRepoCredentials: (...args: unknown[]) =>
		mockResolveRepoCredentials(...args),
	getOrCreateAnalysis: (...args: unknown[]) =>
		mockGetOrCreateAnalysis(...args),
	beginAnalysisRun: (...args: unknown[]) => mockBeginAnalysisRun(...args),
	createAnalysisRun: (...args: unknown[]) => mockCreateAnalysisRun(...args),
}));

vi.mock("@repo/database", () => ({
	recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
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

vi.mock("simple-git", () => ({ default: vi.fn() }));

import { AtlasService } from "../service";
import type { RepoOption } from "../types";

const ctx = { userId: "user-1", organizationId: "org-1" };

function makeRepo(overrides: Partial<RepoOption> = {}): RepoOption {
	return {
		repositoryIntegrationId: "int-1",
		provider: "GITHUB",
		authMethod: "OAUTH",
		repositoryName: "widgets",
		repositoryUrl: "https://github.com/acme/widgets",
		defaultBranch: "main",
		pinnedBranches: [],
		status: "TOKEN_EXPIRED",
		isDefault: true,
		...overrides,
	};
}

function makeAnalysis(
	overrides: Partial<{
		id: string;
		status: string;
		branch: string;
		analyzedCommitSha: string | null;
		updatedAt: Date;
	}> = {},
) {
	return {
		id: "an-1",
		status: "READY",
		repositoryIntegrationId: "int-1",
		analyzedCommitSha: "abc1234def5678",
		analyzedAt: new Date("2026-06-01T00:00:00Z"),
		analyzedCommitAt: new Date("2026-05-31T00:00:00Z"),
		branch: "main",
		updatedAt: new Date(),
		nodeCount: 12,
		edgeCount: 8,
		filesAnalyzed: 120,
		techStack: null,
		businessTour: null,
		error: null,
		workflowId: "wf-1",
		...overrides,
	};
}

const analyzeInput = { projectId: "p1", repositoryIntegrationId: "int-1" };

beforeEach(() => {
	vi.clearAllMocks();
	mockFindLatestAnalysisForProject.mockResolvedValue(null);
	mockFindLatestAnalysisForIntegration.mockResolvedValue(null);
	mockFindInFlightAnalysisForIntegration.mockResolvedValue(null);
	mockFindAnalysis.mockResolvedValue(makeAnalysis());
	mockGetOrCreateAnalysis.mockResolvedValue(makeAnalysis());
	mockBeginAnalysisRun.mockResolvedValue(undefined);
	mockCreateAnalysisRun.mockResolvedValue(undefined);
	mockResolveRepoCredentials.mockResolvedValue(null);
	mockCountCommitsSince.mockResolvedValue({
		headSha: null,
		aheadBy: null,
		comparable: false,
	});
});

describe("requestAnalysis — on-demand credential refresh", () => {
	it("proceeds with the analysis plan (no REAUTH) when the forced refresh heals an expired token", async () => {
		mockListProjectRepositories.mockResolvedValue([makeRepo()]);
		mockEnsureFreshRepoCredentials.mockResolvedValue({
			status: "ACTIVE",
			canAutoRefresh: true,
		});

		const service = new AtlasService(ctx);
		const plan = await service.requestAnalysis(analyzeInput);

		expect(mockEnsureFreshRepoCredentials).toHaveBeenCalledWith({
			integrationId: "int-1",
			userId: "user-1",
			organizationId: "org-1",
			force: true,
		});
		expect(plan.analysisId).toBe("an-1");
		expect(plan.workflowId).toBe("atlas-an-1");
		// Re-analysis of an already-READY snapshot keeps the served status at
		// READY (R2) — the run is tracked via the background-run markers.
		expect(mockBeginAnalysisRun).toHaveBeenCalledWith("an-1", {
			workflowId: "atlas-an-1",
			keepServedStatus: true,
			// Default (non-fresh) re-analysis keeps the stored manifest so the
			// run stays incremental; "from fresh" sets this true to re-describe all.
			clearManifest: false,
		});
	});

	it("throws REPOSITORY_REAUTH_REQUIRED when the refresh fails (dead refresh token)", async () => {
		mockListProjectRepositories.mockResolvedValue([makeRepo()]);
		mockEnsureFreshRepoCredentials.mockResolvedValue({
			status: "TOKEN_EXPIRED",
			canAutoRefresh: true,
		});

		const service = new AtlasService(ctx);
		await expect(
			service.requestAnalysis(analyzeInput),
		).rejects.toMatchObject({
			code: "REPOSITORY_REAUTH_REQUIRED",
		});
		expect(mockGetOrCreateAnalysis).not.toHaveBeenCalled();
	});

	it("throws REPOSITORY_REAUTH_REQUIRED for expired non-refreshable providers without attempting a refresh", async () => {
		mockListProjectRepositories.mockResolvedValue([
			makeRepo({ provider: "AZURE_DEVOPS", authMethod: "PAT" }),
		]);

		const service = new AtlasService(ctx);
		await expect(
			service.requestAnalysis(analyzeInput),
		).rejects.toMatchObject({
			code: "REPOSITORY_REAUTH_REQUIRED",
		});
		expect(mockEnsureFreshRepoCredentials).not.toHaveBeenCalled();
	});

	it("does not call the refresh helper twice unnecessarily for an already-ACTIVE non-GitHub repo", async () => {
		mockListProjectRepositories.mockResolvedValue([
			makeRepo({ provider: "GITLAB", status: "ACTIVE" }),
		]);

		const service = new AtlasService(ctx);
		const plan = await service.requestAnalysis(analyzeInput);

		expect(mockEnsureFreshRepoCredentials).not.toHaveBeenCalled();
		expect(plan.analysisId).toBe("an-1");
	});
});

describe("requestAnalysis — per-branch analysis persistence", () => {
	beforeEach(() => {
		mockEnsureFreshRepoCredentials.mockResolvedValue({
			status: "ACTIVE",
			canAutoRefresh: true,
		});
	});

	it("creates a fresh per-branch row (FULL run) when the monitored branch has never been analysed", async () => {
		// Monitored branch switched main → develop; only a main row exists.
		mockListProjectRepositories.mockResolvedValue([
			makeRepo({ status: "ACTIVE", defaultBranch: "develop" }),
		]);
		mockGetOrCreateAnalysis.mockResolvedValue(
			makeAnalysis({
				id: "an-develop",
				status: "NOT_ANALYZED",
				branch: "develop",
				analyzedCommitSha: null,
			}),
		);

		const service = new AtlasService(ctx);
		const plan = await service.requestAnalysis(analyzeInput);

		expect(mockGetOrCreateAnalysis).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ branch: "develop" }),
		);
		expect(plan.analysisId).toBe("an-develop");
		expect(plan.workflowArgs.incremental).toBe(false);
		expect(mockCreateAnalysisRun).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ mode: "full" }),
		);
	});

	it("reuses the existing branch row INCREMENTALLY when switching back to an analysed branch", async () => {
		// Monitored branch switched back develop → main; the main row (with its
		// own analysed SHA) still exists — it is reused, never reset.
		mockListProjectRepositories.mockResolvedValue([
			makeRepo({ status: "ACTIVE", defaultBranch: "main" }),
		]);
		mockGetOrCreateAnalysis.mockResolvedValue(
			makeAnalysis({ branch: "main", analyzedCommitSha: "abc1234" }),
		);

		const service = new AtlasService(ctx);
		const plan = await service.requestAnalysis(analyzeInput);

		expect(mockGetOrCreateAnalysis).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ branch: "main" }),
		);
		expect(plan.analysisId).toBe("an-1");
		expect(plan.workflowArgs.incremental).toBe(true);
		expect(mockCreateAnalysisRun).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ mode: "incremental" }),
		);
	});

	it("still runs FULL for a first analysis (no analysed commit on the branch row)", async () => {
		mockListProjectRepositories.mockResolvedValue([
			makeRepo({ status: "ACTIVE" }),
		]);
		mockGetOrCreateAnalysis.mockResolvedValue(
			makeAnalysis({
				status: "NOT_ANALYZED",
				branch: "main",
				analyzedCommitSha: null,
			}),
		);

		const service = new AtlasService(ctx);
		const plan = await service.requestAnalysis(analyzeInput);

		expect(plan.workflowArgs.incremental).toBe(false);
	});

	it("rejects CONFLICT when ANY branch row of the repository is already in flight", async () => {
		// A sibling branch row is mid-run — one run at a time per repository.
		mockListProjectRepositories.mockResolvedValue([
			makeRepo({ status: "ACTIVE", defaultBranch: "develop" }),
		]);
		mockFindInFlightAnalysisForIntegration.mockResolvedValue(
			makeAnalysis({ status: "ANALYZING", branch: "main" }),
		);

		const service = new AtlasService(ctx);
		await expect(
			service.requestAnalysis(analyzeInput),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mockGetOrCreateAnalysis).not.toHaveBeenCalled();
	});
});
