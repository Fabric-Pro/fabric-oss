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

	it("counts the awaiting row in the shared time-ordered budget", () => {
		// Awaiting rows share the time-ordered 3-badge budget: awaiting at 09:00
		// and project meetings at 10:00 fill the budget, so the later personal
		// meeting at 10:00 is deferred to "+1 more".
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

describe("CalendarCanvas — chronological ordering within a day (#2465)", () => {
	it("renders meetings on the same day in chronological order (earlier first) when input is newest-first", () => {
		const morningMeeting: DigestMeeting = {
			...meeting,
			transcriptId: "t-morning",
			subject: "Morning DSU",
			meetingDate: new Date("2026-06-10T09:00:00Z"),
		};
		const afternoonMeeting: DigestMeeting = {
			...meeting,
			transcriptId: "t-afternoon",
			subject: "Afternoon Sync",
			meetingDate: new Date("2026-06-10T15:00:00Z"),
		};

		// Passed in newest-first order as returned by listDigest API (orderBy: { meetingDate: "desc" })
		render(
			<CalendarCanvas
				monthDate={new Date("2026-06-15")}
				meetings={[afternoonMeeting, morningMeeting]}
				onSelect={vi.fn()}
			/>,
		);

		const badges = screen.getAllByRole("button", { name: /dsu|sync/i });
		expect(badges.map((b) => b.textContent)).toEqual([
			"Morning DSU",
			"Afternoon Sync",
		]);
	});

	it("shows the earliest three meetings when collapsed on a day with four meetings", () => {
		const fourNewestFirst: DigestMeeting[] = [
			{
				...meeting,
				transcriptId: "t4",
				subject: "Meeting 16:00",
				meetingDate: new Date("2026-06-10T16:00:00Z"),
			},
			{
				...meeting,
				transcriptId: "t3",
				subject: "Meeting 14:00",
				meetingDate: new Date("2026-06-10T14:00:00Z"),
			},
			{
				...meeting,
				transcriptId: "t2",
				subject: "Meeting 11:00",
				meetingDate: new Date("2026-06-10T11:00:00Z"),
			},
			{
				...meeting,
				transcriptId: "t1",
				subject: "Meeting 09:00",
				meetingDate: new Date("2026-06-10T09:00:00Z"),
			},
		];

		render(
			<CalendarCanvas
				monthDate={new Date("2026-06-15")}
				meetings={fourNewestFirst}
				onSelect={vi.fn()}
			/>,
		);

		expect(screen.getByText("Meeting 09:00")).toBeInTheDocument();
		expect(screen.getByText("Meeting 11:00")).toBeInTheDocument();
		expect(screen.getByText("Meeting 14:00")).toBeInTheDocument();
		expect(screen.queryByText("Meeting 16:00")).not.toBeInTheDocument();
		expect(screen.getByText("+1 more")).toBeInTheDocument();
	});
});

describe("CalendarCanvas — one chronological cell across row types", () => {
	const personalAt = (
		id: string,
		subject: string,
		startTime: string,
	): PersonalMeeting => ({
		id,
		subject,
		startTime,
		organizer: "Alex Doe",
		joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
		linkedWithoutTranscript: false,
	});

	const teamAt = (
		transcriptId: string,
		subject: string,
		at: string,
	): DigestMeeting => ({
		...meetingOn(transcriptId, subject),
		meetingDate: new Date(at),
	});

	it("places an earlier personal meeting above later team meetings", () => {
		render(
			<CalendarCanvas
				monthDate={new Date("2026-06-15")}
				meetings={[
					teamAt("t-late", "Team 15:00", "2026-06-10T15:00:00Z"),
					teamAt("t-early", "Team 10:00", "2026-06-10T10:00:00Z"),
				]}
				onSelect={vi.fn()}
				personalMeetings={[
					personalAt("p1", "Personal 09:00", "2026-06-10T09:00:00Z"),
				]}
			/>,
		);

		const labels = screen
			.getAllByRole("button")
			.map((element) => element.textContent);
		expect(labels).toEqual(["Personal 09:00", "Team 10:00", "Team 15:00"]);
	});

	it("shows the day's earliest meetings and defers the rest, whatever kind they are", () => {
		render(
			<CalendarCanvas
				monthDate={new Date("2026-06-15")}
				meetings={[
					teamAt("t-late", "Team 15:00", "2026-06-10T15:00:00Z"),
					teamAt("t-early", "Team 10:00", "2026-06-10T10:00:00Z"),
				]}
				onSelect={vi.fn()}
				awaitingMeetings={[
					{
						linkedMeetingId: "lm-awaiting",
						subject: "Awaiting 09:00",
						occurrenceStart: "2026-06-10T09:00:00Z",
						joinUrl:
							"https://teams.microsoft.com/l/meetup-join/BBB",
					},
				]}
				personalMeetings={[
					personalAt("p1", "Personal 08:00", "2026-06-10T08:00:00Z"),
				]}
			/>,
		);

		// The three earliest win the cell whatever kind they are, so the 15:00
		// team meeting is the one deferred.
		expect(screen.queryByText("Team 15:00")).not.toBeInTheDocument();
		expect(screen.getByText("+1 more")).toBeInTheDocument();

		const cell = screen.getByText("Personal 08:00").closest("ul");
		const rendered = Array.from(cell?.querySelectorAll("li") ?? [])
			.map((item) => item.textContent)
			.filter((text) => text && !text.includes("more"));
		// The awaiting badge carries its own "Not synced yet" marker line, so
		// match its subject rather than the whole cell text.
		expect(rendered).toEqual([
			"Personal 08:00",
			expect.stringContaining("Awaiting 09:00"),
			"Team 10:00",
		]);
	});
});
