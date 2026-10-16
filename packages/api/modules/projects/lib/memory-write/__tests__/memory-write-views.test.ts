/**
 * The shared read shapes of the Living Memory write lane (ADR-022): what the
 * v1 routes and the MCP tools answer. The queries are mocked; what is pinned is
 * the shaping: paging, the folder boundary and what a receipt leaves out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getContextRepositorySync: vi.fn(),
	listContextWriteTargets: vi.fn(),
	getMemoryFolderState: vi.fn(),
	listMemoryFolderFiles: vi.fn(),
	getMemoryFolderFile: vi.fn(),
	getMemoryWriteReceipt: vi.fn(),
}));

vi.mock("@repo/database", () => mocks);

import {
	getMemoryFolderFilesView,
	getMemoryFolderFileView,
	getMemoryWriteTargetsView,
	getMemoryWriteView,
} from "../memory-write-views";

const scope = { projectId: "proj-1", organizationId: "org-1" };

const state = {
	sync: {
		id: "sync-1",
		ref: "main",
		automatic: true,
		automaticPausedReason: null,
		lastAppliedCommitSha: "c".repeat(40),
		repository: { provider: "GITHUB", owner: "example-org", name: "docs" },
	},
	target: {
		id: "target-1",
		folder: "docs/memory",
		mode: "PULL_REQUEST",
		version: 2,
	},
};

const file = (name: string) => ({
	path: `docs/memory/${name}`,
	blobOid: "a".repeat(40),
	contentHash: "b".repeat(64),
	bytes: 10,
});

beforeEach(() => {
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	mocks.getMemoryFolderState.mockResolvedValue(state);
});

describe("getMemoryWriteTargetsView", () => {
	it("has no folders and no sync for a project that is not connected", async () => {
		mocks.getContextRepositorySync.mockResolvedValue(null);
		mocks.listContextWriteTargets.mockResolvedValue([]);

		expect(await getMemoryWriteTargetsView(scope)).toEqual({
			sync: null,
			targets: [],
		});
	});

	it("says where the files go and whether they are ingested on their own", async () => {
		mocks.getContextRepositorySync.mockResolvedValue({
			ref: "main",
			lastAppliedCommitSha: "c".repeat(40),
			automatic: true,
			automaticPausedReason: "FAILURES",
			repositoryIntegration: {
				provider: "GITHUB",
				repositoryOwner: "example-org",
				repositoryName: "docs",
			},
		});
		mocks.listContextWriteTargets.mockResolvedValue([
			{
				id: "target-1",
				folder: "docs/memory",
				mode: "DIRECT_PUSH",
				version: 3,
				directPushEnabledById: "user-9",
			},
		]);

		const view = await getMemoryWriteTargetsView(scope);

		expect(view).toEqual({
			sync: {
				ref: "main",
				lastAppliedCommitSha: "c".repeat(40),
				ingesting: false,
				repository: {
					provider: "GITHUB",
					owner: "example-org",
					name: "docs",
				},
			},
			targets: [
				{
					id: "target-1",
					folder: "docs/memory",
					mode: "DIRECT_PUSH",
					version: 3,
				},
			],
		});
	});
});

describe("getMemoryFolderFilesView", () => {
	it("is null for a folder that is not the project's", async () => {
		mocks.getMemoryFolderState.mockResolvedValue(null);

		expect(
			await getMemoryFolderFilesView({
				...scope,
				targetId: "other",
				after: null,
				limit: 10,
			}),
		).toBeNull();
		expect(mocks.listMemoryFolderFiles).not.toHaveBeenCalled();
	});

	it("returns a page, with the commit it reflects and the cursor of the next", async () => {
		mocks.listMemoryFolderFiles.mockResolvedValue([
			file("a.md"),
			file("b.md"),
			file("c.md"),
		]);

		const view = await getMemoryFolderFilesView({
			...scope,
			targetId: "target-1",
			after: "docs/memory/0.md",
			limit: 2,
		});

		expect(mocks.listMemoryFolderFiles).toHaveBeenCalledWith(
			expect.objectContaining({
				syncId: "sync-1",
				folder: "docs/memory",
				after: "docs/memory/0.md",
				limit: 3,
			}),
		);
		expect(view?.files.map((f) => f.path)).toEqual([
			"docs/memory/a.md",
			"docs/memory/b.md",
		]);
		expect(view?.nextCursor).toBe("docs/memory/b.md");
		expect(view?.lastAppliedCommitSha).toBe("c".repeat(40));
	});

	it("has no cursor on the last page, and bounds the page size", async () => {
		mocks.listMemoryFolderFiles.mockResolvedValue([file("a.md")]);

		const view = await getMemoryFolderFilesView({
			...scope,
			targetId: "target-1",
			after: null,
			limit: 100_000,
		});

		expect(view?.nextCursor).toBeNull();
		expect(mocks.listMemoryFolderFiles).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 1001 }),
		);
	});
});

describe("getMemoryFolderFileView", () => {
	it("never reads a path outside the folder", async () => {
		expect(
			await getMemoryFolderFileView({
				...scope,
				targetId: "target-1",
				path: "src/index.ts",
			}),
		).toBeNull();
		expect(
			await getMemoryFolderFileView({
				...scope,
				targetId: "target-1",
				path: "docs/memory-archive/a.md",
			}),
		).toBeNull();
		expect(mocks.getMemoryFolderFile).not.toHaveBeenCalled();
	});

	it("returns the file with the commit the sync reflects", async () => {
		mocks.getMemoryFolderFile.mockResolvedValue({
			...file("a.md"),
			content: "# A\n",
		});

		const view = await getMemoryFolderFileView({
			...scope,
			targetId: "target-1",
			path: "docs/memory/a.md",
		});

		expect(view).toMatchObject({
			targetId: "target-1",
			path: "docs/memory/a.md",
			content: "# A\n",
			lastAppliedCommitSha: "c".repeat(40),
		});
	});
});

describe("getMemoryWriteView", () => {
	it("is null for a write that is not the project's", async () => {
		mocks.getMemoryWriteReceipt.mockResolvedValue(null);

		expect(await getMemoryWriteView({ ...scope, writeId: "w" })).toBeNull();
	});

	it("shows the status and outcome, never a message or a staged key", async () => {
		mocks.getMemoryWriteReceipt.mockResolvedValue({
			id: "w",
			status: "PENDING",
			digest: "d",
			targetId: "target-1",
			folder: "docs/memory",
			mode: "PULL_REQUEST",
			ref: "main",
			via: "MCP",
			message: "never shown",
			entries: [{ path: "docs/memory/a.md", op: "PUT", stagedKey: "k" }],
			outcome: null,
			createdAt: new Date(0),
			settledAt: null,
		});

		const view = await getMemoryWriteView({ ...scope, writeId: "w" });

		expect(view?.entries).toEqual([
			{ path: "docs/memory/a.md", op: "PUT" },
		]);
		expect(view?.outcome).toBeNull();
		expect(JSON.stringify(view)).not.toMatch(/never shown|stagedKey/);
	});
});
