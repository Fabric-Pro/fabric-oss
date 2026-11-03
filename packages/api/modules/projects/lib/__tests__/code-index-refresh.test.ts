import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	findIndex: vi.fn(),
	findProject: vi.fn(),
	indexes: vi.fn(),
	integration: vi.fn(),
	stale: vi.fn(),
	record: vi.fn(),
	token: vi.fn(),
	compare: vi.fn(),
	start: vi.fn(),
	canEdit: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	canEditProject: m.canEdit,
	db: {
		projectCodeIndex: { findUnique: m.findIndex },
		project: { findUnique: m.findProject },
	},
	getProjectCodeIndexes: m.indexes,
	getProjectRepoIntegration: m.integration,
	markCodeIndexStale: m.stale,
	recordCodeIndexRefreshCheck: m.record,
}));
vi.mock("@repo/integrations", () => ({ resolveFreshRepoToken: m.token }));
vi.mock("../repo-compare", () => ({ compareIndexedCommitToHead: m.compare }));
vi.mock("../code-indexing-trigger", () => ({
	startCodeIndexingForProject: m.start,
}));

import {
	refreshCodeIndexOnSchedule,
	reindexContextCoveredPaths,
} from "../code-index-refresh";

const now = new Date("2026-10-29T12:00:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
	m.findIndex.mockResolvedValue({
		id: "idx-1",
		projectId: "p1",
		repositoryIntegrationId: "ri-1",
		userId: "user-1",
	});
	m.findProject.mockResolvedValue({
		organizationId: "org-example",
		ragSettings: { codeSearchMode: "RAG" },
	});
	m.integration.mockResolvedValue({
		provider: "GITHUB",
		repositoryOwner: "example-org",
		repositoryName: "booking-app",
		repositoryUrl: "https://github.com/example-org/booking-app",
		azureOrganization: null,
		includedInCodeSearch: true,
	});
	m.indexes.mockResolvedValue([
		{
			repositoryIntegrationId: "ri-1",
			commitSha: "abc",
			branch: "main",
			indexedAt: now,
		},
	]);
	m.token.mockResolvedValue({ token: "token-for-test" });
	m.start.mockResolvedValue({ started: 1, skipped: [] });
	m.canEdit.mockResolvedValue(true);
});

describe("refreshCodeIndexOnSchedule", () => {
	it("re-embeds only the changed files under the project's organization", async () => {
		m.compare.mockResolvedValue({
			status: "ahead",
			aheadBy: 2,
			truncated: false,
			changedFiles: ["src/a.ts", "src/b.ts"],
		});
		expect(
			await refreshCodeIndexOnSchedule({ codeIndexId: "idx-1", now }),
		).toBe("started");
		expect(m.start).toHaveBeenCalledWith({
			projectId: "p1",
			userId: "user-1",
			organizationId: "org-example",
			repositoryIntegrationId: "ri-1",
			incremental: true,
			changedFiles: ["src/a.ts", "src/b.ts"],
		});
		expect(m.record).toHaveBeenCalledWith({
			id: "idx-1",
			checkedAt: now,
			error: null,
		});
	});

	it("starts nothing when the branch has not moved", async () => {
		m.compare.mockResolvedValue({
			status: "identical",
			aheadBy: 0,
			truncated: false,
			changedFiles: [],
		});
		expect(
			await refreshCodeIndexOnSchedule({ codeIndexId: "idx-1", now }),
		).toBe("up-to-date");
		expect(m.start).not.toHaveBeenCalled();
	});

	it("never starts a full rebuild on its own: marks the index stale with the reason", async () => {
		m.compare.mockResolvedValue({
			status: "ahead",
			aheadBy: 400,
			truncated: true,
			changedFiles: [],
		});
		expect(
			await refreshCodeIndexOnSchedule({ codeIndexId: "idx-1", now }),
		).toBe("needs-full-reindex");
		expect(m.start).not.toHaveBeenCalled();
		expect(m.stale).toHaveBeenCalledWith("p1", "ri-1");
		expect(m.record).toHaveBeenCalledWith(
			expect.objectContaining({
				error: expect.stringContaining("full re-index"),
			}),
		);
	});

	it.each(["OFF", "CODE_SEARCH"])(
		"checks nothing when the project's code search mode is %s",
		async (mode) => {
			m.findProject.mockResolvedValue({
				organizationId: "org-example",
				ragSettings: { codeSearchMode: mode },
			});
			expect(
				await refreshCodeIndexOnSchedule({ codeIndexId: "idx-1", now }),
			).toBe("not-indexable");
			expect(m.token).not.toHaveBeenCalled();
			expect(m.compare).not.toHaveBeenCalled();
			expect(m.start).not.toHaveBeenCalled();
		},
	);

	it("checks nothing for a repository left out of code search", async () => {
		m.integration.mockResolvedValue({
			provider: "GITHUB",
			repositoryOwner: "example-org",
			repositoryName: "booking-app",
			repositoryUrl: "https://github.com/example-org/booking-app",
			azureOrganization: null,
			includedInCodeSearch: false,
		});
		expect(
			await refreshCodeIndexOnSchedule({ codeIndexId: "idx-1", now }),
		).toBe("not-indexable");
		expect(m.compare).not.toHaveBeenCalled();
	});

	it("keeps the index ready and retries later when the compare fails", async () => {
		m.compare.mockResolvedValue({
			status: "unknown",
			aheadBy: 0,
			truncated: false,
			changedFiles: [],
		});
		expect(
			await refreshCodeIndexOnSchedule({ codeIndexId: "idx-1", now }),
		).toBe("compare-failed");
		expect(m.start).not.toHaveBeenCalled();
		expect(m.stale).not.toHaveBeenCalled();
		expect(m.record).toHaveBeenCalledWith(
			expect.objectContaining({
				error: expect.stringContaining("reconnect"),
			}),
		);
	});

	it("reports a repository without a usable token", async () => {
		m.token.mockResolvedValue({ token: null });
		expect(
			await refreshCodeIndexOnSchedule({ codeIndexId: "idx-1", now }),
		).toBe("no-credentials");
		expect(m.start).not.toHaveBeenCalled();
	});

	it("acts for the index's creator only while they may still edit the project", async () => {
		m.canEdit.mockResolvedValue(false);
		expect(
			await refreshCodeIndexOnSchedule({ codeIndexId: "idx-1", now }),
		).toBe("no-credentials");
		expect(m.canEdit).toHaveBeenCalledWith("p1", "user-1");
		expect(m.token).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});
});

