import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rate: vi.fn(),
	clear: vi.fn(),
	list: vi.fn(),
	error: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { ai: { feedback: mocks } },
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		ai: {
			feedback: {
				list: {
					queryOptions: ({
						input,
					}: {
						input: { subjectIds: string[] };
					}) => ({
						queryKey: ["feedback", input],
						queryFn: () => mocks.list(input),
					}),
				},
			},
		},
	},
}));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));

import { useCopilotReplyRating } from "../useCopilotReplyRating";

const reply = {
	id: "example-reply",
	role: "assistant",
	content: "A useful reply",
};
function setup(ids = [reply.id]) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const hook = renderHook(
		() =>
			useCopilotReplyRating({
				featureKey: "document-generation",
				projectId: "example-project",
				enabled: true,
			}),
		{
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={client}>
					{children}
				</QueryClientProvider>
			),
		},
	);
	act(() => hook.result.current.setMessageIds(ids));
	return { ...hook, client };
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.rate.mockResolvedValue({ outcome: "RATED_UP" });
	mocks.clear.mockResolvedValue({ cleared: true });
	mocks.list.mockResolvedValue({ outcomes: {} });
});
describe("Copilot reply ratings", () => {
	it("records, switches and clears a vote without model or prompt guesses", async () => {
		const { result } = setup();
		await waitFor(() =>
			expect(result.current.canRate(reply.id)).toBe(true),
		);
		await act(() => result.current.onThumbsUp(reply));
		expect(result.current.getVote(reply.id)).toBe("RATED_UP");
		expect(mocks.rate).toHaveBeenLastCalledWith({
			featureKey: "document-generation",
			subjectType: "copilot-message",
			subjectId: reply.id,
			projectId: "example-project",
			outcome: "RATED_UP",
		});
		await act(() => result.current.onThumbsDown(reply));
		expect(result.current.getVote(reply.id)).toBe("RATED_DOWN");
		expect(mocks.rate).toHaveBeenLastCalledWith(
			expect.objectContaining({ outcome: "RATED_DOWN" }),
		);
		await act(() => result.current.onThumbsDown(reply));
		expect(result.current.getVote(reply.id)).toBeUndefined();
		expect(mocks.clear).toHaveBeenCalledWith({
			featureKey: "document-generation",
			subjectType: "copilot-message",
			subjectId: reply.id,
			projectId: "example-project",
		});
	});
	it("updates optimistically, ignores duplicate in-flight clicks and reverts on error", async () => {
		mocks.list.mockResolvedValue({
			outcomes: { [reply.id]: "RATED_DOWN" },
		});
		const { result } = setup();
		await waitFor(() =>
			expect(result.current.getVote(reply.id)).toBe("RATED_DOWN"),
		);
		let rejectRequest!: (error: Error) => void;
		mocks.rate.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectRequest = reject;
				}),
		);
		let request!: Promise<void>;
		act(() => {
			request = result.current.onThumbsUp(reply);
		});
		expect(result.current.getVote(reply.id)).toBe("RATED_UP");
		await act(() => result.current.onThumbsDown(reply));
		expect(mocks.rate).toHaveBeenCalledTimes(1);
		expect(mocks.clear).not.toHaveBeenCalled();
		await act(async () => {
			rejectRequest(new Error("example failure"));
			await request;
		});
		expect(result.current.getVote(reply.id)).toBe("RATED_DOWN");
		expect(mocks.error).toHaveBeenCalledWith("replyRatingError");
	});
	it("restores a vote when clearing fails", async () => {
		mocks.list.mockResolvedValue({ outcomes: { [reply.id]: "RATED_UP" } });
		const { result } = setup();
		await waitFor(() =>
			expect(result.current.getVote(reply.id)).toBe("RATED_UP"),
		);
		mocks.clear.mockRejectedValueOnce(new Error("example failure"));
		await act(() => result.current.onThumbsUp(reply));
		expect(result.current.getVote(reply.id)).toBe("RATED_UP");
		expect(mocks.error).toHaveBeenCalledWith("replyRatingError");
	});
	it("loads votes in batches of at most 200 distinct ids", async () => {
		const ids = Array.from({ length: 401 }, (_, i) => `example-reply-${i}`);
		setup([...ids, ids[0]]);
		await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
		expect(mocks.list).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "example-project" }),
		);
		expect(
			mocks.list.mock.calls.map(([input]) => input.subjectIds.length),
		).toEqual([200, 200, 1]);
		expect(
			mocks.list.mock.calls.flatMap(([input]) => input.subjectIds),
		).toEqual(ids);
	});
	it("ignores tool-only and unregistered messages", async () => {
		const { result } = setup();
		await waitFor(() =>
			expect(result.current.canRate(reply.id)).toBe(true),
		);
		await act(() => result.current.onThumbsUp({ ...reply, content: "  " }));
		await act(() =>
			result.current.onThumbsUp({ ...reply, id: "example-greeting" }),
		);
		expect(mocks.rate).not.toHaveBeenCalled();
	});
	it("waits for existing votes before accepting a click", async () => {
		let resolveList!: (value: { outcomes: Record<string, string> }) => void;
		mocks.list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveList = resolve;
				}),
		);
		const { result } = setup();
		await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
		expect(result.current.canRate(reply.id)).toBe(false);
		await act(() => result.current.onThumbsUp(reply));
		expect(mocks.rate).not.toHaveBeenCalled();
		await act(async () => {
			resolveList({ outcomes: { [reply.id]: "RATED_UP" } });
		});
		await waitFor(() =>
			expect(result.current.canRate(reply.id)).toBe(true),
		);
		await act(() => result.current.onThumbsUp(reply));
		expect(mocks.clear).toHaveBeenCalledOnce();
	});
	it("allows another message to be rated during a pending request", async () => {
		const second = { ...reply, id: "example-second-reply" };
		const { result } = setup([reply.id, second.id]);
		await waitFor(() =>
			expect(result.current.canRate(reply.id)).toBe(true),
		);
		let resolveFirst!: (value: unknown) => void;
		mocks.rate.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveFirst = resolve;
				}),
		);
		let request!: Promise<void>;
		act(() => {
			request = result.current.onThumbsUp(reply);
		});
		expect(result.current.isPending(reply.id)).toBe(true);
		await act(() => result.current.onThumbsDown(second));
		expect(result.current.getVote(second.id)).toBe("RATED_DOWN");
		expect(mocks.rate).toHaveBeenCalledTimes(2);
		await act(async () => {
			resolveFirst({ outcome: "RATED_UP" });
			await request;
		});
		expect(result.current.isPending(reply.id)).toBe(false);
	});
	it("keeps loaded messages ratable with their votes when a new id is fetching or fails", async () => {
		mocks.list.mockResolvedValueOnce({
			outcomes: { [reply.id]: "RATED_DOWN" },
		});
		const { result } = setup();
		await waitFor(() =>
			expect(result.current.getVote(reply.id)).toBe("RATED_DOWN"),
		);
		let rejectList!: (error: Error) => void;
		mocks.list.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectList = reject;
				}),
		);
		act(() =>
			result.current.setMessageIds([reply.id, "example-new-reply"]),
		);
		await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
		expect(result.current.canRate(reply.id)).toBe(true);
		expect(result.current.getVote(reply.id)).toBe("RATED_DOWN");
		expect(result.current.canRate("example-new-reply")).toBe(false);
		expect(mocks.list.mock.calls[1][0].subjectIds).toEqual([
			"example-new-reply",
		]);
		await act(async () => {
			rejectList(new Error("example failure"));
		});
		await waitFor(() =>
			expect(result.current.canRate(reply.id)).toBe(true),
		);
		expect(result.current.getVote(reply.id)).toBe("RATED_DOWN");
	});
	it("keeps a loaded vote ratable after its own background refetch fails", async () => {
		mocks.list.mockResolvedValueOnce({
			outcomes: { [reply.id]: "RATED_UP" },
		});
		const { result, client } = setup();
		await waitFor(() =>
			expect(result.current.getVote(reply.id)).toBe("RATED_UP"),
		);
		mocks.list.mockRejectedValueOnce(new Error("example failure"));
		await act(() =>
			client.invalidateQueries({ queryKey: ["copilot-reply-ratings"] }),
		);
		expect(mocks.list).toHaveBeenCalledTimes(2);
		expect(client.getQueryCache().getAll()[0].state.status).toBe("error");
		expect(result.current.canRate(reply.id)).toBe(true);
		expect(result.current.getVote(reply.id)).toBe("RATED_UP");
	});
	it("keeps loaded rating queries fresh until explicitly invalidated", async () => {
		const { result, client } = setup();
		await waitFor(() =>
			expect(result.current.canRate(reply.id)).toBe(true),
		);
		expect(client.getQueryCache().getAll()[0].isStale()).toBe(false);
	});
});
