import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useMeetingDigest, usePersonalMeetings } = vi.hoisted(() => ({
	useMeetingDigest: vi.fn(),
	usePersonalMeetings: vi.fn(),
}));

vi.mock("../../hooks/use-meeting-digest", () => ({ useMeetingDigest }));
vi.mock("../../hooks/use-personal-meetings", () => ({ usePersonalMeetings }));
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));
vi.mock("@saas/get-started/components/PageTourButton", () => ({
	PageTourButton: () => null,
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: {
				getMeeting: vi.fn(),
				getPersonalTranscript: vi.fn(),
			},
		},
	},
}));

import { MeetingDigestTab } from "../MeetingDigestTab";

const JOIN_URL = "https://teams.microsoft.com/l/meetup-join/AAA";

const AWAITING = [
	{
		linkedMeetingId: "lm1",
		subject: "Fabric DSU",
		occurrenceStart: new Date("2026-07-14T09:00:00Z"),
		joinUrl: JOIN_URL,
	},
];

function digestValue(overrides: Record<string, unknown> = {}) {
	return {
		meetings: [],
		configMeetings: [],
		seriesWithoutTranscripts: [],
		awaitingOccurrences: [],
		isLoading: false,
		isError: false,
		setIncluded: vi.fn(),
		unlinkMeeting: vi.fn(),
		refreshAfterLink: vi.fn(),
		onActionItemToggled: vi.fn(),
		generateSummary: vi.fn(),
		generatingRefs: new Set(),
		summaryErrors: new Map(),
		...overrides,
	};
}

/**
 * Selecting "All meetings" is a view choice; loading personal data
 * additionally requires consent. Both are needed before the personal lane
 * renders anything (FR1 + FR2), so the dedup tests have to walk the real flow.
 */
async function activatePersonalLane() {
	fireEvent.click(screen.getByRole("button", { name: /all meetings/i }));
	fireEvent.click(
		screen.getByRole("button", { name: /enable personal meetings/i }),
	);
	await waitFor(() =>
		expect(usePersonalMeetings).toHaveBeenLastCalledWith(
			expect.objectContaining({ enabled: true }),
		),
	);
}

function renderTab(personalMeetingsEnabled = false) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<FeatureFlagProvider
				value={{ PERSONAL_MEETINGS: personalMeetingsEnabled }}
			>
				{children}
			</FeatureFlagProvider>
		</QueryClientProvider>
	);
	return render(
		<MeetingDigestTab
			projectId="p1"
			organizationId={null}
			canEdit={false}
		/>,
		{ wrapper },
	);
}

describe("MeetingDigestTab awaiting-transcript rows (#2051)", () => {
	beforeEach(() => {
		// The fixture is a fixed July 2026 date and monthDate initialises to the
		// real clock; CalendarCanvas only renders days inside the current month
		// grid. Freeze to match, as the sibling personal suite does.
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(new Date("2026-07-14T12:00:00Z"));
		sessionStorage.clear();
		vi.clearAllMocks();
		usePersonalMeetings.mockReturnValue({
			personalMeetings: [],
			isLoading: false,
			isError: false,
			notConnected: false,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders the calendar when awaiting rows are the only content", () => {
		// listDigest returned no transcript-backed meetings at all — exactly the
		// reported scenario, where a project's only meetings are unsynced.
		useMeetingDigest.mockReturnValue(
			digestValue({ awaitingOccurrences: AWAITING }),
		);

		renderTab();

		expect(screen.getByText("Fabric DSU")).toBeInTheDocument();
		expect(
			screen.queryByText("No meetings in the digest yet."),
		).not.toBeInTheDocument();
	});

	it("marks the awaiting row as awaiting a transcript, not as a meeting to open", () => {
		useMeetingDigest.mockReturnValue(
			digestValue({ awaitingOccurrences: AWAITING }),
		);

		renderTab();

		expect(
			screen.getByLabelText("Awaiting transcript"),
		).toBeInTheDocument();
	});

	it("does not also render the meeting through the personal lane", async () => {
		// listPersonalMeetings only suppresses a linked meeting once it HAS a
		// transcript, so an awaiting meeting still arrives here labelled
		// "Not synced yet" — it must not appear twice in the same cell.
		useMeetingDigest.mockReturnValue(
			digestValue({ awaitingOccurrences: AWAITING }),
		);
		usePersonalMeetings.mockReturnValue({
			personalMeetings: [
				{
					id: "evt1",
					subject: "Fabric DSU",
					startTime: "2026-07-14T09:00:00Z",
					organizer: "Sam Rivers",
					joinUrl: JOIN_URL,
					linkedWithoutTranscript: true,
				},
			],
			isLoading: false,
			isError: false,
			notConnected: false,
		});

		renderTab(true);
		await activatePersonalLane();

		expect(screen.getAllByText("Fabric DSU")).toHaveLength(1);
	});

	it("keeps a personal occurrence on a day that has no awaiting row", async () => {
		useMeetingDigest.mockReturnValue(
			digestValue({ awaitingOccurrences: AWAITING }),
		);
		usePersonalMeetings.mockReturnValue({
			personalMeetings: [
				{
					id: "evt2",
					subject: "Fabric DSU",
					// Same series, different day — the team view says nothing
					// about this one, so hiding it would recreate the #1899 hole.
					startTime: "2026-07-13T09:00:00Z",
					organizer: "Sam Rivers",
					joinUrl: JOIN_URL,
					linkedWithoutTranscript: true,
				},
			],
			isLoading: false,
			isError: false,
			notConnected: false,
		});

		renderTab(true);
		await activatePersonalLane();

		expect(screen.getAllByText("Fabric DSU")).toHaveLength(2);
	});

	it("still shows the empty state when there is nothing at all", () => {
		useMeetingDigest.mockReturnValue(digestValue());

		renderTab();

		expect(
			screen.getByText("No meetings in the digest yet."),
		).toBeInTheDocument();
	});
});
