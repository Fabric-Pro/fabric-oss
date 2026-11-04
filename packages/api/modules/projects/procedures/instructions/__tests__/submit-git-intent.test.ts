/**
 * Native repository changes against the member's proposal branch: a delete
 * or an edit of a file only the caller's OWN accepting branch holds is
 * admitted branch-relative, freezing the blob Fabric wrote there and keeping
 * its mode; a delete of a path neither the published version nor that
 * branch holds is refused as before. The repository reads, admission and
 * storage are mocks; the change validation is the real one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	admitGitIntent: vi.fn(),
	findExistingGitIntent: vi.fn(),
	readMemberBranchWrittenPaths: vi.fn(),
	listDirectRepositoryFiles: vi.fn(),
	admit: vi.fn(),
	startAdmittedProposalPullRequest: vi.fn(),
	startDirectCommitWorkflow: vi.fn(),
	uploadFile: vi.fn(),
	deleteObjects: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	admitGitIntent: (...a: unknown[]) => m.admitGitIntent(...a),
	findExistingGitIntent: (...a: unknown[]) => m.findExistingGitIntent(...a),
	readMemberBranchWrittenPaths: (...a: unknown[]) =>
		m.readMemberBranchWrittenPaths(...a),
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		uploadFile: m.uploadFile,
		deleteObjects: m.deleteObjects,
	}),
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));
vi.mock("../repository/direct-source", () => ({
	loadDirectRepositorySource: async () => ({
		integrationId: "int_example",
		rootPath: "",
		ref: "main",
	}),
	assertDirectRepositoryPin: async () => {},
	assertDirectRepositorySourceCurrent: async () => {},
	resolveDirectRepositoryIgnore: async () => ({
		layer: "default",
		globs: [],
	}),
}));
vi.mock("../repository/direct-read", () => ({
	listDirectRepositoryFiles: (...a: unknown[]) =>
		m.listDirectRepositoryFiles(...a),
}));
vi.mock("../proposal-admission", () => ({
	admitInstructionProposal: (...a: unknown[]) => m.admit(...a),
}));
vi.mock("../proposal-pull-request", () => ({
	startAdmittedProposalPullRequest: (...a: unknown[]) =>
		m.startAdmittedProposalPullRequest(...a),
}));
vi.mock("../direct-commit-workflow", () => ({
	startDirectCommitWorkflow: (...a: unknown[]) =>
		m.startDirectCommitWorkflow(...a),
}));

import type { GitIntentEntry } from "@repo/database";
import { type NativeChange, submitGitIntentChange } from "../submit-git-intent";

const PROJECT = "proj_example";
const ORG = "org_example";
const MEMBER = "user_example_member";
const OTHER = "user_example_other";
const BLOB = "a".repeat(40);
const BRANCH_BLOB = "b".repeat(40);

/** What the member's accepting branch holds, keyed by owner. */
const branchFiles = new Map<string, Map<string, unknown>>([
	[
		MEMBER,
		new Map([
			[
				"rules/branch-only.md",
				{
					path: "rules/branch-only.md",
					branchId: "branch_example",
					objectId: BRANCH_BLOB,
					mode: 0o100644,
					sha256: "c".repeat(64),
				},
			],
			[
				"scripts/tool.sh",
				{
					path: "scripts/tool.sh",
					branchId: "branch_example",
					objectId: BRANCH_BLOB,
					mode: 0o100755,
					sha256: "d".repeat(64),
				},
			],
		]),
	],
]);

function submit(
	changes: NativeChange[],
	over: { userId?: string; mode?: "proposal" | "commit" } = {},
) {
	return submitGitIntentChange({
		projectId: PROJECT,
		organizationId: ORG,
		userId: over.userId ?? MEMBER,
		nativeBase: { generation: 1, commitSha: "e".repeat(40) },
		mode: over.mode ?? "proposal",
		changes,
		audit: {
			user: {
				id: over.userId ?? MEMBER,
				email: "dev@example.com",
				name: "Example Member",
			},
		},
		via: "test",
	});
}

function admittedEntries(): GitIntentEntry[] {
	return m.admitGitIntent.mock.calls.at(-1)?.[0]?.entries ?? [];
}