describe("reindexContextCoveredPaths", () => {
	const params = {
		projectId: "p1",
		repositoryIntegrationId: "ri-1",
		paths: ["docs/guide.md"],
	};
	const ready = (status: string) => {
		m.indexes.mockResolvedValue([
			{
				repositoryIntegrationId: "ri-1",
				commitSha: "abc",
				branch: "main",
				indexedAt: now,
				status,
				userId: "user-1",
			},
		]);
	};

	it("re-runs the code index for the Living Memory files and any unseen commits", async () => {
		ready("READY");
		m.compare.mockResolvedValue({
			status: "ahead",
			aheadBy: 1,
			truncated: false,
			changedFiles: ["src/a.ts", "docs/guide.md"],
		});
		expect(await reindexContextCoveredPaths(params)).toBe("started");
		expect(m.start).toHaveBeenCalledWith({
			projectId: "p1",
			userId: "user-1",
			organizationId: "org-example",
			repositoryIntegrationId: "ri-1",
			incremental: true,
			changedFiles: ["docs/guide.md", "src/a.ts"],
		});
	});

	it("re-runs only the Living Memory files when the branch has not moved", async () => {
		ready("READY");
		m.compare.mockResolvedValue({
			status: "identical",
			aheadBy: 0,
			truncated: false,
			changedFiles: [],
		});
		expect(await reindexContextCoveredPaths(params)).toBe("started");
		expect(m.start).toHaveBeenCalledWith(
			expect.objectContaining({ changedFiles: ["docs/guide.md"] }),
		);
	});

	it("starts nothing over a run in flight: it decides the files per batch itself", async () => {
		ready("INDEXING");
		expect(await reindexContextCoveredPaths(params)).toBe("indexing");
		expect(m.start).not.toHaveBeenCalled();
	});

	it("starts nothing once the index's creator may no longer edit the project", async () => {
		ready("READY");
		m.canEdit.mockResolvedValue(false);
		expect(await reindexContextCoveredPaths(params)).toBe("not-indexable");
		expect(m.canEdit).toHaveBeenCalledWith("p1", "user-1");
		expect(m.token).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});

	it("starts nothing before the first index", async () => {
		m.indexes.mockResolvedValue([]);
		expect(await reindexContextCoveredPaths(params)).toBe("no-index");
		expect(m.start).not.toHaveBeenCalled();
	});

	it("marks the index stale when the unseen commits cannot be listed", async () => {
		ready("READY");
		m.compare.mockResolvedValue({
			status: "ahead",
			aheadBy: 400,
			truncated: true,
			changedFiles: [],
		});
		expect(await reindexContextCoveredPaths(params)).toBe(
			"needs-full-reindex",
		);
		expect(m.stale).toHaveBeenCalledWith("p1", "ri-1");
		expect(m.start).not.toHaveBeenCalled();
	});

	it("does nothing for a repository left out of code search", async () => {
		m.integration.mockResolvedValue({ includedInCodeSearch: false });
		expect(await reindexContextCoveredPaths(params)).toBe("not-indexable");
		expect(m.start).not.toHaveBeenCalled();
	});
});
