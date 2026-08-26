import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
	AwaitingMeeting,
	DigestMeeting,
	PersonalMeeting,
} from "../../lib/types";
import { CalendarCanvas } from "../CalendarCanvas";

const meeting: DigestMeeting = {
	linkedMeetingId: "lm1",
	transcriptId: "t1",
	subject: "Sprint Review",
	meetingDate: new Date("2026-06-10T10:00:00Z"),
	hasTranscript: true,
	analysisStatus: "SCANNED",
	createdTaskCount: 2,
	participantCount: 3,
	includedInDigest: true,
};

describe("CalendarCanvas", () => {
	it("renders a meeting badge and fires onSelect with its transcriptId", () => {
		const onSelect = vi.fn();
		render(
			<CalendarCanvas
				monthDate={new Date("2026-06-15")}
				meetings={[meeting]}
				onSelect={onSelect}
			/>,
		);
		const badge = screen.getByText("Sprint Review");
		fireEvent.click(badge);
		expect(onSelect).toHaveBeenCalledWith("t1");
	});
});

function meetingOn(transcriptId: string, subject: string): DigestMeeting {
	return {
		...meeting,
		transcriptId,
		subject,
	};
}

describe("CalendarCanvas — +N more expansion", () => {
	const fourSameDay = [
		meetingOn("t1", "Meeting A"),
		meetingOn("t2", "Meeting B"),
		meetingOn("t3", "Meeting C"),
		meetingOn("t4", "Meeting D"),
	];

	it("hides overflow meetings behind a clickable +N more button", () => {
		render(
			<CalendarCanvas
				monthDate={new Date("2026-06-15")}
				meetings={fourSameDay}
				onSelect={vi.fn()}
			/>,
		);
		expect(screen.queryByText("Meeting D")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /\+1 more/i }));

		expect(screen.getByText("Meeting D")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /show less/i }),
		).toBeInTheDocument();
	});

	it("collapses back on Show less", () => {
		render(
			<CalendarCanvas
				monthDate={new Date("2026-06-15")}
				meetings={fourSameDay}
				onSelect={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /\+1 more/i }));
		fireEvent.click(screen.getByRole("button", { name: /show less/i }));
		expect(screen.queryByText("Meeting D")).not.toBeInTheDocument();
	});
});

describe("CalendarCanvas — awaiting-transcript badges", () => {
	const awaiting: AwaitingMeeting = {
		linkedMeetingId: "lm9",
		subject: "Fabric DSU",
		occurrenceStart: new Date("2026-06-10T09:00:00Z"),
	};

	it("renders an awaiting badge on its occurrence day", () => {
		render(
			<CalendarCanvas
				monthDate={new Date("2026-06-15")}
				meetings={[]}
				onSelect={vi.fn()}
				awaitingMeetings={[awaiting]}
			/>,
		);
		expect(screen.getByText("Fabric DSU")).toBeInTheDocument();
		expect(
			screen.getByLabelText("Awaiting transcript"),
		).toBeInTheDocument();
	});

	it("does not make the awaiting badge selectable", () => {
		const onSelect = vi.fn();
		render(
			<CalendarCanvas
				monthDate={new Date("2026-06-15")}
				meetings={[]}
				onSelect={onSelect}
				awaitingMeetings={[awaiting]}
			/>,
		);
		fireEvent.click(screen.getByText("Fabric DSU"));
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("keeps the awaiting row visible when personal meetings compete for the budget", () => {
		// DEF-1, found in staging QA of #2051: the badge budget filled
		// project -> personal -> awaiting, so two of the viewer's own calendar
		// entries pushed the awaiting TEAM row behind "+N more". An awaiting row
		// is team content and must outrank a personal one — the whole premise of
		// the ticket is that people read the calendar, not the advisory.
		const personal: PersonalMeeting = {
			id: "evt1",
			subject: "Private 1:1",
			startTime: "2026-06-10T10:00:00Z",
			organizer: "Sam Rivers",
			joinUrl: "https://teams.microsoft.com/l/meetup-join/BBB",
			linkedWithoutTranscript: false,
		};
		render(
			<CalendarCanvas
				monthDate={new Date("2026-06-15")}
				meetings={[
					meetingOn("t1", "Project A"),
					meetingOn("t2", "Project B"),
				]}
				onSelect={vi.fn()}
				personalMeetings={[personal]}
				awaitingMeetings={[awaiting]}
			/>,
		);
		// Budget is 3: two project rows, then the awaiting team row. The personal
		// meeting is the one that gets deferred to "+1 more".
		expect(screen.getByText("Fabric DSU")).toBeInTheDocument();
		expect(screen.queryByText("Private 1:1")).not.toBeInTheDocument();
		expect(screen.getByText("+1 more")).toBeInTheDocument();
	});

	it("counts awaiting rows toward the +N more budget", () => {
		const many = [1, 2, 3, 4].map((n) => ({
			...awaiting,
			linkedMeetingId: `lm${n}`,
			subject: `Awaiting ${n}`,
		}));
		render(
			<CalendarCanvas
				monthDate={new Date("2026-06-15")}
				meetings={[]}
				onSelect={vi.fn()}
				awaitingMeetings={many}
			/>,
		);
		expect(screen.getByText("+1 more")).toBeInTheDocument();
	});
});
