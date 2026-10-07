import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	load: vi.fn(),
	head: vi.fn(),
	pin: vi.fn(),
	fence: vi.fn(),
	list: vi.fn(),
	file: vi.fn(),
}));
vi.mock("../direct-source", () => ({
	loadDirectRepositorySource: m.load,
	resolveDirectRepositoryHead: m.head,
	assertDirectRepositoryPin: m.pin,
	assertDirectRepositorySourceCurrent: m.fence,
}));
vi.mock("../direct-read", () => ({
	listDirectRepositoryFiles: m.list,
	readDirectRepositoryFile: m.file,
}));

import {
	getDirectRepositoryFileForApi,
	listDirectRepositoryFilesForApi,
} from "../direct-query";

const input = {
	projectId: "project-1",
	userId: "reader-1",
	generation: 7,
	commitSha: "a".repeat(40),
};
const source = { generation: 7 };
beforeEach(() => {
	vi.resetAllMocks();
	m.load.mockResolvedValue(source);
	m.head.mockResolvedValue({ generation: 7, commitSha: input.commitSha });
	m.pin.mockResolvedValue(undefined);
	m.fence.mockResolvedValue(undefined);
	m.list.mockResolvedValue({ files: [], incomplete: false, refusal: null });
	m.file.mockResolvedValue({ state: "absent" });
});

describe("direct repository query failure fences", () => {
	for (const operation of ["list", "file"] as const) {
		for (const failedStep of ["pin", "provider"] as const) {
			it(`${operation} fences ${failedStep} rejection after access is revoked`, async () => {
				const failure = new ORPCError("BAD_REQUEST", {
					message: "Old repository outcome",
					data: { code: "BRANCH_NOT_FOUND" },
				});
				(failedStep === "pin"
					? m.pin
					: operation === "list"
						? m.list
						: m.file
				).mockRejectedValue(failure);
				m.fence.mockRejectedValue(
					new ORPCError("NOT_FOUND", {
						message: "Project not found",
					}),
				);
				const read =
					operation === "list"
						? listDirectRepositoryFilesForApi(input)
						: getDirectRepositoryFileForApi({
								...input,
								path: "AGENTS.md",
							});
				await expect(read).rejects.toMatchObject({ code: "NOT_FOUND" });
				expect(m.fence).toHaveBeenCalledOnce();
				expect(m.fence).toHaveBeenCalledWith({
					...input,
					...(operation === "file" ? { path: "AGENTS.md" } : {}),
					source,
				});
			});
		}
	}
	it("preserves the provider refusal when current authority and configuration still match", async () => {
		const failure = new ORPCError("BAD_REQUEST", {
			message: "Commit unavailable",
		});
		m.list.mockRejectedValue(failure);
		await expect(listDirectRepositoryFilesForApi(input)).rejects.toBe(
			failure,
		);
		expect(m.fence).toHaveBeenCalledOnce();
	});
	it("fences a configuration change while resolving the initial branch head", async () => {
		m.head.mockRejectedValue(new Error("Provider unavailable"));
		m.fence.mockRejectedValue(
			new ORPCError("CONFLICT", { message: "Configuration changed" }),
		);
		await expect(
			listDirectRepositoryFilesForApi({
				projectId: input.projectId,
				userId: input.userId,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.list).not.toHaveBeenCalled();
	});
	it("uses the caller's immutable pin without resolving another head", async () => {
		await expect(
			listDirectRepositoryFilesForApi(input),
		).resolves.toMatchObject({
			generation: 7,
			commitSha: input.commitSha,
			files: [],
		});
		expect(m.head).not.toHaveBeenCalled();
		expect(m.pin).toHaveBeenCalledWith(source, {
			generation: 7,
			commitSha: input.commitSha,
		});
	});
});
