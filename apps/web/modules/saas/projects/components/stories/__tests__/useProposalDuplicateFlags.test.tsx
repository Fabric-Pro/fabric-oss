/**
 * useProposalDuplicateFlags — a large inbox is checked over several calls:
 * the hook shows the flags found so far, asks again, less often each time,
 * while the server reports items still to check and gets through them, and
 * stops asking once none are left or the server stops getting through. Once
 * every item is compared, it asks at a steady pace, a bounded number of
 * times, while the background verifier still decides candidates, and says
 * which of the open proposal's items are still being checked.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DUPLICATE_FLAGS_MAX_RECHECK_MS,
	DUPLICATE_FLAGS_RECHECK_MS,
	DUPLICATE_VERIFY_RECHECK_MS,
	duplicateCheckRefetchInterval,
	duplicateFlagsRefetchInterval,
	MAX_DUPLICATE_VERIFY_RECHECKS,
	useProposalDuplicateFlags,
} from "../useProposalDuplicateFlags";

const mockDuplicateFlags = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			backlog: {
				proposals: {
					duplicateFlags: (...args: unknown[]) =>
						mockDuplicateFlags(...args),
				},
			},
		},
	},
}));

const flag = (changeIndex: number) => ({
	proposalId: "prop-1",
	changeIndex,
	matches: [
		{
			kind: "story" as const,
			storyId: `story-${changeIndex}`,
			identifier: `F-${changeIndex}`,
			title: `Ticket ${changeIndex}`,
			similarity: 0.9,
		},
	],
});

/** One answer of the server's check. */
const answer = (
	flags: ReturnType<typeof flag>[],
	stillChecking: number,
	checking: { proposalId: string; changeIndex: number }[] = [],
	verifying = 0,
) => ({ flags, stillChecking, verifying, checking });

function renderFlags() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			{children}
		</QueryClientProvider>
	);
	return renderHook(
		() =>
			useProposalDuplicateFlags({
				projectId: "project-1",
				organizationId: null,
				proposalId: "prop-1",
				enabled: true,
			}),
		{ wrapper },
	);
}

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	mockDuplicateFlags.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("duplicateFlagsRefetchInterval", () => {
	it("asks again only while items are still being checked", () => {
		expect(duplicateFlagsRefetchInterval([12])).toBe(
			DUPLICATE_FLAGS_RECHECK_MS,
		);
		expect(duplicateFlagsRefetchInterval([12, 0])).toBe(false);
		expect(duplicateFlagsRefetchInterval([])).toBe(false);
	});

	it("waits twice as long after each answer, up to the longest wait", () => {
		expect(duplicateFlagsRefetchInterval([400, 300])).toBe(10_000);
		expect(duplicateFlagsRefetchInterval([400, 300, 200])).toBe(20_000);
		expect(
			duplicateFlagsRefetchInterval([900, 800, 700, 600, 500, 400, 300]),
		).toBe(DUPLICATE_FLAGS_MAX_RECHECK_MS);
	});

	it("stops once two answers in a row checked nothing more", () => {
		expect(duplicateFlagsRefetchInterval([40, 40])).toBe(10_000);
		expect(duplicateFlagsRefetchInterval([40, 40, 40])).toBe(false);
		expect(duplicateFlagsRefetchInterval([50, 40, 40, 45])).toBe(false);
		expect(duplicateFlagsRefetchInterval([50, 40, 40, 30])).toBe(40_000);
	});
});

describe("duplicateCheckRefetchInterval", () => {
	const verifying = (count: number) =>
		Array.from({ length: count }, () => ({
			stillChecking: 0,
			verifying: 2,
		}));

	it("keeps the embedding wait while items are still to be compared", () => {
		expect(
			duplicateCheckRefetchInterval([
				{ stillChecking: 400, verifying: 3 },
				{ stillChecking: 300, verifying: 3 },
			]),
		).toBe(10_000);
	});

	it("asks at a steady pace while the verifier still decides candidates", () => {
		expect(duplicateCheckRefetchInterval(verifying(1))).toBe(
			DUPLICATE_VERIFY_RECHECK_MS,
		);
		expect(duplicateCheckRefetchInterval(verifying(6))).toBe(
			DUPLICATE_VERIFY_RECHECK_MS,
		);
	});

	it("stops once nothing is left, or after the most verifier asks", () => {
		expect(
			duplicateCheckRefetchInterval([
				{ stillChecking: 0, verifying: 2 },
				{ stillChecking: 0, verifying: 0 },
			]),
		).toBe(false);
		expect(
			duplicateCheckRefetchInterval(
				verifying(MAX_DUPLICATE_VERIFY_RECHECKS + 1),
			),
		).toBe(false);
	});

	it("stops when the embedding stalled, even with candidates to verify", () => {
		expect(
			duplicateCheckRefetchInterval([
				{ stillChecking: 40, verifying: 2 },
				{ stillChecking: 40, verifying: 2 },
				{ stillChecking: 40, verifying: 2 },
			]),
		).toBe(false);
	});
});

