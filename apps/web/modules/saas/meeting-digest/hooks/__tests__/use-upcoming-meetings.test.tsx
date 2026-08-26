import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listUpcoming } = vi.hoisted(() => ({
	listUpcoming: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { meetingDigest: { listUpcoming } },
	},
}));

import { useUpcomingMeetings } from "../use-upcoming-meetings";

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

const MEETING = {
	joinUrl: "https://teams/x",
	subject: "Fabric DSU",
	startTime: "2026-07-25T09:00:00.000Z",
	organizer: "Avery Diaz",
	linkedMeetingId: "lm_1",
	agendaStatus: null,
};

describe("useUpcomingMeetings", () => {
	beforeEach(() => vi.clearAllMocks());

	it("does not call the API when disabled", () => {
		renderHook(
			() =>
				useUpcomingMeetings({
					projectId: "p1",
					organizationId: null,
					enabled: false,
				}),
			{ wrapper },
		);

		expect(listUpcoming).not.toHaveBeenCalled();
	});

	it("requests only the near window on mount (#2106)", async () => {
		listUpcoming.mockResolvedValue({ meetings: [MEETING] });

		const { result } = renderHook(
			() =>
				useUpcomingMeetings({
					projectId: "p1",
					organizationId: "org1",
					enabled: true,
				}),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.meetings).toHaveLength(1));

		expect(listUpcoming).toHaveBeenCalledTimes(1);
		const args = listUpcoming.mock.calls[0][0];
		expect(args.projectId).toBe("p1");
		expect(args.organizationId).toBe("org1");
		expect(args.startOffsetDays).toBe(0);
		expect(args.daysForward).toBe(2);
	});

	it("derives notConnected from data.error, not from an empty meetings array", async () => {
		listUpcoming.mockResolvedValue({
			meetings: [],
			error: "not-connected",
		});

		const { result } = renderHook(
			() =>
				useUpcomingMeetings({
					projectId: "p1",
					organizationId: null,
					enabled: true,
				}),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.notConnected).toBe(true));
		expect(result.current.isError).toBe(false);
		expect(result.current.meetings).toEqual([]);
	});

	it("does not report notConnected for an empty calendar with no error", async () => {
		listUpcoming.mockResolvedValue({ meetings: [] });

		const { result } = renderHook(
			() =>
				useUpcomingMeetings({
					projectId: "p1",
					organizationId: null,
					enabled: true,
				}),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.notConnected).toBe(false);
		expect(result.current.meetings).toEqual([]);
	});

	it("fetches the later window only once asked, and merges both chunks", async () => {
		const later = {
			...MEETING,
			joinUrl: "https://teams/y",
			subject: "Sprint Review",
			startTime: "2026-08-01T13:00:00.000Z",
		};
		listUpcoming.mockImplementation((input: { startOffsetDays: number }) =>
			Promise.resolve({
				meetings: input.startOffsetDays === 0 ? [MEETING] : [later],
			}),
		);

		const { result } = renderHook(
			() =>
				useUpcomingMeetings({
					projectId: "p1",
					organizationId: null,
					enabled: true,
				}),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.meetings).toHaveLength(1));
		expect(listUpcoming).toHaveBeenCalledTimes(1);

		act(() => result.current.loadLater());

		await waitFor(() => expect(result.current.meetings).toHaveLength(2));
		expect(result.current.hasLoadedLater).toBe(true);
		const laterArgs = listUpcoming.mock.calls[1][0];
		expect(laterArgs.startOffsetDays).toBe(2);
		expect(laterArgs.daysForward).toBe(14);
		expect(result.current.meetings.map((m) => m.subject)).toEqual([
			"Fabric DSU",
			"Sprint Review",
		]);
	});

	it("dedupes a meeting returned by both windows", async () => {
		listUpcoming.mockResolvedValue({ meetings: [MEETING] });

		const { result } = renderHook(
			() =>
				useUpcomingMeetings({
					projectId: "p1",
					organizationId: null,
					enabled: true,
				}),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.meetings).toHaveLength(1));
		act(() => result.current.loadLater());

		await waitFor(() => expect(result.current.hasLoadedLater).toBe(true));
		expect(result.current.meetings).toHaveLength(1);
	});

	it("does not chase the later window through a connection that does not exist", async () => {
		listUpcoming.mockResolvedValue({
			meetings: [],
			error: "not-connected",
		});

		const { result } = renderHook(
			() =>
				useUpcomingMeetings({
					projectId: "p1",
					organizationId: null,
					enabled: true,
				}),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.notConnected).toBe(true));
		act(() => result.current.loadLater());

		await waitFor(() => expect(result.current.isLoadingLater).toBe(false));
		expect(listUpcoming).toHaveBeenCalledTimes(1);
	});
	// The sentinel's IntersectionObserver effect depends on this callback's
	// identity. `laterQuery` is a fresh object on every render, so depending on
	// it rebuilt the observer on every render — needless churn, and a plausible
	// way to miss an intersection under load.
	it("keeps loadLater stable across re-renders", async () => {
		listUpcoming.mockResolvedValue({ meetings: [MEETING] });

		const { result, rerender } = renderHook(
			() =>
				useUpcomingMeetings({
					projectId: "p1",
					organizationId: null,
					enabled: true,
				}),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.meetings).toHaveLength(1));
		const first = result.current.loadLater;

		rerender();
		rerender();

		expect(result.current.loadLater).toBe(first);
	});
});
