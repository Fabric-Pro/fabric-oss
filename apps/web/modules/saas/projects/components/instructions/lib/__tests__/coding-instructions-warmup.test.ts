import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
	names: [] as string[],
	chunk: 0,
	state: { availability: "UPLOAD" } as Record<string, unknown>,
	gate: null as Promise<void> | null,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				repository: {
					getState: {
						queryOptions: ({ input }: { input: unknown }) => ({
							queryKey: ["getState", input],
							queryFn: async () => {
								calls.names.push("getState");
								if (calls.gate) {
									await calls.gate;
								}
								return calls.state;
							},
						}),
					},
					listFiles: {
						queryOptions: ({ input }: { input: unknown }) => ({
							queryKey: ["listFiles", input],
							queryFn: async () => {
								calls.names.push("listFiles");
								return { files: [] };
							},
						}),
					},
					getFile: {
						queryOptions: ({
							input,
						}: {
							input: { path: string };
						}) => ({
							queryKey: ["getFile", input],
							queryFn: async () => {
								calls.names.push(`getFile:${input.path}`);
								return null;
							},
						}),
					},
				},
			},
		},
	},
}));
vi.mock("../../CodingInstructionsTab", () => {
	calls.chunk += 1;
	return { CodingInstructionsTab: () => null };
});

import {
	prefetchDefaultInstructionFiles,
	warmCodingInstructions,
} from "../coding-instructions-warmup";

describe("coding instructions warm-up", () => {
	it("starts the repository state and the tab chunk before anything renders, under the tab's own cache key", async () => {
		const client = new QueryClient();
		warmCodingInstructions(client, "p");
		await vi.waitFor(() => expect(calls.names).toEqual(["getState"]));
		await vi.waitFor(() =>
			expect(
				client.getQueryData(["getState", { projectId: "p" }]),
			).toEqual({ availability: "UPLOAD" }),
		);
		await vi.waitFor(() => expect(calls.chunk).toBe(1));
	});

	it("reads both default files for the pin without waiting for the file list", async () => {
		calls.names.length = 0;
		const client = new QueryClient();
		prefetchDefaultInstructionFiles(client, "p", {
			generation: 1,
			commitSha: "a".repeat(40),
		});
		await vi.waitFor(() =>
			expect([...calls.names].sort()).toEqual([
				"getFile:AGENTS.md",
				"getFile:CLAUDE.md",
			]),
		);
	});

	it("once the state names a commit, also reads the file list and the default files, without the project", async () => {
		calls.names.length = 0;
		calls.state = {
			availability: "READY",
			generation: 3,
			currentCommitSha: "a".repeat(40),
		};
		try {
			warmCodingInstructions(new QueryClient(), "p");
			await vi.waitFor(() =>
				expect([...calls.names].sort()).toEqual([
					"getFile:AGENTS.md",
					"getFile:CLAUDE.md",
					"getState",
					"listFiles",
				]),
			);
		} finally {
			calls.state = { availability: "UPLOAD" };
		}
	});

	describe("with a pin remembered from an earlier visit", () => {
		const remembered = { generation: 3, commitSha: "a".repeat(40) };

		beforeEach(() => {
			calls.names.length = 0;
			window.localStorage.clear();
			window.localStorage.setItem(
				"fabric:coding-instructions:pin:p",
				JSON.stringify(remembered),
			);
		});

		afterEach(() => {
			calls.gate = null;
			calls.state = { availability: "UPLOAD" };
			window.localStorage.clear();
		});

		it("starts the file list and default files while getState is still in flight", async () => {
			let release: () => void = () => undefined;
			calls.gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			warmCodingInstructions(new QueryClient(), "p");

			await vi.waitFor(() =>
				expect([...calls.names].sort()).toEqual([
					"getFile:AGENTS.md",
					"getFile:CLAUDE.md",
					"getState",
					"listFiles",
				]),
			);
			release();
		});

		it("reads the new commit when the branch has moved, and remembers it", async () => {
			const moved = "b".repeat(40);
			calls.state = {
				availability: "READY",
				generation: 3,
				currentCommitSha: moved,
			};
			const client = new QueryClient();
			warmCodingInstructions(client, "p");

			await vi.waitFor(() =>
				expect(
					client.getQueryData([
						"listFiles",
						{ projectId: "p", generation: 3, commitSha: moved },
					]),
				).toBeDefined(),
			);
			expect(
				window.localStorage.getItem("fabric:coding-instructions:pin:p"),
			).toBe(JSON.stringify({ generation: 3, commitSha: moved }));
		});

		it("does not read a second time when the branch has not moved", async () => {
			calls.state = {
				availability: "READY",
				generation: 3,
				currentCommitSha: remembered.commitSha,
			};
			const client = new QueryClient();
			warmCodingInstructions(client, "p");

			await vi.waitFor(() =>
				expect(
					client.getQueryData([
						"listFiles",
						{ projectId: "p", ...remembered },
					]),
				).toBeDefined(),
			);
			expect(calls.names.filter((n) => n === "listFiles")).toHaveLength(
				1,
			);
		});

		it("ignores a remembered value that is not a pin", async () => {
			window.localStorage.setItem(
				"fabric:coding-instructions:pin:p",
				JSON.stringify({ generation: 3, commitSha: "not-a-sha" }),
			);
			warmCodingInstructions(new QueryClient(), "p");

			await vi.waitFor(() => expect(calls.names).toEqual(["getState"]));
		});
	});
});
