/**
 * `openConsolidationCleanupActivity` records what a merge from Fabric needs:
 * the pull request's provider id and the head Fabric first saw, never
 * replacing that head on a retry. The workflow's result keeps its shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getInstructionConsolidation: vi.fn(),
	updateInstructionConsolidation: vi.fn(),
	runConsolidationCleanup: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getInstructionConsolidation: m.getInstructionConsolidation,
	updateInstructionConsolidation: m.updateInstructionConsolidation,
	getProjectRepoIntegration: vi.fn(),
	upsertInstructionRepositorySync: vi.fn(),
	InstructionMigrationOpenError: class extends Error {},
}));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("@temporalio/activity", () => ({
	ApplicationFailure: {
		nonRetryable: (message: string) => new Error(message),
		retryable: (message: string) => new Error(message),
	},
	Context: {
		current: () => ({
			cancellationSignal: new AbortController().signal,
			info: { attempt: 1 },
		}),
	},
}));
vi.mock("../lib/instruction-consolidation-git", () => ({
	ConsolidationStepError: class extends Error {},
	runConsolidationCleanup: m.runConsolidationCleanup,
	runConsolidationCopy: vi.fn(),
}));

import { openConsolidationCleanupActivity } from "../instruction-consolidation";

const INPUT = {
	consolidationId: "run-1",
	projectId: "proj-1",
	organizationId: "org-1",
	userId: "user-1",
	author: { name: "Example", email: "dev@example.com" },
	committer: { name: "Example", email: "dev@example.com" },
	date: "2026-11-04T10:00:00Z",
};

const PR_URL = "https://github.com/example-org/example-app/pull/7";

function run(over: Record<string, unknown> = {}) {
	return {
		id: "run-1",
		sourceIntegrationId: "int-code",
		targetIntegrationId: "int-target",
		targetRepositoryUrl: "https://github.com/example-org/example-app-ai",
		files: [],
		cleanupHeadSha: null,
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	m.runConsolidationCleanup.mockResolvedValue({
		pullRequestUrl: PR_URL,
		pullRequestId: "7",
		headSha: "a".repeat(40),
	});
});

describe("openConsolidationCleanupActivity", () => {
	it("stores the url, the provider id and the head, and returns only the url", async () => {
		m.getInstructionConsolidation.mockResolvedValue(run());
		await expect(openConsolidationCleanupActivity(INPUT)).resolves.toEqual({
			pullRequestUrl: PR_URL,
		});
		expect(m.updateInstructionConsolidation).toHaveBeenCalledWith(
			"run-1",
			"proj-1",
			{
				cleanupPullRequestUrl: PR_URL,
				cleanupPullRequestId: "7",
				cleanupHeadSha: "a".repeat(40),
			},
		);
	});

	it("never replaces a head it already recorded", async () => {
		m.getInstructionConsolidation.mockResolvedValue(
			run({ cleanupHeadSha: "b".repeat(40) }),
		);
		await openConsolidationCleanupActivity(INPUT);
		expect(m.updateInstructionConsolidation).toHaveBeenCalledWith(
			"run-1",
			"proj-1",
			{ cleanupPullRequestUrl: PR_URL, cleanupPullRequestId: "7" },
		);
	});
});
