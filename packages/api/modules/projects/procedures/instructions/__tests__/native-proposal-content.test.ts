import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	intent: vi.fn(),
	read: vi.fn(),
	download: vi.fn(),
	source: vi.fn(),
	current: vi.fn(),
	files: vi.fn(),
	assertPin: vi.fn(),
	branchWrite: vi.fn(),
}));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	loadGitIntent: m.intent,
	listInstructionFiles: m.files,
	findMemberBranchWrite: m.branchWrite,
}));
vi.mock("@repo/connectors", () => ({ readRepositoryFileAtCommit: m.read }));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ downloadFile: m.download }),
}));
vi.mock("../repository/direct-source", () => ({
	loadDirectRepositorySource: m.source,
	assertDirectRepositoryPin: m.assertPin,
	assertDirectRepositorySourceCurrent: m.current,
	directRepositoryPath: (_source: object, path: string) => path,
}));

import {
	buildNativeProposalChanges,
	readNativeProposalFile,
} from "../native-proposal-content";

const scope = {
	projectId: "project_example",
	organizationId: "org_example",
	userId: "user_example",
	snapshotId: "operation_example",
};
const bytes = Buffer.from("changed\r\n");
beforeEach(() => {
	vi.clearAllMocks();
	m.source.mockResolvedValue({
		integrationId: "integration_example",
		ref: "main",
		generation: 1,
		repository: {},
	});
	m.current.mockResolvedValue(undefined);
	m.intent.mockResolvedValue({
		status: "READY",
		repositoryGeneration: 1,
		sourceCommitSha: "a".repeat(40),
		repositoryIntegrationId: "integration_example",
		sourceRef: "main",
		gitIntentEntries: [
			{
				operation: "PUT",
				path: "CLAUDE.md",
				baseObjectId: "b".repeat(40),
				storageKey: "changed/object",
				sha256: createHash("sha256").update(bytes).digest("hex"),
				size: bytes.length,
				isText: true,
			},
			{
				operation: "DELETE",
				path: "old.md",
				baseObjectId: "c".repeat(40),
				storageKey: null,
				sha256: null,
				size: null,
				isText: null,
			},
		],
	});
	m.read.mockResolvedValue({
		ok: true,
		state: "found",
		bytes: Buffer.from("before\r\n"),
	});
	m.download.mockResolvedValue({ data: bytes });
});

it("previews only changed paths at the frozen Git base, including deletes", async () => {
	const changes = await buildNativeProposalChanges(scope);
	expect(changes).toMatchObject([
		{
			path: "CLAUDE.md",
			op: "edit",
			before: "before\r\n",
			after: "changed\r\n",
		},
		{ path: "old.md", op: "delete", after: null },
	]);
	expect(m.read.mock.calls.map(([input]) => input.path)).toEqual([
		"CLAUDE.md",
		"old.md",
	]);
	expect(m.read).toHaveBeenCalledWith(
		expect.objectContaining({ sha: "a".repeat(40) }),
	);
	expect(m.download).toHaveBeenCalledTimes(1);
	expect(m.files).not.toHaveBeenCalled();
});

