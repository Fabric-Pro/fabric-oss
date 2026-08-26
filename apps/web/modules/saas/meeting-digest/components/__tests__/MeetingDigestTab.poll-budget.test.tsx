/**
 * Reviewer-reproduced bug: AgendaSheet is rendered with no `key`, so
 * switching `agendaTarget` from one meeting to another re-renders the same
 * component/hook instance instead of remounting it. The poll budget
 * (pollCount.current, stalled) in useMeetingAgenda then belongs to the
 * component instance rather than to the meeting being viewed — driving
 * meeting A to `stalled` and switching straight to a fresh GENERATING
 * meeting B carries A's stalled state over, reporting `stalled: true` on B's
 * very first fetch.
 *
 * Fixed by keying <AgendaSheet> on `${linkedMeetingId}:${occurrenceStart}` in
 * MeetingDigestTab so a target switch remounts it and the poll budget starts
 * fresh for the new occurrence.
 */

import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAgenda, generateAgenda, saveAgenda } = vi.hoisted(() => ({
	getAgenda: vi.fn(),
	generateAgenda: vi.fn(),
	saveAgenda: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: { getAgenda, generateAgenda, saveAgenda },
		},
	},
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

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

// Presentational stand-in for the real Upcoming section (which owns its own
// data fetching via useUpcomingMeetings). Two buttons hand two distinct
// meeting identities to onGenerateAgenda, exactly like clicking "Generate
// agenda" on two different rows would.
vi.mock("../UpcomingMeetingsSection", () => ({
	UpcomingMeetingsSection: ({
		onGenerateAgenda,
	}: {
		onGenerateAgenda: (meeting: {
			joinUrl: string;
			subject: string;
			startTime: string;
			organizer: string;
			linkedMeetingId: string;
		}) => void;
	}) => (
		<div>
			<button
				type="button"
				onClick={() =>
					onGenerateAgenda({
						joinUrl: "a-url",
						subject: "Meeting A",
						startTime: "2026-07-25T09:00:00.000Z",
						organizer: "Ann",
						linkedMeetingId: "lm_A",
					})
				}
			>
				Show A
			</button>
			<button
				type="button"
				onClick={() =>
					onGenerateAgenda({
						joinUrl: "b-url",
						subject: "Meeting B",
						startTime: "2026-07-26T09:00:00.000Z",
						organizer: "Bob",
						linkedMeetingId: "lm_B",
					})
				}
			>
				Show B
			</button>
		</div>
	),
}));

import { MAX_AGENDA_POLLS } from "../../hooks/use-meeting-agenda";
import { MeetingDigestTab } from "../MeetingDigestTab";

function generatingAgenda(id: string, occurrenceStart: string) {
	return {
		id,
		status: "GENERATING" as const,
		content: null,
		contextStats: null,
		occurrenceStart,
		generatedAt: null,
		generationError: null,
		editedAt: null,
		editedById: null,
		version: 1,
	};
}

function renderTab() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<FeatureFlagProvider
				value={{ PERSONAL_MEETINGS: false, MEETING_AGENDA: true }}
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

describe("MeetingDigestTab — poll budget is scoped per occurrence, not per component instance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });
		getAgenda.mockImplementation(
			async (input: { linkedMeetingId: string }) => ({
				agenda:
					input.linkedMeetingId === "lm_A"
						? generatingAgenda("ag_a", "2026-07-25T09:00:00.000Z")
						: generatingAgenda("ag_b", "2026-07-26T09:00:00.000Z"),
			}),
		);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not carry meeting A's stalled poll budget over to a freshly-opened meeting B", async () => {
		renderTab();

		fireEvent.click(screen.getByRole("button", { name: "Show A" }));

		await waitFor(() =>
			expect(
				getAgenda.mock.calls.some(
					(call) => call[0]?.linkedMeetingId === "lm_A",
				),
			).toBe(true),
		);

		// Drive meeting A all the way through its poll budget to stalled.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000 * (MAX_AGENDA_POLLS + 5));
		});
		await waitFor(() =>
			expect(
				screen.getByText(/taking longer than expected/i),
			).toBeInTheDocument(),
		);

		// Switch straight to a fresh meeting B — no unmount, no closing the
		// sheet in between.
		fireEvent.click(screen.getByRole("button", { name: "Show B" }));

		await waitFor(() =>
			expect(
				getAgenda.mock.calls.some(
					(call) => call[0]?.linkedMeetingId === "lm_B",
				),
			).toBe(true),
		);

		// B has just started generating — it must not inherit A's stalled
		// state on its very first fetch.
		expect(
			screen.queryByText(/taking longer than expected/i),
		).not.toBeInTheDocument();
		expect(screen.getByText(/drafting the agenda/i)).toBeInTheDocument();
	});
});
