/**
 * #1901a coverage gap — the MEETING_AGENDA flag wiring in MeetingDigestTab.
 *
 * The other MeetingDigestTab suites only pass `{ PERSONAL_MEETINGS: ... }` to
 * FeatureFlagProvider, so `useFeatureFlag("MEETING_AGENDA")` resolves
 * `undefined` there and the Upcoming section silently never renders in those
 * suites. Nothing previously asserted either direction of the flag.
 */

import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MeetingDigestTab } from "../MeetingDigestTab";

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
// this suite needs to know is whether it mounted at all, so it's stubbed to
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

function renderTab(meetingAgendaEnabled: boolean) {
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

describe("MeetingDigestTab — MEETING_AGENDA flag wiring", () => {
	it("mounts UpcomingMeetingsSection when the flag is on", () => {
		renderTab(true);

		expect(
			screen.getByTestId("upcoming-meetings-section"),
		).toBeInTheDocument();
	});

	it("does not mount UpcomingMeetingsSection when the flag is off", () => {
		renderTab(false);

		expect(
			screen.queryByTestId("upcoming-meetings-section"),
		).not.toBeInTheDocument();
	});
});
