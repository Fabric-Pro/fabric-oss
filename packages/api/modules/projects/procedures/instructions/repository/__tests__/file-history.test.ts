import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	load: vi.fn(),
	head: vi.fn(),
	pin: vi.fn(),
	fence: vi.fn(),
	ignore: vi.fn(),
	version: vi.fn(),
	authorize: vi.fn(),
	writable: vi.fn(),
	submit: vi.fn(),
}));
vi.mock("../direct-source", () => ({
	loadDirectRepositorySource: m.load,
	resolveDirectRepositoryHead: m.head,
	assertDirectRepositoryPin: m.pin,
	assertDirectRepositorySourceCurrent: m.fence,
	resolveDirectRepositoryIgnore: m.ignore,
}));
vi.mock("../direct-read", () => ({
	readDirectRepositoryFileVersion: m.version,
	readDirectRepositoryFile: vi.fn(),
	listDirectRepositoryFiles: vi.fn(),
}));
vi.mock("../../proposal-authorization", () => ({
	assertInstructionDeriveAccess: m.authorize,
}));
vi.mock("../../read-only-guard", () => ({
	assertRepositoryWritable: m.writable,
}));
vi.mock("../../submit-change", () => ({ submitInstructionChange: m.submit }));

import {
	previewInstructionFileRestore,
	restoreInstructionFile,
} from "../file-history";

const nativeBase = { generation: 7, commitSha: "b".repeat(40) };
const targetCommitSha = "a".repeat(40);
const input = {
	projectId: "project-1",
	userId: "editor-1",
	generation: 7,
	path: "AGENTS.md",
	targetCommitSha,
};
const source = {
	generation: 7,
	organizationId: "org-1",
	rootPath: "instructions",
};
const audit = {
	headers: new Headers(),
	user: {
		id: input.userId,
		email: "editor@example.com",
		name: "Example Editor",
	},
};
const found = (text: string) => ({
	state: "found",
	text,
	textLength: Array.from(text).length,
	size: Buffer.byteLength(text),
});

beforeEach(() => {
	vi.resetAllMocks();
	m.load.mockResolvedValue(source);
	m.head.mockResolvedValue(nativeBase);
	m.pin.mockResolvedValue(undefined);
	m.fence.mockResolvedValue(undefined);
	m.ignore.mockResolvedValue({ globs: [], layer: "project" });
	m.version.mockImplementation(async ({ pin }) =>
		found(pin.commitSha === targetCommitSha ? "old\r\n" : "current\n"),
	);
	m.authorize.mockResolvedValue(undefined);
	m.writable.mockResolvedValue(undefined);
	m.submit.mockResolvedValue({
		snapshotId: "operation-1",
		nativeBase,
		putCount: 1,
		deleteCount: 0,
		status: "READY",
	});
});

