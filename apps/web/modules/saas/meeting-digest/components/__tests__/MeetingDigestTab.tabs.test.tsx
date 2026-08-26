/**
 * #2143 — Upcoming/Calendar tab split.
 *
 * The Upcoming section and the calendar used to render stacked on one page.
 * These tests pin the tabbed layout: Upcoming is the default tab, Calendar
 * holds the month toolbar/canvas, switching is client-side and loses no
 * calendar state, and orgs without MEETING_AGENDA keep the untabbed
 * calendar-only layout (the tab split would otherwise gift them a
 * permanently-empty Upcoming tab — the section stays flag-gated per #1901a).
 */

import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { format, subMonths } from "date-fns";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingDigestTab } from "../MeetingDigestTab";

// Re-mocks the global vitest.setup next/navigation stub with a controllable
// search-params source, so the #1902 deep-link test can simulate arriving from
// a work item's back-reference. Everything else mirrors the global mock.
const { searchParams } = vi.hoisted(() => ({
	searchParams: { current: new URLSearchParams() },
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: vi.fn(),
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
		pathname: "/",
		query: {},
	}),
	usePathname: () => "/",
	useSearchParams: () => searchParams.current,
}));

// Stubbed to surface which transcript it was asked to open: the deep-link
// test only cares that the sheet receives the ref while the Upcoming tab is
// active (the sheet mounts at the component root, outside the Tabs).
vi.mock("../MeetingDetailSheet", () => ({
	MeetingDetailSheet: ({ transcriptId }: { transcriptId: string | null }) =>
		transcriptId ? (
			<div data-testid="meeting-detail-sheet">{transcriptId}</div>
		) : null,
}));

vi.mock("../../hooks/use-meeting-digest", () => ({
	useMeetingDigest: () => ({
		meetings: [],
		configMeetings: [],
		seriesWithoutTranscripts: [],
		awaitingOccurrences: [],
		isLoading: false,
		isError: false,
		setIncluded: vi.fn(),
		onActionItemToggled: vi.fn(),
		generateSummary: vi.fn(),
		generatingRefs: new Set(),
		summaryErrors: {},
		unlinkMeeting: vi.fn(),
		refreshAfterLink: vi.fn(),
	}),
}));

vi.mock("../../hooks/use-linked-meeting-join-urls", () => ({
	LINKED_MEETINGS_QUERY_KEY: "meeting-transcript-sync-linked",
	useLinkedMeetingJoinUrls: () => ({ joinUrls: [] }),
}));

