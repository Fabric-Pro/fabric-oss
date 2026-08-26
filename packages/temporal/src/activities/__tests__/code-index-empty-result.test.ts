/**
 * What "nothing was indexed" is allowed to mean.
 *
 * A full run that walks files and produces no chunk leaves an index agents will
 * search and find nothing in, so it must not report success. An incremental run
 * that produces no chunk usually means the push touched nothing indexable —
 * docs, config, deletions — and the existing index is fine. The two differ only
 * by a flag, and getting it backwards puts a confident, wrong diagnosis on a
 * healthy repository.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const jobMocks = vi.hoisted(() => ({
	jobStep: vi.fn(),
	jobComplete: vi.fn(),
	jobFail: vi.fn(),
	jobSetCounts: vi.fn(),
	jobEnsure: vi.fn(),
	jobIncrement: vi.fn(),
	jobHeartbeat: vi.fn(),
}));

vi.mock("../lib/job-progress", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ...jobMocks };
});

const dbMocks = vi.hoisted(() => ({
	updateCodeIndexStats: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ...dbMocks };
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			info: {
				workflowExecution: {
					workflowId: "code-index-proj-1-repo-1",
					runId: "run-1",
				},
			},
		}),
	},
	heartbeat: vi.fn(),
}));

import { updateCodeIndexActivity } from "../code-indexing";

const BASE = {
	projectId: "proj-1",
	repositoryIntegrationId: "repo-1",
	branch: "main",
	userId: "user-1",
	organizationId: "org-1",
	commitSha: "abc123",
	summariesCreated: 0,
	indexDurationMs: 1000,
	fileManifest: [],
	redactionManifest: [],
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("updateCodeIndexActivity", () => {
	it("fails a full run that walked files but embedded nothing", async () => {
		await updateCodeIndexActivity({
			...BASE,
			filesIndexed: 29,
			chunksCreated: 0,
		} as never);

		expect(jobMocks.jobComplete).not.toHaveBeenCalled();
		expect(jobMocks.jobFail).toHaveBeenCalledWith(
			expect.stringContaining("No content was indexed"),
			expect.objectContaining({ errorClass: "NothingIndexed" }),
		);
	});

	it("names the step that produced nothing rather than marking it complete", async () => {
		await updateCodeIndexActivity({
			...BASE,
			filesIndexed: 29,
			chunksCreated: 0,
		} as never);

		// A red badge above seven green steps would be a fresh misreport.
		expect(jobMocks.jobStep).toHaveBeenCalledWith(
			"embed",
			"failed",
			expect.anything(),
		);
		expect(jobMocks.jobStep).not.toHaveBeenCalledWith(
			"embed",
			"completed",
			expect.anything(),
		);
	});

	it("keeps the counts on the failed card", async () => {
		await updateCodeIndexActivity({
			...BASE,
			filesIndexed: 29,
			chunksCreated: 0,
		} as never);

		// "29/29 files indexed" is what makes the failure legible.
		expect(jobMocks.jobSetCounts).toHaveBeenCalledWith(
			expect.objectContaining({ filesProcessed: 29, totalFiles: 29 }),
			"repo-1",
		);
	});

	it("does NOT fail an incremental run that had nothing to embed", async () => {
		await updateCodeIndexActivity({
			...BASE,
			filesIndexed: 29,
			chunksCreated: 0,
			incremental: true,
		} as never);

		// `filesIndexed` is the whole repo walk; only the changed subset is
		// embedded. A push touching only docs, config or deletions lands here
		// with a perfectly good index.
		expect(jobMocks.jobFail).not.toHaveBeenCalled();
		expect(jobMocks.jobComplete).toHaveBeenCalled();
	});

	it("completes a full run that produced chunks", async () => {
		await updateCodeIndexActivity({
			...BASE,
			filesIndexed: 29,
			chunksCreated: 400,
		} as never);

		expect(jobMocks.jobFail).not.toHaveBeenCalled();
		expect(jobMocks.jobComplete).toHaveBeenCalled();
	});

	it("does not fail a run that had no files to begin with", async () => {
		await updateCodeIndexActivity({
			...BASE,
			filesIndexed: 0,
			chunksCreated: 0,
		} as never);

		expect(jobMocks.jobFail).not.toHaveBeenCalled();
		expect(jobMocks.jobComplete).toHaveBeenCalled();
	});
});
