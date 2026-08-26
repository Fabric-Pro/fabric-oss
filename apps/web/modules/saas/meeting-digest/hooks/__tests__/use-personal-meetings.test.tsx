import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { endOfMonth, startOfMonth } from "date-fns";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listPersonalMeetings } = vi.hoisted(() => ({
	listPersonalMeetings: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { meetingDigest: { listPersonalMeetings } },
	},
}));

import { usePersonalMeetings } from "../use-personal-meetings";

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

const ROW = {
	id: "evt1",
	subject: "1:1 with Sam",
	startTime: "2026-07-14T09:00:00Z",
	organizer: "Sam Rivers",
	joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
};

describe("usePersonalMeetings", () => {
	beforeEach(() => vi.clearAllMocks());

	it("does not call the API when disabled", () => {
		renderHook(
			() =>
				usePersonalMeetings({
					projectId: "p1",
					organizationId: null,
					monthDate: new Date("2026-07-14"),
					enabled: false,
				}),
			{ wrapper },
		);

		expect(listPersonalMeetings).not.toHaveBeenCalled();
	});

	it("fetches the month window when enabled", async () => {
		listPersonalMeetings.mockResolvedValue({ meetings: [ROW] });

		const { result } = renderHook(
			() =>
				usePersonalMeetings({
					projectId: "p1",
					organizationId: "org1",
					monthDate: new Date("2026-07-14T12:00:00Z"),
					enabled: true,
				}),
			{ wrapper },
		);

		await waitFor(() =>
			expect(result.current.personalMeetings).toHaveLength(1),
		);

		const args = listPersonalMeetings.mock.calls[0][0];
		expect(args.projectId).toBe("p1");
		expect(args.organizationId).toBe("org1");
		// Pin the actual month bounds. `from < to` is near-tautological for any
		// Date pair and would pass for a badly shifted or one-day window.
		expect(args.from).toEqual(
			startOfMonth(new Date("2026-07-14T12:00:00Z")),
		);
		expect(args.to).toEqual(endOfMonth(new Date("2026-07-14T12:00:00Z")));
	});

	it("surfaces the not-connected state without throwing", async () => {
		listPersonalMeetings.mockResolvedValue({
			meetings: [],
			error: "not-connected",
		});

		const { result } = renderHook(
			() =>
				usePersonalMeetings({
					projectId: "p1",
					organizationId: null,
					monthDate: new Date("2026-07-14"),
					enabled: true,
				}),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.notConnected).toBe(true));
		expect(result.current.isError).toBe(false);
		expect(result.current.personalMeetings).toEqual([]);
	});

	it("clears personal data as soon as the user opts out", async () => {
		listPersonalMeetings.mockResolvedValue({ meetings: [ROW] });

		const { result, rerender } = renderHook(
			({ enabled }: { enabled: boolean }) =>
				usePersonalMeetings({
					projectId: "p1",
					organizationId: null,
					monthDate: new Date("2026-07-14"),
					enabled,
				}),
			{ wrapper, initialProps: { enabled: true } },
		);

		await waitFor(() =>
			expect(result.current.personalMeetings).toHaveLength(1),
		);

		// The component stays mounted; only the opt-in flag flips. React Query
		// keeps the cached data in that case, so the hook must gate on it.
		rerender({ enabled: false });

		expect(result.current.personalMeetings).toEqual([]);
	});
});
