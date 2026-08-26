import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PersonalMeeting } from "../../lib/types";
import { AgendaView } from "../AgendaView";
import { CalendarCanvas } from "../CalendarCanvas";

const PERSONAL: PersonalMeeting[] = [
	{
		id: "evt1",
		subject: "1:1 with Sam",
		startTime: "2026-07-14T09:00:00Z",
		organizer: "Sam Rivers",
		joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
		linkedWithoutTranscript: false,
	},
];

/**
 * A project meeting surfaced here only because no transcript has synced, so the
 * team view rendered no row for it (DEF-0). It is shared, not private.
 */
const UNSYNCED_TEAM: PersonalMeeting[] = [
	{
		id: "evt2",
		subject: "Fabric DSU",
		startTime: "2026-07-14T10:00:00Z",
		organizer: "Fabric Team",
		joinUrl: "https://teams.microsoft.com/l/meetup-join/BBB",
		linkedWithoutTranscript: true,
	},
];

describe("AgendaView personal rows", () => {
	const baseProps = {
		monthDate: new Date("2026-07-14T12:00:00Z"),
		meetings: [],
		projectId: "p1",
		organizationId: null,
		onSelect: vi.fn(),
		onToggled: vi.fn(),
		onGenerate: vi.fn(),
		generatingRefs: new Set<string>(),
		summaryErrors: {},
	};

	it("renders nothing extra when no personal meetings are passed", () => {
		render(<AgendaView {...baseProps} />);
		expect(screen.queryByText("1:1 with Sam")).toBeNull();
	});

	it("labels a personal meeting with a Personal badge (FR5)", () => {
		render(<AgendaView {...baseProps} personalMeetings={PERSONAL} />);

		expect(screen.getByText("1:1 with Sam")).toBeTruthy();
		expect(screen.getByText("Personal")).toBeTruthy();
	});

	it("distinguishes personal rows by more than colour (FR5, a11y)", () => {
		render(<AgendaView {...baseProps} personalMeetings={PERSONAL} />);

		// An icon carrying an accessible name, in addition to the text badge:
		// colour alone is not an acceptable distinction.
		expect(screen.getByLabelText(/personal meeting/i)).toBeTruthy();
	});

	// DEF-0. These rows exist so linked-but-unsynced meetings aren't invisible,
	// but they are TEAM meetings. Calling them "Personal" next to a banner that
	// says personal meetings are private to you would tell the user their shared
	// project meeting is private — worse than the bug being fixed.
	it("does not label an unsynced project meeting as Personal", () => {
		render(<AgendaView {...baseProps} personalMeetings={UNSYNCED_TEAM} />);

		expect(screen.getByText("Fabric DSU")).toBeTruthy();
		expect(screen.queryByText("Personal")).toBeNull();
		expect(screen.getByText(/not synced yet/i)).toBeTruthy();
	});

	it("does not give an unsynced project meeting the personal icon label", () => {
		render(<AgendaView {...baseProps} personalMeetings={UNSYNCED_TEAM} />);

		expect(screen.queryByLabelText(/personal meeting/i)).toBeNull();
	});
});

describe("CalendarCanvas personal badges", () => {
	// The agenda row has carried a text badge since #1899, but the calendar
	// cell dropped it — leaving a 12px muted icon and a title tooltip as the
	// only difference between a private meeting and a shared one. Neither
	// survives a screenshot, which is how a shared stand-up came to be read
	// as somebody's personal meeting.
	it("marks an unsynced project meeting in the calendar cell with visible text", () => {
		render(
			<CalendarCanvas
				monthDate={new Date("2026-07-14")}
				meetings={[]}
				onSelect={vi.fn()}
				personalMeetings={UNSYNCED_TEAM}
			/>,
		);

		expect(screen.getByText("Not synced yet")).toBeTruthy();
	});

	// The personal state stays icon-only on purpose: it is the lane's default
	// reading, and a chip on every cell would crowd the 3-badge-per-day budget.
	it("leaves a genuinely personal meeting without the shared marker", () => {
		render(
			<CalendarCanvas
				monthDate={new Date("2026-07-14")}
				meetings={[]}
				onSelect={vi.fn()}
				personalMeetings={PERSONAL}
			/>,
		);

		expect(screen.queryByText("Not synced yet")).toBeNull();
		expect(screen.getByLabelText("Personal meeting")).toBeTruthy();
	});

	it("keeps the meeting subject readable next to the marker", () => {
		render(
			<CalendarCanvas
				monthDate={new Date("2026-07-14")}
				meetings={[]}
				onSelect={vi.fn()}
				personalMeetings={UNSYNCED_TEAM}
			/>,
		);

		expect(screen.getByText(UNSYNCED_TEAM[0].subject)).toBeTruthy();
	});

	/**
	 * Presence was never the problem — width was. Sharing one line, the marker
	 * is `shrink-0`, so the subject absorbed every pixel it took: measured on
	 * staging at 78px (~13 characters) in a 1600px window and 32px (~5
	 * characters) at 1280px, against ~154px for a row with no marker. Two
	 * unsynced meetings in one cell both rendered as three letters and an
	 * ellipsis. Giving the marker its own line costs height, which the cell can
	 * spare, instead of width, which it cannot.
	 */
	it("gives the subject a line of its own, with the marker beneath it", () => {
		render(
			<CalendarCanvas
				monthDate={new Date("2026-07-14")}
				meetings={[]}
				onSelect={vi.fn()}
				personalMeetings={UNSYNCED_TEAM}
			/>,
		);

		const subject = screen.getByText(UNSYNCED_TEAM[0].subject);
		const marker = screen.getByText("Not synced yet");

		// Nothing shares the subject's line, and the marker is the element
		// directly after that line rather than inside it.
		expect(subject.parentElement?.contains(marker)).toBe(false);
		expect(marker.previousElementSibling?.contains(subject)).toBe(true);
	});
});
