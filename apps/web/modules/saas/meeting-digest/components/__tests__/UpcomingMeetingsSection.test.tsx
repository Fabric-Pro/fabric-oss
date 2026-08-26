import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { useUpcomingMeetings } = vi.hoisted(() => ({
	useUpcomingMeetings: vi.fn(),
}));

vi.mock("../../hooks/use-upcoming-meetings", () => ({ useUpcomingMeetings }));

import {
	UpcomingMeetingsList,
	UpcomingMeetingsSection,
} from "../UpcomingMeetingsSection";

const linked = {
	joinUrl: "https://teams/x",
	subject: "Fabric DSU",
	startTime: "2026-07-25T09:00:00.000Z",
	organizer: "Avery Diaz",
	linkedMeetingId: "lm_1",
	agendaStatus: null,
};
const unlinked = {
	joinUrl: "https://teams/q",
	subject: "Sprint Review",
	startTime: "2026-07-26T13:00:00.000Z",
	organizer: "Dave Miller",
	linkedMeetingId: null,
	agendaStatus: null,
};

const NOW = new Date("2026-07-25T08:00:00.000Z");

describe("UpcomingMeetingsList", () => {
	it("offers agenda generation for a linked meeting when the user can edit", () => {
		render(
			<UpcomingMeetingsList
				meetings={[linked]}
				canEdit
				now={NOW}
				onLinkMeeting={vi.fn()}
				onGenerateAgenda={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("button", { name: /generate agenda/i }),
		).toBeInTheDocument();
	});

	it("prompts to link an unlinked meeting instead (FR6)", () => {
		render(
			<UpcomingMeetingsList
				meetings={[unlinked]}
				canEdit
				now={NOW}
				onLinkMeeting={vi.fn()}
				onGenerateAgenda={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("button", { name: /link to generate agenda/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /^generate agenda$/i }),
		).not.toBeInTheDocument();
	});

	it("hides both actions from non-admins (D4)", () => {
		render(
			<UpcomingMeetingsList
				meetings={[linked, unlinked]}
				canEdit={false}
				now={NOW}
				onLinkMeeting={vi.fn()}
				onGenerateAgenda={vi.fn()}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: /agenda/i }),
		).not.toBeInTheDocument();
		expect(screen.getByText("Fabric DSU")).toBeInTheDocument();
	});

	it("renders an explicit empty state rather than nothing", () => {
		render(
			<UpcomingMeetingsList
				meetings={[]}
				canEdit
				now={NOW}
				onLinkMeeting={vi.fn()}
				onGenerateAgenda={vi.fn()}
			/>,
		);

		expect(screen.getByText(/no meetings scheduled/i)).toBeInTheDocument();
	});

	it("groups meetings under day headings (FR1)", () => {
		render(
			<UpcomingMeetingsList
				meetings={[linked, unlinked]}
				canEdit
				now={NOW}
				onLinkMeeting={vi.fn()}
				onGenerateAgenda={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "Today" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Tomorrow" }),
		).toBeInTheDocument();
	});

	it("shows the agenda status of a linked meeting (FR3)", () => {
		render(
			<UpcomingMeetingsList
				meetings={[{ ...linked, agendaStatus: "READY" }]}
				canEdit
				now={NOW}
				onLinkMeeting={vi.fn()}
				onGenerateAgenda={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("img", { name: "Agenda ready" }),
		).toBeInTheDocument();
	});

	it("marks an unlinked meeting as not tracked rather than as missing an agenda (D4)", () => {
		render(
			<UpcomingMeetingsList
				meetings={[unlinked]}
				canEdit
				now={NOW}
				onLinkMeeting={vi.fn()}
				onGenerateAgenda={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("img", {
				name: "Not tracked — link this meeting to generate an agenda",
			}),
		).toBeInTheDocument();
	});

	it("still shows indicators to a non-admin, who just cannot act on them", () => {
		render(
			<UpcomingMeetingsList
				meetings={[{ ...linked, agendaStatus: "READY" }]}
				canEdit={false}
				now={NOW}
				onLinkMeeting={vi.fn()}
				onGenerateAgenda={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("img", { name: "Agenda ready" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /agenda/i }),
		).not.toBeInTheDocument();
	});

	// Only today+tomorrow are fetched on mount. Saying "nothing scheduled" full
	// stop is false when twelve further days have not been looked at — on a
	// Friday evening it tells a user with a full week ahead that they are free.
	it("scopes the empty copy to the window actually loaded", () => {
		render(
			<UpcomingMeetingsList
				meetings={[]}
				canEdit
				now={NOW}
				hasLoadedLater={false}
				onLinkMeeting={vi.fn()}
				onGenerateAgenda={vi.fn()}
			/>,
		);

		expect(screen.getByText(/next two days/i)).toBeInTheDocument();
	});

	it("widens the empty copy once the whole window has loaded", () => {
		render(
			<UpcomingMeetingsList
				meetings={[]}
				canEdit
				now={NOW}
				hasLoadedLater
				onLinkMeeting={vi.fn()}
				onGenerateAgenda={vi.fn()}
			/>,
		);

		expect(screen.getByText(/next two weeks/i)).toBeInTheDocument();
	});
});

describe("UpcomingMeetingsSection — data wrapper (#1901a coverage gap)", () => {
	function renderSection() {
		return render(
			<UpcomingMeetingsSection
				projectId="p1"
				organizationId={null}
				canEdit
				now={NOW}
				onLinkMeeting={vi.fn()}
				onGenerateAgenda={vi.fn()}
			/>,
		);
	}

	it("shows the loading copy and no list while loading", () => {
		useUpcomingMeetings.mockReturnValue({
			meetings: [],
			isLoading: true,
			isError: false,
			notConnected: false,
			loadLater: vi.fn(),
			isLoadingLater: false,
			isLaterError: false,
			hasLoadedLater: false,
		});
		renderSection();

		expect(
			screen.getByText(/loading upcoming meetings/i),
		).toBeInTheDocument();
		expect(screen.queryByRole("list")).not.toBeInTheDocument();
		expect(
			screen.queryByText(/no meetings scheduled/i),
		).not.toBeInTheDocument();
	});

	it("shows the Connect Microsoft copy, not the generic error, when not connected", () => {
		// Matches the real hook: not-connected is a SUCCESSFUL response
		// (`{ meetings: [], error: "not-connected" }`), so isError is false here,
		// not true — a query-level error and "not connected" are distinct states.
		useUpcomingMeetings.mockReturnValue({
			meetings: [],
			isLoading: false,
			isError: false,
			notConnected: true,
			loadLater: vi.fn(),
			isLoadingLater: false,
			isLaterError: false,
			hasLoadedLater: false,
		});
		renderSection();

		expect(
			screen.getByText(/to see your upcoming meetings/i),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/couldn't load upcoming meetings/i),
		).not.toBeInTheDocument();
	});

	// #1901 follow-up: the not-connected CTA must be an actionable link to the
	// per-user MICROSOFT_GRAPH connect page (the delegated Teams/calendar
	// provider), NOT dead text and NOT the org "Microsoft 365" knowledge card
	// that can't grant calendar access. (usePathname is mocked to "/" in
	// vitest.setup, so the derived href drops to the app-root form.)
	it("links Connect Microsoft to the MICROSOFT_GRAPH actions connect page", () => {
		useUpcomingMeetings.mockReturnValue({
			meetings: [],
			isLoading: false,
			isError: false,
			notConnected: true,
			loadLater: vi.fn(),
			isLoadingLater: false,
			isLaterError: false,
			hasLoadedLater: false,
		});
		renderSection();

		const link = screen.getByRole("link", { name: /connect microsoft/i });
		expect(link).toHaveAttribute(
			"href",
			"/settings/integrations/actions/MICROSOFT_GRAPH",
		);
	});

	// #1901 final review, FIX 6: not-connected is a successful response, so the
	// old `!isLoading && !isError` gate let the list render too — the user saw
	// BOTH "Connect Microsoft…" and "No meetings scheduled in the next two
	// weeks" at once, which is directly contradictory.
	it("does not also render the empty-list copy when not connected", () => {
		useUpcomingMeetings.mockReturnValue({
			meetings: [],
			isLoading: false,
			isError: false,
			notConnected: true,
			loadLater: vi.fn(),
			isLoadingLater: false,
			isLaterError: false,
			hasLoadedLater: false,
		});
		renderSection();

		expect(
			screen.queryByText(/no meetings scheduled/i),
		).not.toBeInTheDocument();
	});

	it("shows the generic error copy when the fetch failed for a reason other than the connection", () => {
		useUpcomingMeetings.mockReturnValue({
			meetings: [],
			isLoading: false,
			isError: true,
			notConnected: false,
			loadLater: vi.fn(),
			isLoadingLater: false,
			isLaterError: false,
			hasLoadedLater: false,
		});
		renderSection();

		expect(
			screen.getByText(/couldn't load upcoming meetings/i),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/connect microsoft/i),
		).not.toBeInTheDocument();
	});
	it("asks for the later days when the trigger is activated (FR2)", () => {
		const loadLater = vi.fn();
		useUpcomingMeetings.mockReturnValue({
			meetings: [],
			isLoading: false,
			isError: false,
			notConnected: false,
			loadLater,
			isLoadingLater: false,
			isLaterError: false,
			hasLoadedLater: false,
		});
		renderSection();

		fireEvent.click(screen.getByRole("button", { name: /more days/i }));

		expect(loadLater).toHaveBeenCalledTimes(1);
	});

	it("drops the trigger once the later days have loaded", () => {
		useUpcomingMeetings.mockReturnValue({
			meetings: [],
			isLoading: false,
			isError: false,
			notConnected: false,
			loadLater: vi.fn(),
			isLoadingLater: false,
			isLaterError: false,
			hasLoadedLater: true,
		});
		renderSection();

		expect(
			screen.queryByRole("button", { name: /more days/i }),
		).not.toBeInTheDocument();
	});

	it("offers a retry when the later days fail, without discarding the days already shown", () => {
		useUpcomingMeetings.mockReturnValue({
			meetings: [linked],
			isLoading: false,
			isError: false,
			notConnected: false,
			loadLater: vi.fn(),
			isLoadingLater: false,
			isLaterError: true,
			hasLoadedLater: false,
		});
		renderSection();

		expect(screen.getByText("Fabric DSU")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /retry/i }),
		).toBeInTheDocument();
	});

	it("does not offer to load more days when Microsoft is not connected", () => {
		useUpcomingMeetings.mockReturnValue({
			meetings: [],
			isLoading: false,
			isError: false,
			notConnected: true,
			loadLater: vi.fn(),
			isLoadingLater: false,
			isLaterError: false,
			hasLoadedLater: false,
		});
		renderSection();

		expect(
			screen.queryByRole("button", { name: /more days/i }),
		).not.toBeInTheDocument();
	});
});