describe("Git-native per-file restore", () => {
	it("lazily reads two immutable versions and returns the exact current base", async () => {
		const preview = await previewInstructionFileRestore(input);
		expect(preview).toMatchObject({
			nativeBase,
			targetCommitSha,
			path: "AGENTS.md",
			current: found("current\n"),
			selected: found("old\r\n"),
			restore: { available: true, operation: "put" },
			maxTextBytes: 262144,
		});
		expect(m.pin).toHaveBeenCalledWith(source, {
			generation: 7,
			commitSha: targetCommitSha,
		});
		expect(m.head).toHaveBeenCalledTimes(2);
		expect(m.submit).not.toHaveBeenCalled();
	});

	it("submits only the selected path with server-read bytes and audit provenance", async () => {
		await expect(
			restoreInstructionFile({
				...input,
				currentCommitSha: nativeBase.commitSha,
				audit,
			}),
		).resolves.toMatchObject({
			kind: "native",
			operationId: "operation-1",
			nativeBase,
		});
		expect(m.submit).toHaveBeenCalledExactlyOnceWith({
			projectId: input.projectId,
			userId: input.userId,
			nativeBase,
			changes: [
				{
					op: "put",
					path: "AGENTS.md",
					content: "old\r\n",
					encoding: "utf8",
				},
			],
			mode: "commit",
			message: `Restore AGENTS.md from ${targetCommitSha}`,
			audit,
			via: "orpc-file-restore",
		});
		expect(m.authorize).toHaveBeenCalledWith({
			projectId: input.projectId,
			userId: input.userId,
			proposal: false,
		});
	});

	it("restores an empty file as put and a proven historical absence as delete", async () => {
		for (const selected of [found(""), { state: "absent" }]) {
			m.submit.mockClear();
			m.version.mockImplementation(async ({ pin }) =>
				pin.commitSha === targetCommitSha ? selected : found("current"),
			);
			await restoreInstructionFile({
				...input,
				currentCommitSha: nativeBase.commitSha,
				audit,
			});
			expect(m.submit).toHaveBeenCalledWith(
				expect.objectContaining({
					changes: [
						selected.state === "absent"
							? { op: "delete", path: "AGENTS.md" }
							: {
									op: "put",
									path: "AGENTS.md",
									content: "",
									encoding: "utf8",
								},
					],
				}),
			);
		}
	});

	it("restores a historically present file that is currently absent", async () => {
		m.version.mockImplementation(async ({ pin }) =>
			pin.commitSha === targetCommitSha
				? found("restored")
				: { state: "absent" },
		);
		await restoreInstructionFile({
			...input,
			currentCommitSha: nativeBase.commitSha,
			audit,
		});
		expect(m.submit).toHaveBeenCalledWith(
			expect.objectContaining({
				changes: [
					{
						op: "put",
						path: "AGENTS.md",
						content: "restored",
						encoding: "utf8",
					},
				],
			}),
		);
	});

	it.each(["same", "absent"])(
		"returns an explicit no-op for %s versions",
		async (state) => {
			m.version.mockResolvedValue(
				state === "same" ? found("same") : { state: "absent" },
			);
			await expect(
				restoreInstructionFile({
					...input,
					currentCommitSha: nativeBase.commitSha,
					audit,
				}),
			).resolves.toEqual({ kind: "unchanged", nativeBase });
			expect(m.submit).not.toHaveBeenCalled();
		},
	);

	it.each(["binary", "tooLarge", "nonRegular", "unavailable"])(
		"refuses partial or unsupported %s versions",
		async (state) => {
			m.version.mockImplementation(async ({ pin }) =>
				pin.commitSha === targetCommitSha
					? { state, size: 100 }
					: found("current"),
			);
			await expect(
				restoreInstructionFile({
					...input,
					currentCommitSha: nativeBase.commitSha,
					audit,
				}),
			).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
				data: { code: "FILE_RESTORE_UNSUPPORTED" },
			});
			expect(m.submit).not.toHaveBeenCalled();
		},
	);

	it("reports the canonical ignore-file restriction in its preview", async () => {
		await expect(
			previewInstructionFileRestore({ ...input, path: ".fabricignore" }),
		).resolves.toMatchObject({
			restore: { available: false, reason: "ignoreFile" },
		});
	});

	it.each(["../outside.md", ".env", "dir\\file.md", "/file.md"])(
		"refuses unsafe path %s before reading a file",
		async (path) => {
			await expect(
				previewInstructionFileRestore({ ...input, path }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(m.version).not.toHaveBeenCalled();
		},
	);

	it("applies current ignore rules before retrieving historical bytes", async () => {
		m.ignore.mockResolvedValue({ globs: ["AGENTS.md"], layer: "project" });
		await expect(
			previewInstructionFileRestore(input),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.version).not.toHaveBeenCalled();
	});

	it("refuses an already stale preview without reading selected bytes", async () => {
		await expect(
			restoreInstructionFile({
				...input,
				currentCommitSha: "c".repeat(40),
				audit,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "FILE_RESTORE_PREVIEW_STALE" },
		});
		expect(m.version).not.toHaveBeenCalled();
		expect(m.submit).not.toHaveBeenCalled();
	});

	it("refuses a branch move during preview I/O", async () => {
		m.head.mockResolvedValueOnce(nativeBase).mockResolvedValueOnce({
			...nativeBase,
			commitSha: "c".repeat(40),
		});
		await expect(
			restoreInstructionFile({
				...input,
				currentCommitSha: nativeBase.commitSha,
				audit,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "FILE_RESTORE_PREVIEW_STALE" },
		});
		expect(m.submit).not.toHaveBeenCalled();
	});

	it("refuses a source generation change before provider content I/O", async () => {
		await expect(
			previewInstructionFileRestore({ ...input, generation: 6 }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "REPOSITORY_CONFIGURATION_CHANGED" },
		});
		expect(m.version).not.toHaveBeenCalled();
	});

	it("refuses an unreachable or off-branch target rather than suggesting deletion", async () => {
		m.pin.mockRejectedValue(
			new ORPCError("NOT_FOUND", {
				message: "Commit not on configured branch",
			}),
		);
		await expect(
			previewInstructionFileRestore(input),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.version).not.toHaveBeenCalled();
	});

	it.each(["FORBIDDEN", "CONFLICT"] as const)(
		"withholds provider content after the current authority fence returns %s",
		async (code) => {
			m.fence.mockRejectedValue(
				new ORPCError(code, {
					message: "Current access or configuration changed",
				}),
			);
			await expect(
				restoreInstructionFile({
					...input,
					currentCommitSha: nativeBase.commitSha,
					audit,
				}),
			).rejects.toMatchObject({ code });
			expect(m.submit).not.toHaveBeenCalled();
		},
	);

	it("does no provider reads for a reader without write permission or a read-only project", async () => {
		m.authorize.mockRejectedValueOnce(new ORPCError("FORBIDDEN"));
		await expect(
			restoreInstructionFile({
				...input,
				currentCommitSha: nativeBase.commitSha,
				audit,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.load).not.toHaveBeenCalled();
		m.writable.mockRejectedValueOnce(
			new ORPCError("CONFLICT", {
				data: { errorCode: "PROJECT_READ_ONLY" },
			}),
		);
		await expect(
			restoreInstructionFile({
				...input,
				currentCommitSha: nativeBase.commitSha,
				audit,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.load).not.toHaveBeenCalled();
	});

	it("refuses a project switched to read-only during preview I/O", async () => {
		m.writable.mockResolvedValueOnce(undefined).mockRejectedValueOnce(
			new ORPCError("CONFLICT", {
				data: { errorCode: "PROJECT_READ_ONLY" },
			}),
		);
		await expect(
			restoreInstructionFile({
				...input,
				currentCommitSha: nativeBase.commitSha,
				audit,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.submit).not.toHaveBeenCalled();
	});
});
