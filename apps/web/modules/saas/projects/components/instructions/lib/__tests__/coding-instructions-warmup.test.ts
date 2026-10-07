import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ names: [] as string[], chunk: 0 }));

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
								return { availability: "UPLOAD" };
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
});
