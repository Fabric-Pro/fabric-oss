import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	intent: vi.fn(),
	read: vi.fn(),
	download: vi.fn(),
	source: vi.fn(),
	current: vi.fn(),
	files: vi.fn(),
}));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	loadGitIntent: m.intent,
	listInstructionFiles: m.files,
}));
vi.mock("@repo/connectors", () => ({ readRepositoryFileAtCommit: m.read }));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ downloadFile: m.download }),
}));
vi.mock("../repository/direct-source", () => ({
	loadDirectRepositorySource: m.source,
	assertDirectRepositoryPin: vi.fn(),
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