it("pages immutable changed bytes and refuses corrupt storage", async () => {
	await expect(
		readNativeProposalFile({
			...scope,
			path: "CLAUDE.md",
			side: "after",
			offset: 2,
			maxLength: 3,
		}),
	).resolves.toMatchObject({ body: "ang", nextOffset: 5, truncated: true });
	m.download.mockResolvedValue({ data: Buffer.from("corrupt") });
	await expect(
		readNativeProposalFile({
			...scope,
			path: "CLAUDE.md",
			side: "after",
			offset: 0,
			maxLength: 3,
		}),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("refuses missing/deleted after paths without falling back to Git", async () => {
	for (const path of ["old.md", "missing.md"]) {
		await expect(
			readNativeProposalFile({
				...scope,
				path,
				side: "after",
				offset: 0,
				maxLength: 3,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	}
	expect(m.read).not.toHaveBeenCalled();
});

it("rechecks source access before returning native content", async () => {
	m.current.mockRejectedValue(new Error("access revoked"));
	await expect(buildNativeProposalChanges(scope)).rejects.toThrow(
		"access revoked",
	);
});

it("keeps a proposal viewable after the repository configuration changed, without reading its base", async () => {
	m.source.mockResolvedValue({
		integrationId: "integration_example",
		ref: "main",
		generation: 2,
		repository: {},
	});

	const changes = await buildNativeProposalChanges(scope);

	expect(changes).toMatchObject([
		{
			path: "CLAUDE.md",
			op: "edit",
			before: null,
			beforeOmitted: "SOURCE_CHANGED",
			after: "changed\r\n",
			afterOmitted: null,
		},
		{ path: "old.md", op: "delete", before: null, after: null },
	]);
	expect(m.read).not.toHaveBeenCalled();
	expect(m.assertPin).not.toHaveBeenCalled();
	expect(m.current).not.toHaveBeenCalled();
});

it("keeps a proposal viewable after the project moved to another branch or integration", async () => {
	for (const moved of [{ ref: "release" }, { integrationId: "other" }]) {
		m.source.mockResolvedValue({
			integrationId: "integration_example",
			ref: "main",
			generation: 1,
			repository: {},
			...moved,
		});

		await expect(buildNativeProposalChanges(scope)).resolves.toHaveLength(
			2,
		);
	}
	expect(m.read).not.toHaveBeenCalled();
});

describe("branch-relative entries", () => {
	const sha = (data: Buffer) =>
		createHash("sha256").update(data).digest("hex");
	const onBranch = Buffer.from("written on the branch\n");
	const toRemove = Buffer.from("also on the branch\n");
	const proposal = {
		status: "READY",
		userId: "proposer_example",
		repositoryGeneration: 1,
		sourceCommitSha: "a".repeat(40),
		repositoryIntegrationId: "integration_example",
		sourceRef: "main",
		gitIntentEntries: [
			{
				operation: "PUT",
				path: "notes/branch.md",
				baseObjectId: null,
				branchObjectId: "d".repeat(40),
				storageKey: "changed/object",
				sha256: sha(bytes),
				size: bytes.length,
				isText: true,
			},
			{
				operation: "DELETE",
				path: "notes/gone.md",
				baseObjectId: null,
				branchObjectId: "e".repeat(40),
				storageKey: null,
				sha256: null,
				size: null,
				isText: null,
			},
		],
	};
	/** The earlier proposal whose stored files Fabric wrote on the branch. */
	const earlier = {
		status: "READY",
		gitIntentEntries: [
			{
				operation: "PUT",
				path: "notes/branch.md",
				storageKey: "branch/object",
				sha256: sha(onBranch),
				size: onBranch.length,
				mimeType: "text/markdown",
				isText: true,
				mode: 0o100644,
			},
			{
				operation: "PUT",
				path: "notes/gone.md",
				storageKey: "gone/object",
				sha256: sha(toRemove),
				size: toRemove.length,
				mimeType: "text/markdown",
				isText: true,
				mode: 0o100644,
			},
		],
	};

	beforeEach(() => {
		m.intent.mockImplementation(async ({ snapshotId }) =>
			snapshotId === scope.snapshotId ? proposal : earlier,
		);
		m.branchWrite.mockImplementation(async ({ path }) => ({
			snapshotId: "proposal_earlier",
			sha256: sha(path === "notes/branch.md" ? onBranch : toRemove),
		}));
		m.download.mockImplementation(async (key: string) => ({
			data:
				key === "branch/object"
					? onBranch
					: key === "gone/object"
						? toRemove
						: bytes,
		}));
	});

	it("shows an edit or delete of the branch's file, with the branch's bytes as the before side", async () => {
		const changes = await buildNativeProposalChanges(scope);

		expect(changes).toMatchObject([
			{
				path: "notes/branch.md",
				op: "edit",
				before: "written on the branch\n",
				beforeOmitted: null,
				after: "changed\r\n",
			},
			{
				path: "notes/gone.md",
				op: "delete",
				before: "also on the branch\n",
				beforeOmitted: null,
				after: null,
			},
		]);
		expect(m.branchWrite).toHaveBeenCalledWith({
			projectId: scope.projectId,
			userId: "proposer_example",
			organizationId: scope.organizationId,
			path: "notes/branch.md",
			objectId: "d".repeat(40),
		});
		expect(m.read).not.toHaveBeenCalled();
	});

	it("pages the branch's before side", async () => {
		await expect(
			readNativeProposalFile({
				...scope,
				path: "notes/branch.md",
				side: "before",
				offset: 0,
				maxLength: 7,
			}),
		).resolves.toMatchObject({ body: "written", truncated: true });
	});

	it("says the source changed, still as an edit, when Fabric no longer holds the branch's bytes", async () => {
		m.branchWrite.mockResolvedValue(null);

		const changes = await buildNativeProposalChanges(scope);

		expect(changes[0]).toMatchObject({
			path: "notes/branch.md",
			op: "edit",
			before: null,
			beforeOmitted: "SOURCE_CHANGED",
			after: "changed\r\n",
		});
	});

	it("refuses stored branch bytes that no longer match the journal's hash", async () => {
		m.branchWrite.mockResolvedValue({
			snapshotId: "proposal_earlier",
			sha256: "f".repeat(64),
		});

		const changes = await buildNativeProposalChanges(scope);

		expect(changes[0]).toMatchObject({
			before: null,
			beforeOmitted: "SOURCE_CHANGED",
		});
	});
});

it("pages the changed side of a proposal whose configuration changed, and refuses its base", async () => {
	m.source.mockResolvedValue({
		integrationId: "integration_example",
		ref: "main",
		generation: 2,
		repository: {},
	});

	await expect(
		readNativeProposalFile({
			...scope,
			path: "CLAUDE.md",
			side: "after",
			offset: 0,
			maxLength: 3,
		}),
	).resolves.toMatchObject({ body: "cha" });
	await expect(
		readNativeProposalFile({
			...scope,
			path: "CLAUDE.md",
			side: "before",
			offset: 0,
			maxLength: 3,
		}),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	expect(m.read).not.toHaveBeenCalled();
});
