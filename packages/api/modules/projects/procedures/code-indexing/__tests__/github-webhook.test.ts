/**
 * Tests for the GitHub push webhook's per-repo behavior. The index is now keyed
 * by repository integration + branch, so the webhook must:
 *   - ignore pushes to a branch other than the integration's default branch
 *   - look up / mark stale the row for the matched integration only
 *   - key the incremental reindex workflow on the integration id
 */

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Set before the module loads — the handler reads the secret at import time.
const { SECRET } = vi.hoisted(() => {
	process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
	return { SECRET: "test-webhook-secret" };
});

const mockFindByRepoUrl = vi.fn();
const mockGetProjectCodeIndex = vi.fn();
const mockMarkCodeIndexStale = vi.fn();
const mockParseRepoUrl = vi.fn();
// `workflow.start` resolves to a WorkflowHandle; the Job Hub row records
// its firstExecutionRunId.
const mockStart = vi.fn(async () => ({
	firstExecutionRunId: "run-1",
}));

vi.mock("@repo/database", () => ({
	// Job Hub telemetry — a push-triggered re-index now opens a BackgroundJob
	// row so the panel explains why the repo is busy.
	createBackgroundJob: vi.fn(async () => "job-1"),
	seedSteps: (keys: string[]) =>
		keys.map((key) => ({ key, status: "pending" })),
	findByRepoUrl: (...a: unknown[]) => mockFindByRepoUrl(...a),
	getProjectCodeIndex: (...a: unknown[]) => mockGetProjectCodeIndex(...a),
	markCodeIndexStale: (...a: unknown[]) => mockMarkCodeIndexStale(...a),
	parseRepoUrl: (...a: unknown[]) => mockParseRepoUrl(...a),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { start: mockStart } }),
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));

// Avoid pulling the full oRPC/@repo/payments chain in just to load the exported
// helper — the procedure builder is unused here.
vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		route: () => chainable,
		input: () => chainable,
		handler: (fn: unknown) => ({ handler: fn }),
	});
	return { publicProcedure: chainable };
});

import { handleGitHubPushWebhook } from "../github-webhook";

function sign(rawBody: string) {
	return `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`;
}

function call(payload: Record<string, unknown>) {
	const rawBody = JSON.stringify(payload);
	return handleGitHubPushWebhook({
		signatureHeader: sign(rawBody),
		rawBody,
		payload,
	});
}

const integration = {
	id: "integ-1",
	projectId: "proj-1",
	provider: "GITHUB",
	repositoryName: "acme/repo",
	defaultBranch: "main",
	project: { userId: "user-1", organizationId: null },
};

beforeEach(() => {
	vi.clearAllMocks();
	process.env.FEATURE_CODE_INDEXING = undefined;
	mockFindByRepoUrl.mockResolvedValue(integration);
	mockParseRepoUrl.mockReturnValue({
		provider: "GITHUB",
		owner: "acme",
		name: "repo",
	});
});

describe("handleGitHubPushWebhook — per-repo", () => {
	it("ignores a push to a non-default branch", async () => {
		const result = await call({
			repository: { html_url: "https://github.com/acme/repo" },
			ref: "refs/heads/feature-x",
			commits: [],
		});
		expect(result.action).toBe("ignored_branch");
		expect(mockGetProjectCodeIndex).not.toHaveBeenCalled();
		expect(mockMarkCodeIndexStale).not.toHaveBeenCalled();
	});

	it("looks up the matched integration's row on a default-branch push", async () => {
		mockGetProjectCodeIndex.mockResolvedValue(null);
		const result = await call({
			repository: { html_url: "https://github.com/acme/repo" },
			ref: "refs/heads/main",
			commits: [],
		});
		expect(mockGetProjectCodeIndex).toHaveBeenCalledWith(
			"proj-1",
			"integ-1",
			"main",
		);
		expect(result.action).toBe("no_index");
	});

	it("marks only the matched integration's index stale", async () => {
		mockGetProjectCodeIndex.mockResolvedValue({ status: "READY" });
		const result = await call({
			repository: { html_url: "https://github.com/acme/repo" },
			ref: "refs/heads/main",
			commits: [],
		});
		expect(mockMarkCodeIndexStale).toHaveBeenCalledWith(
			"proj-1",
			"integ-1",
		);
		// FEATURE_CODE_INDEXING is off → stale only, no workflow.
		expect(result.action).toBe("stale_only");
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("keys the incremental reindex workflow on the integration id", async () => {
		process.env.FEATURE_CODE_INDEXING = "true";
		mockGetProjectCodeIndex.mockResolvedValue({ status: "READY" });
		const result = await call({
			repository: { html_url: "https://github.com/acme/repo" },
			ref: "refs/heads/main",
			commits: [{ modified: ["src/a.ts"] }],
		});
		expect(result.action).toBe("stale_and_reindex");
		expect(mockStart).toHaveBeenCalledTimes(1);
		const opts = mockStart.mock.calls[0][1];
		// Stable per-repo id + supersede policy (shared with the trigger).
		expect(opts.workflowId).toBe("code-index-proj-1-integ-1");
		expect(opts.workflowIdConflictPolicy).toBe("TERMINATE_EXISTING");
		expect(opts.args[0].integrationId).toBe("integ-1");
		expect(opts.args[0].branch).toBe("main");
		expect(opts.args[0].incremental).toBe(true);
		expect(opts.args[0].changedFiles).toEqual(["src/a.ts"]);
	});
});
