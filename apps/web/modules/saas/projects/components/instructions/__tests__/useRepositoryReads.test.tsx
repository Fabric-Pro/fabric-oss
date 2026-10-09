import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRepositoryReads } from "../useRepositoryReads";

const reads = vi.hoisted(() => ({
	getFile: vi.fn(),
	listFiles: vi.fn(),
	listCommits: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				repository: {
					getFile: {
						queryOptions: ({ input }: { input: unknown }) => ({
							queryKey: ["getFile", input],
							queryFn: () => reads.getFile(input),
						}),
					},
					listFiles: {
						queryOptions: ({ input }: { input: unknown }) => ({
							queryKey: ["listFiles", input],
							queryFn: () => reads.listFiles(input),
						}),
					},
					listCommits: {
						queryOptions: ({ input }: { input: unknown }) => ({
							queryKey: ["listCommits", input],
							queryFn: () => reads.listCommits(input),
						}),
					},
				},
			},
		},
	},
}));

const LATENCY_MS = 60;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = "a".repeat(40);

function client() {
	return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function render(
	queryClient: QueryClient,
	pin: { generation: number; commitSha: string },
) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			{children}
		</QueryClientProvider>
	);
	return renderHook(
		(props: { generation: number; commitSha: string }) =>
			useRepositoryReads({
				projectId: "project-1",
				pin: props,
				readable: true,
				historyOpen: false,
			}),
		{ wrapper, initialProps: pin },
	);
}

function repositoryWith(present: readonly string[]) {
	reads.getFile.mockImplementation(async ({ path }: { path: string }) => {
		await sleep(LATENCY_MS);
		return present.includes(path)
			? { state: "found", body: "x", nextOffset: null, size: 1 }
			: { state: "absent" };
	});
	reads.listFiles.mockImplementation(async () => {
		await sleep(LATENCY_MS * 5);
		return {
			files: present.map((path) => ({ path })),
			excludedCount: 0,
			excludedPaths: [],
		};
	});
	reads.listCommits.mockResolvedValue({ commits: [] });
}

const requested = () =>
	reads.getFile.mock.calls.map(([input]) => (input as { path: string }).path);

describe("default instruction file reads", () => {
	beforeEach(() => {
		reads.getFile.mockReset();
		reads.listFiles.mockReset();
		reads.listCommits.mockReset();
	});

	it("reads only CLAUDE.md, and has the default file in one round trip, when the repository has one", async () => {
		repositoryWith(["CLAUDE.md", "AGENTS.md"]);
		const { result } = render(client(), { generation: 1, commitSha: sha });
		await waitFor(() =>
			expect(result.current.defaultPath).toBe("CLAUDE.md"),
		);
		expect(result.current.files.isSuccess).toBe(false);
		expect(requested()).toEqual(["CLAUDE.md"]);
		await sleep(LATENCY_MS * 2);
		expect(requested()).toEqual(["CLAUDE.md"]);
	});

	it("falls back to AGENTS.md only after CLAUDE.md comes back absent", async () => {
		repositoryWith(["AGENTS.md"]);
		const { result } = render(client(), { generation: 1, commitSha: sha });
		await waitFor(() =>
			expect(result.current.defaultPath).toBe("AGENTS.md"),
		);
		expect(requested()).toEqual(["CLAUDE.md", "AGENTS.md"]);
	});

	it("reports no default file when neither exists", async () => {
		repositoryWith(["docs/guide.md"]);
		const { result } = render(client(), { generation: 1, commitSha: sha });
		await waitFor(() => expect(result.current.defaultPath).toBeNull());
		expect(requested()).toEqual(["CLAUDE.md", "AGENTS.md"]);
	});

	it("still tries AGENTS.md when the CLAUDE.md read fails", async () => {
		reads.getFile.mockImplementation(async ({ path }: { path: string }) => {
			if (path === "CLAUDE.md") {
				throw new Error("provider unavailable");
			}
			return { state: "found", body: "x", nextOffset: null, size: 1 };
		});
		reads.listFiles.mockResolvedValue({
			files: [{ path: "AGENTS.md" }],
			excludedCount: 0,
			excludedPaths: [],
		});
		reads.listCommits.mockResolvedValue({ commits: [] });
		const { result } = render(client(), { generation: 1, commitSha: sha });
		await waitFor(() =>
			expect(result.current.defaultPath).toBe("AGENTS.md"),
		);
	});
});

describe("commit list after the pin moves", () => {
	const consoleError = vi
		.spyOn(console, "error")
		.mockImplementation(() => undefined);

	beforeEach(() => {
		consoleError.mockClear();
		reads.getFile.mockReset();
		reads.listFiles.mockReset();
		reads.listCommits.mockReset();
	});
	afterEach(() => consoleError.mockClear());

	it("leaves a stale listing rejected with 409 after the pin moved without a retry or an error, and reads commits for the new pin", async () => {
		repositoryWith(["CLAUDE.md"]);
		const stale = Object.assign(new Error("stale listing"), {
			code: "CONFLICT",
			status: 409,
		});
		reads.listCommits.mockImplementation(
			async ({ generation }: { generation: number }) => {
				if (generation === 1) {
					await sleep(LATENCY_MS * 4);
					throw stale;
				}
				return { commits: [{ sha: "b".repeat(40) }] };
			},
		);
		const queryClient = client();
		const { result, rerender } = render(queryClient, {
			generation: 1,
			commitSha: sha,
		});
		await waitFor(() => expect(reads.listCommits).toHaveBeenCalledTimes(1));

		rerender({ generation: 2, commitSha: "b".repeat(40) });
		await waitFor(() =>
			expect(result.current.commits.data?.commits).toEqual([
				{ sha: "b".repeat(40) },
			]),
		);
		await sleep(LATENCY_MS * 6);

		const generations = reads.listCommits.mock.calls.map(
			([input]) => (input as { generation: number }).generation,
		);
		expect(generations).toEqual([1, 2]);
		expect(result.current.commits.isError).toBe(false);
		expect(consoleError).not.toHaveBeenCalled();
	});
});