beforeEach(() => {
	vi.resetAllMocks();
	m.listDirectRepositoryFiles.mockResolvedValue({
		incomplete: false,
		refusal: null,
		files: [
			{
				path: "rules/a.md",
				kind: "rule",
				blobId: BLOB,
				mode: "100644",
			},
		],
	});
	m.readMemberBranchWrittenPaths.mockImplementation(
		async (i: { userId: string; paths: string[] }) =>
			new Map(
				i.paths.flatMap((path) => {
					const file = branchFiles.get(i.userId)?.get(path);
					return file ? [[path, file] as const] : [];
				}),
			),
	);
	m.admit.mockResolvedValue({
		destination: "REPOSITORY",
		note: null,
		operationId: "op_example",
		context: {},
		syncId: "sync_example",
		syncGeneration: 1,
	});
	m.findExistingGitIntent.mockResolvedValue(null);
	m.admitGitIntent.mockResolvedValue({
		ok: true,
		snapshotId: "snap_example",
		version: 2,
		changeSetDigest: "digest",
		existing: false,
	});
});

describe("branch-relative changes", () => {
	it("admits a delete of a file only the caller's branch holds, freezing its blob", async () => {
		await submit([{ op: "delete", path: "rules/branch-only.md" }]);
		expect(admittedEntries()).toEqual([
			{
				op: "DELETE",
				path: "rules/branch-only.md",
				base: null,
				branchObjectId: BRANCH_BLOB,
			},
		]);
		expect(m.readMemberBranchWrittenPaths).toHaveBeenCalledWith({
			projectId: PROJECT,
			userId: MEMBER,
			organizationId: ORG,
			paths: ["rules/branch-only.md"],
		});
	});

	it("refuses a delete of a path neither the published version nor the caller's branch holds", async () => {
		await expect(
			submit([{ op: "delete", path: "rules/nowhere.md" }]),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { reason: "REPOSITORY_BASE_UNAVAILABLE" },
		});
		expect(m.admitGitIntent).not.toHaveBeenCalled();
	});

	it("never acts on another member's branch: the same delete by another member is refused", async () => {
		await expect(
			submit([{ op: "delete", path: "rules/branch-only.md" }], {
				userId: OTHER,
			}),
		).rejects.toMatchObject({
			data: { reason: "REPOSITORY_BASE_UNAVAILABLE" },
		});
		expect(m.readMemberBranchWrittenPaths).toHaveBeenCalledWith(
			expect.objectContaining({ userId: OTHER }),
		);
		expect(m.admitGitIntent).not.toHaveBeenCalled();
	});

	it("keeps a branch-only file's 100755 mode on an edit", async () => {
		await submit([
			{
				op: "put",
				path: "scripts/tool.sh",
				content: Buffer.from("#!/bin/sh\necho edited\n"),
			},
		]);
		expect(admittedEntries()).toEqual([
			expect.objectContaining({
				op: "PUT",
				path: "scripts/tool.sh",
				base: null,
				mode: 0o100755,
				branchObjectId: BRANCH_BLOB,
			}),
		]);
	});

	it("leaves a published path published-relative and a new path a plain add", async () => {
		await submit([
			{ op: "put", path: "rules/a.md", content: Buffer.from("alpha\n") },
			{ op: "put", path: "rules/new.md", content: Buffer.from("new\n") },
		]);
		const [published, added] = admittedEntries();
		expect(published).toMatchObject({
			path: "rules/a.md",
			base: { objectId: BLOB, mode: 0o100644 },
			mode: 0o100644,
		});
		expect(published).not.toHaveProperty("branchObjectId");
		expect(added).toMatchObject({ path: "rules/new.md", base: null });
		expect(added).not.toHaveProperty("branchObjectId");
		expect(m.readMemberBranchWrittenPaths).toHaveBeenCalledWith(
			expect.objectContaining({ paths: ["rules/new.md"] }),
		);
	});

	it("reads no branch for a direct commit, which never targets a member's branch", async () => {
		m.admit.mockResolvedValue({
			destination: "REPOSITORY_COMMIT",
			note: null,
			context: { message: "Delete" },
		});
		await expect(
			submit([{ op: "delete", path: "rules/branch-only.md" }], {
				mode: "commit",
			}),
		).rejects.toMatchObject({
			data: { reason: "REPOSITORY_BASE_UNAVAILABLE" },
		});
		expect(m.readMemberBranchWrittenPaths).toHaveBeenCalledWith(
			expect.objectContaining({ paths: [] }),
		);
	});
});