describe("useProposalDuplicateFlags", () => {
	it("reports loading until the first answer arrives", async () => {
		let resolveFirst: (value: ReturnType<typeof answer>) => void = () => {};
		mockDuplicateFlags.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveFirst = resolve;
			}),
		);

		const { result } = renderFlags();

		await vi.waitFor(() => expect(result.current.loading).toBe(true));
		expect(result.current.flags.size).toBe(0);

		await act(async () => {
			resolveFirst(answer([flag(0)], 0));
		});

		await vi.waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.flags.has(0)).toBe(true);
	});

	it("shows the flags found so far and asks again until the whole inbox is checked", async () => {
		mockDuplicateFlags
			.mockResolvedValueOnce(answer([flag(0)], 30))
			.mockResolvedValueOnce(answer([flag(0), flag(2)], 0));

		const { result } = renderFlags();

		await vi.waitFor(() => expect(result.current.flags.has(0)).toBe(true));
		expect(result.current.flags.has(2)).toBe(false);
		expect(mockDuplicateFlags).toHaveBeenCalledTimes(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(DUPLICATE_FLAGS_RECHECK_MS);
		});

		await vi.waitFor(() => expect(result.current.flags.has(2)).toBe(true));
		expect(mockDuplicateFlags).toHaveBeenCalledTimes(2);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(DUPLICATE_FLAGS_RECHECK_MS * 3);
		});

		expect(mockDuplicateFlags).toHaveBeenCalledTimes(2);
	});

	it("backs off between asks and stops when the server gets no further", async () => {
		mockDuplicateFlags
			.mockResolvedValueOnce(answer([flag(0)], 30))
			.mockResolvedValueOnce(answer([flag(0)], 30))
			.mockResolvedValueOnce(answer([flag(0)], 30));

		renderFlags();

		await vi.waitFor(() =>
			expect(mockDuplicateFlags).toHaveBeenCalledTimes(1),
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(DUPLICATE_FLAGS_RECHECK_MS);
		});
		await vi.waitFor(() =>
			expect(mockDuplicateFlags).toHaveBeenCalledTimes(2),
		);
		// The second wait is twice the first.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(DUPLICATE_FLAGS_RECHECK_MS);
		});
		expect(mockDuplicateFlags).toHaveBeenCalledTimes(2);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(DUPLICATE_FLAGS_RECHECK_MS);
		});
		await vi.waitFor(() =>
			expect(mockDuplicateFlags).toHaveBeenCalledTimes(3),
		);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(DUPLICATE_FLAGS_MAX_RECHECK_MS);
		});

		expect(mockDuplicateFlags).toHaveBeenCalledTimes(3);
	});

	it("says which items of the open proposal are still being checked, and shows a flag once it is verified", async () => {
		const waiting = [
			{ proposalId: "prop-1", changeIndex: 1 },
			{ proposalId: "prop-2", changeIndex: 0 },
		];
		mockDuplicateFlags
			.mockResolvedValueOnce(answer([], 0, waiting, 2))
			.mockResolvedValueOnce(answer([flag(1)], 0));

		const { result } = renderFlags();

		await vi.waitFor(() =>
			expect([...result.current.checking]).toEqual([1]),
		);
		expect(result.current.flags.size).toBe(0);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(DUPLICATE_VERIFY_RECHECK_MS);
		});

		await vi.waitFor(() => expect(result.current.flags.has(1)).toBe(true));
		expect(result.current.checking.size).toBe(0);
		expect(mockDuplicateFlags).toHaveBeenCalledTimes(2);
	});

	it("drops the still-checking note once it stops asking, after the most verifier asks", async () => {
		const waiting = [{ proposalId: "prop-1", changeIndex: 1 }];
		mockDuplicateFlags.mockResolvedValue(answer([], 0, waiting, 1));

		const { result } = renderFlags();

		await vi.waitFor(() =>
			expect([...result.current.checking]).toEqual([1]),
		);
		for (let ask = 0; ask <= MAX_DUPLICATE_VERIFY_RECHECKS; ask++) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(DUPLICATE_VERIFY_RECHECK_MS);
			});
		}

		await vi.waitFor(() => expect(result.current.checking.size).toBe(0));
		const asks = mockDuplicateFlags.mock.calls.length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(DUPLICATE_VERIFY_RECHECK_MS * 3);
		});
		expect(mockDuplicateFlags).toHaveBeenCalledTimes(asks);
	});

	it("drops the still-checking note when an ask fails", async () => {
		const waiting = [{ proposalId: "prop-1", changeIndex: 1 }];
		mockDuplicateFlags
			.mockResolvedValueOnce(answer([], 0, waiting, 1))
			.mockRejectedValueOnce(new Error("rate limited"));

		const { result } = renderFlags();

		await vi.waitFor(() =>
			expect([...result.current.checking]).toEqual([1]),
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(DUPLICATE_VERIFY_RECHECK_MS);
		});

		await vi.waitFor(() => expect(result.current.checking.size).toBe(0));
		const asks = mockDuplicateFlags.mock.calls.length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(DUPLICATE_VERIFY_RECHECK_MS * 3);
		});
		expect(mockDuplicateFlags).toHaveBeenCalledTimes(asks);
	});
});
