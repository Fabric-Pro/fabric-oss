/**
 * "Restore published version" on the caller's proposal branch: an ordinary
 * native proposal built from the bytes the published pin holds, read
 * server-side. A file the published version lacks becomes a delete, which
 * `submitGitIntentChange` admits only branch-relative. The repository read
 * and the submission are mocks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	readDirectRepositoryFileAtCommit: vi.fn(),
	assertDirectRepositoryPin: vi.fn(),
	submitGitIntentChange: vi.fn(),
}));

vi.mock("../repository/direct-source", () => ({
	loadDirectRepositorySource: async () => ({
		integrationId: "int_example",
		rootPath: "instructions",
		ref: "main",
		refreshFault: null,
	}),
	assertDirectRepositoryPin: (...a: unknown[]) =>
		m.assertDirectRepositoryPin(...a),
	directRepositoryPath: (source: { rootPath: string }, path: string) =>
		`${source.rootPath}/${path}`,
	directRepositoryReadError: () => new Error("repository unreachable"),
	readDirectRepositoryFileAtCommit: (...a: unknown[]) =>
		m.readDirectRepositoryFileAtCommit(...a),
}));
vi.mock("../submit-git-intent", () => ({
	submitGitIntentChange: (...a: unknown[]) => m.submitGitIntentChange(...a),
}));

import { restoreMyBranchFile } from "../restore-branch-file";

const NATIVE_BASE = { generation: 3, commitSha: "a".repeat(40) };

function restore(path = "rules/a.md") {
	return restoreMyBranchFile({
		projectId: "proj_example",
		organizationId: "org_example",
		userId: "user_example_member",
		nativeBase: NATIVE_BASE,
		path,
		audit: {
			user: { id: "user_example_member", email: "dev@example.com" },
		},
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	m.submitGitIntentChange.mockResolvedValue({
		mode: "proposal",
		snapshotId: "snap_restore",
		version: 4,
		nativeBase: NATIVE_BASE,
		putCount: 1,
		deleteCount: 0,
		status: "READY",
		proposalStatus: "PENDING",
	});
});

describe("restoreMyBranchFile", () => {
	it("proposes the published bytes back, read at the published pin", async () => {
		m.readDirectRepositoryFileAtCommit.mockResolvedValue({
			ok: true,
			state: "found",
			bytes: new TextEncoder().encode("alpha\n"),
		});
		const result = await restore();
		expect(m.assertDirectRepositoryPin).toHaveBeenCalledWith(
			expect.anything(),
			NATIVE_BASE,
		);
		expect(m.readDirectRepositoryFileAtCommit).toHaveBeenCalledWith(
			expect.anything(),
			NATIVE_BASE,
			"instructions/rules/a.md",
			expect.any(Number),
		);
		const [submitted] = m.submitGitIntentChange.mock.calls[0] ?? [];
		expect(submitted).toMatchObject({
			mode: "proposal",
			userId: "user_example_member",
			nativeBase: NATIVE_BASE,
			note: { title: "Restore rules/a.md to the published version" },
		});
		expect(submitted.changes).toHaveLength(1);
		expect(submitted.changes[0]).toMatchObject({
			op: "put",
			path: "rules/a.md",
		});
		expect(submitted.changes[0].content.toString("utf8")).toBe("alpha\n");
		expect(result).toEqual({
			kind: "native",
			operationId: "snap_restore",
			nativeBase: NATIVE_BASE,
			operation: "put",
			status: "READY",
		});
	});

	it("deletes a file the published version does not have", async () => {
		m.readDirectRepositoryFileAtCommit.mockResolvedValue({
			ok: true,
			state: "absent",
		});
		const result = await restore("rules/branch-only.md");
		expect(m.submitGitIntentChange.mock.calls[0]?.[0].changes).toEqual([
			{ op: "delete", path: "rules/branch-only.md" },
		]);
		expect(result.operation).toBe("delete");
	});

	it("refuses a published file too large to restore, proposing nothing", async () => {
		m.readDirectRepositoryFileAtCommit.mockResolvedValue({
			ok: true,
			state: "tooLarge",
		});
		await expect(restore()).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { reason: "FILE_RESTORE_UNSUPPORTED" },
		});
		expect(m.submitGitIntentChange).not.toHaveBeenCalled();
	});

	it("surfaces a repository read failure, proposing nothing", async () => {
		m.readDirectRepositoryFileAtCommit.mockResolvedValue({
			ok: false,
			outcome: "unreachable",
		});
		await expect(restore()).rejects.toThrow("repository unreachable");
		expect(m.submitGitIntentChange).not.toHaveBeenCalled();
	});
});
