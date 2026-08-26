/**
 * LinkedMeetingSelector — first test coverage, added when the component was
 * lifted out of the projects module for reuse by the Meeting Digest (#1898).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedMeetingSelector } from "../LinkedMeetingSelector";

const { listMeetingsMock, linkMeetingMock, toastWarningMock } = vi.hoisted(
	() => ({
		listMeetingsMock: vi.fn(),
		linkMeetingMock: vi.fn(),
		toastWarningMock: vi.fn(),
	}),
);

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			backlog: { listMeetings: listMeetingsMock },
			meetingTranscriptSync: { linkMeeting: linkMeetingMock },
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), warning: toastWarningMock, error: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderSelector(props: Partial<{ existingJoinUrls: string[] }> = {}) {
	return render(
		<LinkedMeetingSelector
			projectId="p1"
			organizationId="o1"
			open={true}
			onOpenChange={vi.fn()}
			onLinked={vi.fn()}
			existingJoinUrls={props.existingJoinUrls ?? []}
		/>,
		{ wrapper },
	);
}

describe("LinkedMeetingSelector", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listMeetingsMock.mockResolvedValue({
			meetings: [
				{
					id: "m1",
					subject: "FABRIC | DSU",
					startTime: "2026-07-20T09:00:00Z",
					organizer: "dev@example.com",
					joinUrl: "https://teams.microsoft.com/l/meetup-join/dsu",
				},
			],
		});
	});

	it("lists a fetched meeting as selectable", async () => {
		renderSelector();
		expect(await screen.findByText("FABRIC | DSU")).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", { name: /select fabric \| dsu/i }),
		).not.toBeDisabled();
	});

	it("marks an already-linked meeting as linked and non-selectable", async () => {
		// A second, unlinked meeting keeps at least one meeting selectable so
		// this exercises the "linked row" rendering rather than the
		// all-linked empty state (see the dedicated empty-state test below).
		listMeetingsMock.mockResolvedValue({
			meetings: [
				{
					id: "m1",
					subject: "FABRIC | DSU",
					startTime: "2026-07-20T09:00:00Z",
					organizer: "dev@example.com",
					joinUrl: "https://teams.microsoft.com/l/meetup-join/dsu",
				},
				{
					id: "m2",
					subject: "Steering",
					startTime: "2026-07-21T09:00:00Z",
					organizer: "b@example.com",
					joinUrl: "https://teams/steering",
				},
			],
		});
		renderSelector({
			existingJoinUrls: ["https://teams.microsoft.com/l/meetup-join/dsu"],
		});
		expect(await screen.findByText("FABRIC | DSU")).toBeInTheDocument();
		expect(screen.getByText("Linked")).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", { name: /select fabric \| dsu/i }),
		).toBeDisabled();
	});

	it("shows a distinct empty state when every meeting is already linked", async () => {
		renderSelector({
			existingJoinUrls: ["https://teams.microsoft.com/l/meetup-join/dsu"],
		});
		expect(
			await screen.findByText(/no additional meetings available to add/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/every meeting in this date range is already linked/i,
			),
		).toBeInTheDocument();
	});

	it("surfaces the soft not-connected error instead of an empty list", async () => {
		listMeetingsMock.mockResolvedValue({
			meetings: [],
			error: "Microsoft account not connected",
		});
		renderSelector();
		expect(
			await screen.findByText(/microsoft account not connected/i),
		).toBeInTheDocument();
	});

	it("reports partial failure when one of several link calls fails", async () => {
		listMeetingsMock.mockResolvedValue({
			meetings: [
				{
					id: "m1",
					subject: "DSU",
					startTime: "2026-07-20T09:00:00Z",
					organizer: "a@example.com",
					joinUrl: "https://teams/a",
				},
				{
					id: "m2",
					subject: "Steering",
					startTime: "2026-07-21T09:00:00Z",
					organizer: "b@example.com",
					joinUrl: "https://teams/b",
				},
			],
		});
		linkMeetingMock
			.mockResolvedValueOnce({ success: true })
			.mockRejectedValueOnce(new Error("boom"));

		const onLinked = vi.fn();
		render(
			<LinkedMeetingSelector
				projectId="p1"
				organizationId="o1"
				open={true}
				onOpenChange={vi.fn()}
				onLinked={onLinked}
				existingJoinUrls={[]}
			/>,
			{ wrapper },
		);

		await screen.findByText("DSU");
		await userEvent.click(
			screen.getByRole("checkbox", { name: /select dsu/i }),
		);
		await userEvent.click(
			screen.getByRole("checkbox", { name: /select steering/i }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: /link 2 meetings/i }),
		);

		await waitFor(() =>
			expect(toastWarningMock).toHaveBeenCalledWith("1 linked, 1 failed"),
		);
		expect(onLinked).toHaveBeenCalledTimes(1);
	});
});