// The section owns its own data fetching (useUpcomingMeetings → orpc). All
// this suite needs to know is which tab it is mounted on, so it's stubbed to
// something unambiguously identifiable rather than pulled in for real.
vi.mock("../UpcomingMeetingsSection", () => ({
	UpcomingMeetingsSection: () => (
		<div data-testid="upcoming-meetings-section" />
	),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

function renderTab(meetingAgendaEnabled = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<FeatureFlagProvider
				value={{
					PERSONAL_MEETINGS: false,
					MEETING_AGENDA: meetingAgendaEnabled,
				}}
			>
				{children}
			</FeatureFlagProvider>
		</QueryClientProvider>
	);
	return render(
		<MeetingDigestTab
			projectId="p1"
			organizationId={null}
			canEdit={true}
		/>,
		{ wrapper },
	);
}

const monthLabel = () => format(new Date(), "MMMM yyyy");

beforeEach(() => {
	searchParams.current = new URLSearchParams();
});

describe("MeetingDigestTab — #2143 tab split", () => {
	it("defaults to the Upcoming tab and keeps calendar content off-DOM", () => {
		renderTab();

		expect(
			screen.getByRole("tab", { name: "Upcoming", selected: true }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("tab", { name: "Calendar", selected: false }),
		).toBeInTheDocument();
		expect(
			screen.getByTestId("upcoming-meetings-section"),
		).toBeInTheDocument();
		// The month toolbar lives on the Calendar tab, which is unmounted.
		expect(screen.queryByText(monthLabel())).not.toBeInTheDocument();
	});

	it("switches to Calendar on click and shows the calendar view", async () => {
		const user = userEvent.setup();
		renderTab();

		await user.click(screen.getByRole("tab", { name: "Calendar" }));

		expect(
			screen.getByRole("tab", { name: "Calendar", selected: true }),
		).toBeInTheDocument();
		expect(screen.getByText(monthLabel())).toBeInTheDocument();
		// Empty digest → the calendar-side empty state, on this tab.
		expect(
			screen.getByText(/no meetings in the digest yet/i),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("upcoming-meetings-section"),
		).not.toBeInTheDocument();
	});

	it("preserves calendar month state across a tab round trip", async () => {
		const user = userEvent.setup();
		renderTab();

		await user.click(screen.getByRole("tab", { name: "Calendar" }));
		await user.click(
			screen.getByRole("button", { name: /previous month/i }),
		);
		const previous = format(subMonths(new Date(), 1), "MMMM yyyy");
		expect(screen.getByText(previous)).toBeInTheDocument();

		await user.click(screen.getByRole("tab", { name: "Upcoming" }));
		await user.click(screen.getByRole("tab", { name: "Calendar" }));

		// monthDate lives in MeetingDigestTab, which never unmounts.
		expect(screen.getByText(previous)).toBeInTheDocument();
	});

	it("supports arrow-key navigation between tabs", async () => {
		const user = userEvent.setup();
		renderTab();

		await user.click(screen.getByRole("tab", { name: "Upcoming" }));
		await user.keyboard("{ArrowRight}");

		// Radix automatic activation: arrow moves focus AND selects.
		expect(
			screen.getByRole("tab", { name: "Calendar", selected: true }),
		).toBeInTheDocument();
		expect(screen.getByText(monthLabel())).toBeInTheDocument();
	});

	it("renders no tabs and the calendar directly when MEETING_AGENDA is off", () => {
		renderTab(false);

		expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
		expect(screen.getByText(monthLabel())).toBeInTheDocument();
		expect(
			screen.queryByTestId("upcoming-meetings-section"),
		).not.toBeInTheDocument();
	});

	// #1898 review finding 1's invariant, carried across the tab boundary: an
	// empty digest must always keep exactly one one-click "Add meeting"
	// affordance on screen. The empty state (with its own Add button) lives on
	// the Calendar tab, so on the Upcoming tab the header button must stand in
	// — it may only yield while the empty state is actually mounted.
	it("keeps exactly one Add meeting control on each tab when the digest is empty", async () => {
		const user = userEvent.setup();
		renderTab();

		// Upcoming tab: empty state is unmounted, header button must show.
		expect(
			screen.getAllByRole("button", { name: /add meeting/i }),
		).toHaveLength(1);

		await user.click(screen.getByRole("tab", { name: "Calendar" }));

		// Calendar tab: empty state's own button shows, header button yields.
		expect(
			screen.getAllByRole("button", { name: /add meeting/i }),
		).toHaveLength(1);
	});

	it("keeps the selected tab across a Configure panel round trip", async () => {
		const user = userEvent.setup();
		renderTab();

		await user.click(screen.getByRole("tab", { name: "Calendar" }));
		await user.click(
			screen.getByRole("button", { name: /configure meetings/i }),
		);

		// The config panel replaces the whole tab area, exactly as it
		// replaced both stacked sections before #2143.
		expect(screen.queryByRole("tablist")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /^done$/i }));

		// digestTab is controlled state in the parent, so remounting the Tabs
		// must restore Calendar — defaultValue would silently reset here.
		expect(
			screen.getByRole("tab", { name: "Calendar", selected: true }),
		).toBeInTheDocument();
		expect(screen.getByText(monthLabel())).toBeInTheDocument();
	});

	// #1902: a work item's back-reference deep-links into the digest with
	// ?meeting=<transcriptRef>. The detail sheet mounts at the component root
	// — outside the Tabs — so it must open even though the default tab is
	// Upcoming and the calendar is unmounted. Pins the sheet's placement:
	// moving it inside the calendar TabsContent would break every work-item
	// back-reference for flag-on orgs.
	it("opens the deep-linked meeting sheet while the Upcoming tab is active", () => {
		searchParams.current = new URLSearchParams(
			"meeting=graph-transcript-1&actionItem=item-key-1",
		);
		renderTab();

		expect(
			screen.getByRole("tab", { name: "Upcoming", selected: true }),
		).toBeInTheDocument();
		expect(screen.getByTestId("meeting-detail-sheet")).toHaveTextContent(
			"graph-transcript-1",
		);
	});
});
