import { describe, expect, it } from "vitest";
import { inferMeetingDate } from "../transcript-meeting-date";

function day(date: Date | null): string | null {
	return date ? date.toISOString().slice(0, 10) : null;
}

describe("inferMeetingDate — from the filename", () => {
	it.each([
		["Standup 2026-10-21.vtt", "2026-10-21"],
		["2026_03_04 planning.docx", "2026-03-04"],
		["planning.2026.3.4.txt", "2026-03-04"],
		["Recording-20261021-1400.vtt", "2026-10-21"],
		["Weekly sync October 21, 2026.docx", "2026-10-21"],
		["Weekly sync Oct 21st 2026.txt", "2026-10-21"],
		["Retro 21 October 2026.vtt", "2026-10-21"],
		["Retro 3 Sept. 2026.vtt", "2026-09-03"],
		["review 25.10.2026.txt", "2026-10-25"],
		["review 10/25/2026.txt", "2026-10-25"],
	])("reads %s as %s", (filename, expected) => {
		expect(day(inferMeetingDate({ filename, text: "" }))).toBe(expected);
	});

	it("prefers the filename to the text", () => {
		expect(
			day(
				inferMeetingDate({
					filename: "Sync 2026-10-21.txt",
					text: "Sync\nNovember 2, 2026\n",
				}),
			),
		).toBe("2026-10-21");
	});
});

describe("inferMeetingDate — from the top of the text", () => {
	it("reads the date a Teams export prints under the title", () => {
		const text =
			"Q4 planning\nOctober 21, 2026, 3:00PM\n42m 10s\n\nAlex Example   0:03\nLet's start.";
		expect(
			day(inferMeetingDate({ filename: "Q4 planning.docx", text })),
		).toBe("2026-10-21");
	});

	it("ignores a date said later in the meeting", () => {
		const text = `${"Alex Example: we went through the backlog.\n".repeat(30)}Sam Example: the release is on 2026-12-01.`;
		expect(inferMeetingDate({ filename: "sync.txt", text })).toBeNull();
	});
});

describe("inferMeetingDate — unknown rather than wrong", () => {
	it.each([
		["standup.vtt"],
		// Either the 3rd of April or the 4th of March.
		["review 03/04/2026.txt"],
		// Not a date.
		["build 2026-13-40.txt"],
		["2026-02-30 retro.txt"],
		// A long number, not a date.
		["ticket 12026110512.txt"],
	])("leaves %s without a date", (filename) => {
		expect(inferMeetingDate({ filename, text: "" })).toBeNull();
	});

	it("never falls back to today", () => {
		expect(
			inferMeetingDate({ filename: "notes.txt", text: "No date here." }),
		).toBeNull();
	});
});

describe("inferMeetingDate — the calendar day", () => {
	it("keeps the same day from UTC-11 to UTC+11", () => {
		const date = inferMeetingDate({ filename: "2026-10-21.txt", text: "" });
		expect(date?.getUTCHours()).toBe(12);
	});
});
