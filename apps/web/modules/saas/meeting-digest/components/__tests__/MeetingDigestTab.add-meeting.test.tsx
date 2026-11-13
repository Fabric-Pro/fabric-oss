/**
 * Fizzy #3507: "Add meeting" in the Meeting Digest offers every way in, for
 * the people who may change the project's meeting sources.
 *
 * The calendar item must still open the digest's own picker, so linking keeps
 * refreshing the digest as it did (#1898), and the page must keep exactly one
 * add control on screen at a time.
 */

import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingDigestTab } from "../MeetingDigestTab";

const { refreshAfterLinkMock } = vi.hoisted(() => ({
	refreshAfterLinkMock: vi.fn(),
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
		refreshAfterLink: refreshAfterLinkMock,
	}),
}));

vi.mock("../../hooks/use-linked-meeting-join-urls", () => ({
	LINKED_MEETINGS_QUERY_KEY: "meeting-transcript-sync-linked",
	useLinkedMeetingJoinUrls: () => ({ joinUrls: [] }),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

vi.mock("@saas/meetings/components", () => ({
	LinkedMeetingSelector: ({ open }: { open: boolean }) =>
		open ? <div data-testid="meeting-picker" /> : null,
}));

vi.mock("@saas/projects/components/TranscriptFileUpload", () => ({
	TranscriptFileUpload: () => <div data-testid="uploader" />,
}));

vi.mock("@saas/projects/components/MeetingTranscriptSyncSettings", () => ({
	MeetingTranscriptSyncSettings: () => <div data-testid="teams-settings" />,
}));

vi.mock("@saas/projects/components/SlackChannelMonitorSettings", () => ({
	SlackChannelMonitorSettings: () => <div data-testid="slack-settings" />,
}));

vi.mock(
	"@saas/projects/components/meeting-sources/UploadedTranscriptProgress",
	() => ({
		UploadedTranscriptProgress: ({
			onFinished,
			onReview,
		}: {
			onFinished?: () => void;
			onReview?: () => void;
		}) => (
			<div data-testid="upload-progress">
				<button type="button" onClick={onReview}>
					Review uploads
				</button>
				<button type="button" onClick={onFinished}>
					finish
				</button>
			</div>
		),
	}),
);

vi.mock(
	"@saas/projects/components/meeting-sources/TranscriptFolderProgress",
	() => ({ TranscriptFolderProgress: () => null }),
);

vi.mock(
	"@saas/projects/components/meeting-sources/ConnectTranscriptFolderDialog",
	() => ({ ConnectTranscriptFolderDialog: () => null }),
);

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

function renderTab(withSources: boolean) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<FeatureFlagProvider value={{ PERSONAL_MEETINGS: false }}>
				{children}
			</FeatureFlagProvider>
		</QueryClientProvider>
	);
	return render(
		<MeetingDigestTab
			projectId="p1"
			organizationId="o1"
			canEdit
			meetingSources={
				withSources ? { meetingTranscriptSyncEnabled: true } : undefined
			}
		/>,
		{ wrapper },
	);
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("MeetingDigestTab add meeting (#3507)", () => {
	it("offers calendar, upload, series and folder from the empty state", async () => {
		renderTab(true);
		await userEvent.click(
			screen.getByRole("button", { name: /add meeting/i }),
		);
		const items = (await screen.findAllByRole("menuitem")).map(
			(item) => item.textContent,
		);
		expect(items).toEqual([
			"Add from calendar",
			"Upload transcript",
			"Configure meeting series",
			"Connect transcript folder",
		]);
	});

	it("opens the digest's own calendar picker from the menu", async () => {
		renderTab(true);
		await userEvent.click(
			screen.getByRole("button", { name: /add meeting/i }),
		);
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /add from calendar/i }),
		);
		expect(await screen.findByTestId("meeting-picker")).toBeInTheDocument();
	});

	it("keeps one add control when the configure panel is open", async () => {
		renderTab(true);
		await userEvent.click(
			screen.getByRole("button", { name: /configure meetings/i }),
		);
		expect(
			screen.getAllByRole("button", { name: /add meeting/i }),
		).toHaveLength(1);
		await userEvent.click(
			screen.getByRole("button", { name: /add meeting/i }),
		);
		expect(await screen.findAllByRole("menuitem")).toHaveLength(4);
	});

	it("shows upload progress, refreshes when it finishes, and opens the uploader to review", async () => {
		renderTab(true);
		fireEvent.click(screen.getByRole("button", { name: "finish" }));
		expect(refreshAfterLinkMock).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: "Review uploads" }));
		expect(await screen.findByRole("dialog")).toHaveTextContent(
			"Upload transcript",
		);
		expect(screen.getByTestId("uploader")).toBeInTheDocument();
	});

	it("stays the calendar picker alone without source access", async () => {
		renderTab(false);
		expect(screen.queryByTestId("upload-progress")).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: /add meeting/i }),
		);
		expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
		expect(await screen.findByTestId("meeting-picker")).toBeInTheDocument();
	});
});
