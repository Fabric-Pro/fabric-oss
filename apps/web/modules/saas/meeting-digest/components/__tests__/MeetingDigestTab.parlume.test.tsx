import type { FeatureFlagKey } from "@repo/utils/feature-flag-registry";
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
	useLinkedMeetingJoinUrls: () => ({ joinUrls: [] }),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
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

vi.mock("../ParlumeInviteDialog", () => ({
	ParlumeInviteDialog: () => <div data-testid="parlume-dialog" />,
}));

function renderTab(
	parlumeEnabled: boolean,
	canEdit = true,
	organizationId: string | null = "o1",
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<FeatureFlagProvider
				value={
					{
						PERSONAL_MEETINGS: false,
						MEETING_AGENDA: false,
						PARLUME_MEETINGS: parlumeEnabled,
					} as Record<FeatureFlagKey, boolean>
				}
			>
				{children}
			</FeatureFlagProvider>
		</QueryClientProvider>
	);
	return render(
		<MeetingDigestTab
			projectId="p1"
			organizationId={organizationId}
			canEdit={canEdit}
		/>,
		{ wrapper },
	);
}

describe("MeetingDigestTab — Parlume feature flag", () => {
	it("keeps the invitation control and dialog unmounted when the flag is off", () => {
		renderTab(false);
		expect(
			screen.queryByRole("button", { name: "Invite Parlume" }),
		).not.toBeInTheDocument();
		expect(screen.queryByTestId("parlume-dialog")).not.toBeInTheDocument();
	});

	it("shows the project-admin invitation control when the flag is on", () => {
		renderTab(true);
		expect(
			screen.getByRole("button", { name: "Invite Parlume" }),
		).toBeInTheDocument();
		expect(screen.getByTestId("parlume-dialog")).toBeInTheDocument();
	});

	it("does not render Parlume for a viewer", () => {
		renderTab(true, false);
		expect(
			screen.queryByRole("button", { name: "Invite Parlume" }),
		).not.toBeInTheDocument();
	});

	it("does not render Parlume for a personal project", () => {
		renderTab(true, true, null);
		expect(
			screen.queryByRole("button", { name: "Invite Parlume" }),
		).not.toBeInTheDocument();
	});
});
