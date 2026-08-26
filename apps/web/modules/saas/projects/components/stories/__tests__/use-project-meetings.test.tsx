import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMeetingsMock } = vi.hoisted(() => ({
	listMeetingsMock: vi.fn(),
}));

// Force-refresh path calls the raw client directly.
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { backlog: { listMeetings: listMeetingsMock } },
	},
}));

// The normal read goes through TanStack Query via the orpc utils.
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			backlog: {
				listMeetings: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.backlog.listMeetings", input],
						queryFn: () => listMeetingsMock(input),
					}),
				},
			},
		},
	},
}));

import { useProjectMeetings } from "../use-project-meetings";

function makeWrapper() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={client}>
				{children}
			</QueryClientProvider>
		);
	}
	return { client, Wrapper };
}

beforeEach(() => {
	listMeetingsMock.mockReset();
});

describe("useProjectMeetings", () => {
	it("maps results and drops meetings without a joinUrl", async () => {
		listMeetingsMock.mockResolvedValue({
			meetings: [
				{
					id: "1",
					subject: "A",
					startTime: "t1",
					organizer: "Alice",
					joinUrl: "u1",
				},
				{
					id: "2",
					subject: "B",
					startTime: null,
					organizer: "X",
					joinUrl: null,
				},
			],
		});
		const { Wrapper } = makeWrapper();
		const { result } = renderHook(
			() =>
				useProjectMeetings({
					projectId: "p1",
					organizationId: null,
					daysBack: 30,
				}),
			{ wrapper: Wrapper },
		);

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.meetings).toEqual([
			{
				id: "1",
				subject: "A",
				startTime: "t1",
				organizer: "Alice",
				joinUrl: "u1",
			},
		]);
	});

	it("serves repeat consumers from cache — one fetch per key (AC3)", async () => {
		listMeetingsMock.mockResolvedValue({ meetings: [] });
		const { Wrapper } = makeWrapper();
		const input = { projectId: "p1", organizationId: null, daysBack: 30 };

		const a = renderHook(() => useProjectMeetings(input), {
			wrapper: Wrapper,
		});
		const b = renderHook(() => useProjectMeetings(input), {
			wrapper: Wrapper,
		});

		await waitFor(() => {
			expect(a.result.current.isLoading).toBe(false);
			expect(b.result.current.isLoading).toBe(false);
		});
		// Two consumers, identical query key, one shared client → a single fetch.
		expect(listMeetingsMock).toHaveBeenCalledTimes(1);
	});

	it("refresh() forces a fresh fetch (forceRefresh) and updates the data", async () => {
		listMeetingsMock.mockResolvedValueOnce({ meetings: [] });
		const { Wrapper } = makeWrapper();
		const { result } = renderHook(
			() =>
				useProjectMeetings({
					projectId: "p1",
					organizationId: "org-1",
					daysBack: 30,
				}),
			{ wrapper: Wrapper },
		);

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		listMeetingsMock.mockResolvedValueOnce({
			meetings: [
				{
					id: "9",
					subject: "Fresh",
					startTime: "t",
					organizer: "Alice",
					joinUrl: "u9",
				},
			],
		});
		await result.current.refresh();

		await waitFor(() =>
			expect(result.current.meetings).toEqual([
				{
					id: "9",
					subject: "Fresh",
					startTime: "t",
					organizer: "Alice",
					joinUrl: "u9",
				},
			]),
		);
		expect(listMeetingsMock).toHaveBeenLastCalledWith(
			expect.objectContaining({ forceRefresh: true }),
		);
	});

	it("surfaces a fetch failure via isError/error and yields an empty list", async () => {
		listMeetingsMock.mockRejectedValue(new Error("graph boom"));
		const { Wrapper } = makeWrapper();
		const { result } = renderHook(
			() =>
				useProjectMeetings({
					projectId: "p1",
					organizationId: null,
					daysBack: 30,
				}),
			{ wrapper: Wrapper },
		);

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.error).toBeInstanceOf(Error);
		expect(result.current.meetings).toEqual([]);
	});

	it("refresh() failure falls back to invalidateQueries without throwing", async () => {
		listMeetingsMock.mockResolvedValue({ meetings: [] });
		const { client, Wrapper } = makeWrapper();
		const invalidateSpy = vi.spyOn(client, "invalidateQueries");
		const { result } = renderHook(
			() =>
				useProjectMeetings({
					projectId: "p1",
					organizationId: "org-1",
					daysBack: 30,
				}),
			{ wrapper: Wrapper },
		);

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		// Only the forced-refresh call rejects; the fallback refetch resolves.
		listMeetingsMock.mockRejectedValueOnce(
			new Error("forced refresh boom"),
		);
		await expect(result.current.refresh()).resolves.toBeUndefined();

		expect(invalidateSpy).toHaveBeenCalled();
		await waitFor(() => expect(result.current.isFetching).toBe(false));
	});
});
