import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMeeting, getContent, extractInsights } = vi.hoisted(() => ({
	getMeeting: vi.fn(),
	getContent: vi.fn(),
	extractInsights: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: { getMeeting, extractInsights },
			meetingTranscriptSync: { getContent },
		},
	},
}));
vi.mock("next/navigation", () => ({
	usePathname: () => "/app/acme/projects/p1",
}));

import { MeetingDetailSheet } from "../MeetingDetailSheet";

function renderWithQuery(ui: React.ReactElement) {
	const queryClient = new QueryClient();
	return render(
		<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
	);
}

function meetingFixture(overrides: Record<string, unknown>) {
	return {
		subject: "Sprint Review",
		meetingDate: new Date("2026-06-10"),
		organizer: "Ann",
		participants: [],
		summary: null,
		analysisStatus: "SCANNED",
		analyzedAt: null,
		analysisError: null,
		hasTranscript: true,
		transcriptRef: "row1",
		insightsReady: true,
		createdTasks: [],
		decisions: null,
		actionItems: [],
		openQuestions: null,
		declinedTasks: null,
		...overrides,
	};
}

describe("MeetingDetailSheet — expanded summary view (#2108)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("expands the summary into a modal showing the same markdown, with no new fetches", async () => {
		getMeeting.mockResolvedValue(
			meetingFixture({
				summary: "## Key outcomes\n\n- Shipped the digest",
			}),
		);
		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);
		const expand = await screen.findByRole("button", {
			name: "Expand summary",
		});
		const callsBefore = getMeeting.mock.calls.length;
		fireEvent.click(expand);
		const dialog = await screen.findByRole("dialog", {
			name: "Summary — Sprint Review",
		});
		expect(
			within(dialog).getByRole("heading", { name: "Key outcomes" }),
		).toBeInTheDocument();
		expect(
			within(dialog).getByText("Shipped the digest"),
		).toBeInTheDocument();
		// AC5: opening the modal performs no I/O.
		expect(getMeeting.mock.calls.length).toBe(callsBefore);
		expect(getContent).not.toHaveBeenCalled();
	});

	it("offers no summary expand when there is no summary", async () => {
		getMeeting.mockResolvedValue(
			meetingFixture({ hasTranscript: false, insightsReady: false }),
		);
		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);
		await screen.findByText("No summary available.");
		expect(
			screen.queryByRole("button", { name: "Expand summary" }),
		).not.toBeInTheDocument();
	});

	it("closing the modal preserves the sheet's active tab (FR3)", async () => {
		getMeeting.mockResolvedValue(meetingFixture({ summary: "All done." }));
		const user = userEvent.setup();
		renderWithQuery(
			<MeetingDetailSheet
				projectId="pr1"
				organizationId={null}
				transcriptId="t1"
				onClose={() => {}}
			/>,
		);
		// Radix tabs activate on focus/mousedown — use userEvent, not
		// fireEvent.click, or the tab never actually switches.
		await user.click(await screen.findByRole("tab", { name: "Questions" }));
		expect(screen.getByRole("tab", { name: "Questions" })).toHaveAttribute(
			"data-state",
			"active",
		);
		fireEvent.click(screen.getByRole("button", { name: "Expand summary" }));
		const dialog = await screen.findByRole("dialog", {
			name: "Summary — Sprint Review",
		});
		fireEvent.keyDown(dialog, { key: "Escape" });
		await waitFor(() =>
			expect(
				screen.queryByRole("dialog", {
					name: "Summary — Sprint Review",
				}),
			).not.toBeInTheDocument(),
		);
		expect(screen.getByRole("tab", { name: "Questions" })).toHaveAttribute(
			"data-state",
			"active",
		);
	});

	it("switching meetings closes an open expanded summary (no cross-meeting leak)", async () => {
		// The dangerous case is a CACHE-WARM switch: getMeeting returns the
		// next meeting's data synchronously from the TanStack cache, so an
		// effect-based reset would render one frame with the modal open on
		// the new meeting's content. Seed both meetings into one shared
		// client to exercise exactly that path.
		const queryClient = new QueryClient();
		queryClient.setQueryData(
			["projects.meetingDigest.getMeeting", "pr1", "t1"],
			meetingFixture({ summary: "Meeting A summary." }),
		);
		queryClient.setQueryData(
			["projects.meetingDigest.getMeeting", "pr1", "t2"],
			meetingFixture({
				subject: "Retro",
				summary: "Meeting B summary.",
			}),
		);
		getMeeting.mockResolvedValue(
			meetingFixture({ summary: "Meeting A summary." }),
		);
		const { rerender } = render(
			<QueryClientProvider client={queryClient}>
				<MeetingDetailSheet
					projectId="pr1"
					organizationId={null}
					transcriptId="t1"
					onClose={() => {}}
				/>
			</QueryClientProvider>,
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Expand summary" }),
		);
		await screen.findByRole("dialog", { name: "Summary — Sprint Review" });

		getMeeting.mockResolvedValue(
			meetingFixture({ subject: "Retro", summary: "Meeting B summary." }),
		);
		rerender(
			<QueryClientProvider client={queryClient}>
				<MeetingDetailSheet
					projectId="pr1"
					organizationId={null}
					transcriptId="t2"
					onClose={() => {}}
				/>
			</QueryClientProvider>,
		);
		// Render-time reset: no dialog for either meeting, with no waitFor —
		// the modal must already be closed by the time this render commits.
		expect(
			screen.queryByRole("dialog", { name: /Summary — / }),
		).not.toBeInTheDocument();
	});
});
