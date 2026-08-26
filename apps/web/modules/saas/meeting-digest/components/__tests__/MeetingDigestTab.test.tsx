import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { addMonths, format, subMonths } from "date-fns";
import { describe, expect, it, vi } from "vitest";
import type { ConfigMeeting } from "../../hooks/use-meeting-digest";
import type { DigestMeeting } from "../../lib/types";

const mockSetIncluded = vi.hoisted(() => vi.fn());

// These tests render MeetingDigestTab outside the app's provider tree. The
// confirmation provider no longer supplies a no-op default (#1905), so the hook
// is mocked here the same way the sibling MeetingDigestTab suites do.
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

vi.mock("../../hooks/use-meeting-digest", () => ({
	useMeetingDigest: () => ({
		meetings: MEETINGS,
		configMeetings: CONFIG_MEETINGS,
		seriesWithoutTranscripts: SERIES_WITHOUT_TRANSCRIPTS,
		awaitingOccurrences: [],
		isLoading: false,
		isError: false,
		setIncluded: mockSetIncluded,
	}),
}));

const SERIES_WITHOUT_TRANSCRIPTS = [
	{ linkedMeetingId: "lm-empty", subject: "Weekly Steering" },
];

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: {
				getMeeting: vi.fn(),
			},
		},
	},
}));

const MEETINGS: DigestMeeting[] = [
	{
		linkedMeetingId: "lm-included",
		transcriptId: "t-included",
		subject: "Included DSU",
		meetingDate: null,
		hasTranscript: true,
		analysisStatus: "SCANNED",
		createdTaskCount: 0,
		participantCount: 0,
		includedInDigest: true,
	},
	{
		linkedMeetingId: "lm-excluded",
		transcriptId: "t-excluded",
		subject: "Excluded Sync",
		meetingDate: null,
		hasTranscript: true,
		analysisStatus: "SCANNED",
		createdTaskCount: 0,
		participantCount: 0,
		includedInDigest: false,
	},
];

const CONFIG_MEETINGS: ConfigMeeting[] = [
	{
		linkedMeetingId: "lm-included",
		subject: "Included DSU",
		includedInDigest: true,
		lastMeetingDate: null,
	},
	{
		linkedMeetingId: "lm-excluded",
		subject: "Excluded Sync",
		includedInDigest: false,
		lastMeetingDate: null,
	},
];

import { MeetingDigestTab } from "../MeetingDigestTab";

function renderWithQuery(ui: React.ReactElement) {
	const queryClient = new QueryClient();
	return render(
		<QueryClientProvider client={queryClient}>
			<FeatureFlagProvider value={{ PERSONAL_MEETINGS: false }}>
				{ui}
			</FeatureFlagProvider>
		</QueryClientProvider>,
	);
}

describe("MeetingDigestTab — excluded meetings remain visible and re-includable", () => {
	it("shows both included and excluded meetings in the config panel", () => {
		renderWithQuery(
			<MeetingDigestTab
				projectId="p1"
				organizationId={null}
				canEdit={true}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /configure meetings/i }),
		);

		expect(screen.getByText("Included DSU")).toBeInTheDocument();
		expect(screen.getByText("Excluded Sync")).toBeInTheDocument();
	});

	it("shows Exclude button for included meeting and Include button for excluded meeting", () => {
		renderWithQuery(
			<MeetingDigestTab
				projectId="p1"
				organizationId={null}
				canEdit={true}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /configure meetings/i }),
		);

		expect(
			screen.getByRole("button", { name: /^exclude$/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^include$/i }),
		).toBeInTheDocument();
	});

	it("calls setIncluded with the excluded meeting id and true when Include is clicked", () => {
		renderWithQuery(
			<MeetingDigestTab
				projectId="p1"
				organizationId={null}
				canEdit={true}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /configure meetings/i }),
		);

		fireEvent.click(screen.getByRole("button", { name: /^include$/i }));

		expect(mockSetIncluded).toHaveBeenCalledWith("lm-excluded", true);
	});
});

describe("MeetingDigestTab — month navigation", () => {
	it("shows the current month label by default", () => {
		renderWithQuery(
			<MeetingDigestTab
				projectId="p1"
				organizationId={null}
				canEdit={false}
			/>,
		);
		expect(
			screen.getByText(format(new Date(), "MMMM yyyy")),
		).toBeInTheDocument();
	});

	it("navigates to the previous month and back to today", () => {
		renderWithQuery(
			<MeetingDigestTab
				projectId="p1"
				organizationId={null}
				canEdit={false}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /previous month/i }),
		);
		expect(
			screen.getByText(format(subMonths(new Date(), 1), "MMMM yyyy")),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /^today$/i }));
		expect(
			screen.getByText(format(new Date(), "MMMM yyyy")),
		).toBeInTheDocument();
	});

	it("lists included series that have no synced transcripts yet", () => {
		renderWithQuery(
			<MeetingDigestTab
				projectId="p1"
				organizationId={null}
				canEdit={false}
			/>,
		);
		expect(screen.getByText(/weekly steering/i)).toBeInTheDocument();
		expect(
			screen.getByText(/no transcripts synced yet/i),
		).toBeInTheDocument();
	});

	it("navigates to the next month", () => {
		renderWithQuery(
			<MeetingDigestTab
				projectId="p1"
				organizationId={null}
				canEdit={false}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /next month/i }));
		expect(
			screen.getByText(format(addMonths(new Date(), 1), "MMMM yyyy")),
		).toBeInTheDocument();
	});
});
