/**
 * `AtlasService.getStatus` — lazy credential self-heal + the
 * `canAutoRefreshCredentials` status surface.
 *
 * Locks the contract: a non-ACTIVE GitHub OAuth repo is refreshed in-line
 * (force: false) and, on success, the SAME response already reports ACTIVE and
 * computes commits-behind; a failed refresh degrades to the current non-ACTIVE
 * state without ever throwing; `canAutoRefreshCredentials` follows the
 * provider/auth-method/refresh-token matrix and is false without an
 * integration.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnsureFreshRepoCredentials = vi.fn();
const mockCountCommitsSince = vi.fn();
const mockListProjectRepositories = vi.fn();
const mockFindAnalysis = vi.fn();
const mockFindLatestAnalysisForIntegration = vi.fn();
const mockFindLatestAnalysisForProject = vi.fn();
const mockResolveRepoCredentials = vi.fn();
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
	resolveRepoCredentials: (...args: unknown[]) =>
		mockResolveRepoCredentials(...args),
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

function makeReadyAnalysis() {
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
	};
}

const statusInput = { projectId: "p1", repositoryIntegrationId: "int-1" };

beforeEach(() => {
	vi.clearAllMocks();
	mockFindLatestAnalysisForProject.mockResolvedValue(null);
	mockFindLatestAnalysisForIntegration.mockResolvedValue(null);
	mockResolveRepoCredentials.mockResolvedValue({
		provider: "GITHUB",
		repositoryUrl: "https://github.com/acme/widgets",
		owner: "acme",
		repo: "widgets",
		branch: "main",
		token: "fresh-token",
	});
	mockCountCommitsSince.mockResolvedValue({
		headSha: "head123",
		aheadBy: 3,
		comparable: true,
	});
});

describe("getStatus — lazy refresh self-heal", () => {
	it("reports ACTIVE and computes commits-behind in the same response after a successful refresh", async () => {
		mockListProjectRepositories.mockResolvedValue([makeRepo()]);
		mockFindAnalysis.mockResolvedValue(makeReadyAnalysis());
		mockEnsureFreshRepoCredentials.mockResolvedValue({
			status: "ACTIVE",
			canAutoRefresh: true,
		});

		const service = new AtlasService(ctx);
		const status = await service.getStatus(statusInput);

		expect(mockEnsureFreshRepoCredentials).toHaveBeenCalledWith({
			integrationId: "int-1",
			userId: "user-1",
			organizationId: "org-1",
			force: false,
		});
		expect(status.repositoryStatus).toBe("ACTIVE");
		expect(status.canReanalyze).toBe(true);
		expect(status.canAutoRefreshCredentials).toBe(true);
		expect(mockCountCommitsSince).toHaveBeenCalledTimes(1);
		expect(status.newCommitCount).toBe(3);
		expect(status.commitsComparable).toBe(true);
	});

	it("returns the non-ACTIVE state (without throwing) when the refresh fails", async () => {
		mockListProjectRepositories.mockResolvedValue([makeRepo()]);
		mockFindAnalysis.mockResolvedValue(makeReadyAnalysis());
		mockEnsureFreshRepoCredentials.mockResolvedValue({
			status: "TOKEN_EXPIRED",
			canAutoRefresh: true,
		});

		const service = new AtlasService(ctx);
		const status = await service.getStatus(statusInput);

		expect(status.repositoryStatus).toBe("TOKEN_EXPIRED");
		expect(status.canReanalyze).toBe(false);
		expect(status.canAutoRefreshCredentials).toBe(true);
		// Lapsed credential — the provider is never probed for commits-behind.
		expect(mockCountCommitsSince).not.toHaveBeenCalled();
		expect(status.newCommitCount).toBeNull();
	});

	it("still resolves the status read when the refresh attempt throws unexpectedly", async () => {
		mockListProjectRepositories.mockResolvedValue([makeRepo()]);
		mockFindAnalysis.mockResolvedValue(makeReadyAnalysis());
		mockEnsureFreshRepoCredentials.mockRejectedValue(
			new Error("unexpected"),
		);

		const service = new AtlasService(ctx);
		const status = await service.getStatus(statusInput);

		expect(status.repositoryStatus).toBe("TOKEN_EXPIRED");
		expect(status.canAutoRefreshCredentials).toBe(false);
	});

	it("keeps a healthy repo ACTIVE when the helper returns its ERROR read-failure sentinel", async () => {
		// "ERROR" from the helper is its never-throw sentinel for a failed
		// integration READ — a transient hiccup must not repaint a healthy
		// repo as reconnect-needed for one poll.
		mockListProjectRepositories.mockResolvedValue([
			makeRepo({ status: "ACTIVE" }),
		]);
		mockFindAnalysis.mockResolvedValue(makeReadyAnalysis());
		mockEnsureFreshRepoCredentials.mockResolvedValue({
			status: "ERROR",
			canAutoRefresh: false,
		});

		const service = new AtlasService(ctx);
		const status = await service.getStatus(statusInput);

		expect(status.repositoryStatus).toBe("ACTIVE");
		expect(status.canReanalyze).toBe(true);
		// Commits-behind still computed off the healthy list-read status.
		expect(mockCountCommitsSince).toHaveBeenCalledTimes(1);
	});
});

describe("getStatus — per-branch analysis resolution", () => {
	it("falls back to the integration's latest analysed branch when the monitored branch has no row yet", async () => {
		// Monitored branch is `feature` (never analysed); only the `main` row
		// exists. The last map stays viewable read-only and the payload exposes
		// analysed branch ≠ monitored branch — the re-analyse-to-apply hint
		// condition — while Re-analyse stays available.
		mockListProjectRepositories.mockResolvedValue([
			makeRepo({ status: "ACTIVE", defaultBranch: "feature" }),
		]);
		mockEnsureFreshRepoCredentials.mockResolvedValue({
			status: "ACTIVE",
			canAutoRefresh: true,
		});
		mockFindAnalysis.mockResolvedValue(null); // no exact `feature` row
		mockFindLatestAnalysisForIntegration.mockResolvedValue(
			makeReadyAnalysis(), // the analysed `main` row
		);

		const service = new AtlasService(ctx);
		const status = await service.getStatus(statusInput);

		expect(mockFindAnalysis).toHaveBeenCalledWith(
			expect.anything(),
			"p1",
			"int-1",
			"feature",
		);
		expect(status.status).toBe("READY");
		expect(status.branch).toBe("main");
		expect(status.repository?.defaultBranch).toBe("feature");
		expect(status.canReanalyze).toBe(true);
	});

	it("resolves the exact branch row when the monitored branch was analysed before (switch-back)", async () => {
		mockListProjectRepositories.mockResolvedValue([
			makeRepo({ status: "ACTIVE", defaultBranch: "main" }),
		]);
		mockEnsureFreshRepoCredentials.mockResolvedValue({
			status: "ACTIVE",
			canAutoRefresh: true,
		});
		mockFindAnalysis.mockResolvedValue(makeReadyAnalysis());

		const service = new AtlasService(ctx);
		const status = await service.getStatus(statusInput);

		// Exact hit — the any-branch fallback is never consulted.
		expect(mockFindLatestAnalysisForIntegration).not.toHaveBeenCalled();
		expect(status.branch).toBe("main");
		expect(status.repository?.defaultBranch).toBe("main");
		expect(status.status).toBe("READY");
	});
});

describe("getStatus — canAutoRefreshCredentials matrix", () => {
	it("is true for a GitHub OAuth repo with a usable refresh token", async () => {
		mockListProjectRepositories.mockResolvedValue([makeRepo()]);
		mockFindAnalysis.mockResolvedValue(makeReadyAnalysis());
		mockEnsureFreshRepoCredentials.mockResolvedValue({
			status: "TOKEN_EXPIRED",
			canAutoRefresh: true,
		});

		const service = new AtlasService(ctx);
		const status = await service.getStatus(statusInput);

		expect(status.canAutoRefreshCredentials).toBe(true);
	});

	it("is false for a GitHub OAuth repo without a stored refresh token", async () => {
		mockListProjectRepositories.mockResolvedValue([makeRepo()]);
		mockFindAnalysis.mockResolvedValue(makeReadyAnalysis());
		mockEnsureFreshRepoCredentials.mockResolvedValue({
			status: "TOKEN_EXPIRED",
			canAutoRefresh: false,
		});

		const service = new AtlasService(ctx);
		const status = await service.getStatus(statusInput);

		expect(status.canAutoRefreshCredentials).toBe(false);
	});

	it("is false for GitLab OAuth (no refresh path) and never calls the helper", async () => {
		mockListProjectRepositories.mockResolvedValue([
			makeRepo({ provider: "GITLAB" }),
		]);
		mockFindAnalysis.mockResolvedValue(makeReadyAnalysis());

		const service = new AtlasService(ctx);
		const status = await service.getStatus(statusInput);

		expect(mockEnsureFreshRepoCredentials).not.toHaveBeenCalled();
		expect(status.canAutoRefreshCredentials).toBe(false);
		expect(status.repositoryStatus).toBe("TOKEN_EXPIRED");
	});

	it("is false for Azure DevOps PAT and never calls the helper", async () => {
		mockListProjectRepositories.mockResolvedValue([
			makeRepo({ provider: "AZURE_DEVOPS", authMethod: "PAT" }),
		]);
		mockFindAnalysis.mockResolvedValue(makeReadyAnalysis());

		const service = new AtlasService(ctx);
		const status = await service.getStatus(statusInput);

		expect(mockEnsureFreshRepoCredentials).not.toHaveBeenCalled();
		expect(status.canAutoRefreshCredentials).toBe(false);
	});

	it("is false when the project has no repository at all", async () => {
		mockListProjectRepositories.mockResolvedValue([]);
		mockFindLatestAnalysisForProject.mockResolvedValue(null);

		const service = new AtlasService(ctx);
		const status = await service.getStatus({
			projectId: "p1",
			repositoryIntegrationId: null,
		});

		expect(mockEnsureFreshRepoCredentials).not.toHaveBeenCalled();
		expect(status.canAutoRefreshCredentials).toBe(false);
		expect(status.hasRepository).toBe(false);
	});
});
