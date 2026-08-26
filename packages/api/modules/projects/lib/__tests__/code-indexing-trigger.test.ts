/**
 * Tests for the per-repo code-indexing trigger. Locks the contract that makes
 * multi-repo indexing + per-repo persistence work:
 *   - gated off by FEATURE_CODE_INDEXING and by codeSearchEnabled
 *   - one workflow started per ACTIVE integration (multi-repo)
 *   - a single integration can be targeted (manual re-index / push)
 *   - a repo without a usable token is skipped, not fatal
 *   - the legacy null-integration OAuth fallback still starts a run
 *   - cancel reads the INDEXING row's workflowId and cancels it
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `workflow.start` resolves to a WorkflowHandle; the Job Hub row records
// its firstExecutionRunId.
const mockStart = vi.fn(async () => ({
	firstExecutionRunId: "run-1",
}));
const mockGetHandle = vi.fn();
const mockGetTemporalClient = vi.fn(async () => ({
	workflow: { start: mockStart, getHandle: mockGetHandle },
}));

const mockRagFindUnique = vi.fn();
const mockProjectFindUnique = vi.fn();
const mockWorkflowIntegrationFindFirst = vi.fn();
const mockGetProjectReposForCodeSearch = vi.fn();
const mockGetProjectCodeIndexes = vi.fn();
const mockParseRepoUrl = vi.fn();
const mockDecryptApiKey = vi.fn((v: string) => `dec(${v})`);
const mockFailBackgroundJob = vi.fn(async () => undefined);

vi.mock("@repo/database", () => ({
	// Job Hub telemetry — the trigger now opens a BackgroundJob row before
	// starting each workflow. Stubbed so these tests keep asserting the start
	// behavior, not the bookkeeping.
	createBackgroundJob: vi.fn(async () => "job-1"),
	failBackgroundJob: (...a: unknown[]) => mockFailBackgroundJob(...(a as [])),
	seedSteps: (keys: string[]) =>
		keys.map((key) => ({ key, status: "pending" })),
	db: {
		projectRagSettings: {
			findUnique: (...a: unknown[]) => mockRagFindUnique(...a),
		},
		project: {
			findUnique: (...a: unknown[]) => mockProjectFindUnique(...a),
		},
		workflowIntegration: {
			findFirst: (...a: unknown[]) =>
				mockWorkflowIntegrationFindFirst(...a),
		},
	},
	getProjectReposForCodeSearch: (...a: unknown[]) =>
		mockGetProjectReposForCodeSearch(...a),
	getProjectCodeIndexes: (...a: unknown[]) => mockGetProjectCodeIndexes(...a),
	parseRepoUrl: (...a: unknown[]) => mockParseRepoUrl(...a),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (...a: unknown[]) => mockDecryptApiKey(...(a as [string])),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: () => mockGetTemporalClient(),
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));

async function load() {
	return import("../code-indexing-trigger");
}

function repo(id: string, over: Record<string, unknown> = {}) {
	return {
		integrationId: id,
		provider: "GITHUB",
		owner: "acme",
		repo: id,
		branch: "main",
		repositoryUrl: `https://github.com/acme/${id}`,
		encryptedAccessToken: `tok-${id}`,
		encryptedPat: null,
		...over,
	};
}

const baseOpts = {
	projectId: "proj-1",
	userId: "user-1",
	organizationId: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	process.env.FEATURE_CODE_INDEXING = "true";
	mockRagFindUnique.mockResolvedValue({ codeSearchEnabled: true });
	// The trigger derives the tenant from the project itself.
	mockProjectFindUnique.mockResolvedValue({ organizationId: null });
});

afterEach(() => {
	process.env.FEATURE_CODE_INDEXING = undefined;
});

describe("startCodeIndexingForProject", () => {
	it("no-ops when FEATURE_CODE_INDEXING is not 'true'", async () => {
		process.env.FEATURE_CODE_INDEXING = "false";
		const { startCodeIndexingForProject } = await load();
		const result = await startCodeIndexingForProject(baseOpts);
		expect(result).toEqual({
			started: 0,
			skipped: [],
			disabledReason: "feature-flag",
		});
		expect(mockGetTemporalClient).not.toHaveBeenCalled();
	});

	it("no-ops when codeSearchEnabled is off", async () => {
		mockRagFindUnique.mockResolvedValue({ codeSearchEnabled: false });
		const { startCodeIndexingForProject } = await load();
		const result = await startCodeIndexingForProject(baseOpts);
		expect(result.disabledReason).toBe("code-search-disabled");
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("starts one workflow per ACTIVE integration (multi-repo)", async () => {
		mockGetProjectReposForCodeSearch.mockResolvedValue([
			repo("a"),
			repo("b"),
		]);
		const { startCodeIndexingForProject } = await load();
		const result = await startCodeIndexingForProject(baseOpts);
		expect(result.started).toBe(2);
		expect(mockStart).toHaveBeenCalledTimes(2);
		// Each start carries its own integrationId + workflowId.
		const ids = mockStart.mock.calls.map((c) => c[1].args[0].integrationId);
		expect(ids).toEqual(["a", "b"]);
		// Stable per-repo workflow id (no timestamp) + supersede policy.
		const wfIds = mockStart.mock.calls.map((c) => c[1].workflowId);
		expect(wfIds).toEqual(["code-index-proj-1-a", "code-index-proj-1-b"]);
		expect(mockStart.mock.calls[0][1].workflowIdConflictPolicy).toBe(
			"TERMINATE_EXISTING",
		);
	});

	it("targets a single integration when repositoryIntegrationId is given", async () => {
		mockGetProjectReposForCodeSearch.mockResolvedValue([
			repo("a"),
			repo("b"),
		]);
		const { startCodeIndexingForProject } = await load();
		const result = await startCodeIndexingForProject({
			...baseOpts,
			repositoryIntegrationId: "b",
		});
		expect(result.started).toBe(1);
		expect(mockStart).toHaveBeenCalledTimes(1);
		expect(mockStart.mock.calls[0][1].args[0].integrationId).toBe("b");
	});

	it("skips a repo with no usable token instead of failing", async () => {
		mockGetProjectReposForCodeSearch.mockResolvedValue([
			repo("a", { encryptedAccessToken: null, encryptedPat: null }),
			repo("b"),
		]);
		const { startCodeIndexingForProject } = await load();
		const result = await startCodeIndexingForProject(baseOpts);
		expect(result.started).toBe(1);
		expect(result.skipped).toEqual([
			{ repositoryIntegrationId: "a", reason: "no-token" },
		]);
	});

	it("does not fall back to legacy when a missing integration is targeted", async () => {
		mockGetProjectReposForCodeSearch.mockResolvedValue([repo("a")]);
		const { startCodeIndexingForProject } = await load();
		const result = await startCodeIndexingForProject({
			...baseOpts,
			repositoryIntegrationId: "does-not-exist",
		});
		expect(result.started).toBe(0);
		// No workflow started, and the legacy fallback is not entered.
		expect(mockStart).not.toHaveBeenCalled();
		expect(mockWorkflowIntegrationFindFirst).not.toHaveBeenCalled();
	});

	it("falls back to legacy OAuth (null-integration row) when no integrations exist", async () => {
		mockGetProjectReposForCodeSearch.mockResolvedValue([]);
		mockProjectFindUnique.mockResolvedValue({
			organizationId: null,
			repositoryUrl: "https://github.com/acme/legacy",
		});
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "legacy",
		});
		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			credentials: '{"access_token":"legacy-token"}',
		});
		mockDecryptApiKey.mockImplementation((v: string) => v);
		const { startCodeIndexingForProject } = await load();
		const result = await startCodeIndexingForProject(baseOpts);
		expect(result.started).toBe(1);
		const arg = mockStart.mock.calls[0][1].args[0];
		// Legacy row = no integrationId.
		expect(arg.integrationId).toBeUndefined();
		expect(mockStart.mock.calls[0][1].workflowId).toBe(
			"code-index-proj-1-legacy",
		);
	});
});

describe("cancelCodeIndexingForRepo", () => {
	it("cancels the INDEXING row's workflow for the given repo", async () => {
		const cancel = vi.fn(async () => {});
		const result = vi.fn(async () => {});
		mockGetHandle.mockReturnValue({ cancel, result });
		mockGetProjectCodeIndexes.mockResolvedValue([
			{
				repositoryIntegrationId: "a",
				status: "INDEXING",
				workflowId: "wf-a",
			},
			{
				repositoryIntegrationId: "b",
				status: "READY",
				workflowId: "wf-b",
			},
		]);
		const { cancelCodeIndexingForRepo } = await load();
		await cancelCodeIndexingForRepo({
			projectId: "proj-1",
			repositoryIntegrationId: "a",
		});
		expect(mockGetHandle).toHaveBeenCalledWith("wf-a");
		expect(cancel).toHaveBeenCalled();
	});

	it("closes the Job Hub row even when no INDEXING row exists yet", async () => {
		// The API opens the job row the moment `workflow.start` returns, while
		// INDEXING is written later by the worker. Cancelling in that window
		// used to hit the early return and leave the job RUNNING until the
		// watchdog mislabelled it "Timed out".
		mockGetProjectCodeIndexes.mockResolvedValue([]);
		const { cancelCodeIndexingForRepo } = await load();

		await cancelCodeIndexingForRepo({
			projectId: "proj-1",
			repositoryIntegrationId: "a",
		});

		expect(mockFailBackgroundJob).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowId: "code-index-proj-1-a",
				sourceId: "a",
			}),
			expect.objectContaining({ errorClass: "Cancelled" }),
		);
	});

	it("gives the cancelled job a reason a user can read", async () => {
		mockGetProjectCodeIndexes.mockResolvedValue([]);
		const { cancelCodeIndexingForRepo } = await load();

		await cancelCodeIndexingForRepo({
			projectId: "proj-1",
			repositoryIntegrationId: null,
		});

		// FR6: the panel renders this verbatim.
		expect(mockFailBackgroundJob).toHaveBeenCalledWith(
			expect.objectContaining({ workflowId: "code-index-proj-1-legacy" }),
			expect.objectContaining({
				error: expect.stringContaining("Cancelled"),
			}),
		);
	});

	it("no-ops when the repo has no INDEXING row", async () => {
		mockGetProjectCodeIndexes.mockResolvedValue([
			{
				repositoryIntegrationId: "a",
				status: "READY",
				workflowId: "wf-a",
			},
		]);
		const { cancelCodeIndexingForRepo } = await load();
		await cancelCodeIndexingForRepo({
			projectId: "proj-1",
			repositoryIntegrationId: "a",
		});
		expect(mockGetHandle).not.toHaveBeenCalled();
	});
});
