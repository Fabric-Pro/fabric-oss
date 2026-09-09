import { describe, expect, it } from "vitest";
import { formatMeetingDateLabel } from "../src/publishing-why-suggested";

/**
 * The short date beside a cited meeting on the "Based on …" line.
 *
 * The line exists because provenance dedupes by transcript id, which is right —
 * a recurring series produces one transcript per occurrence — while the label it
 * renders is the shared `meetingSubject`. So the same name legitimately appears
 * twice and the date is the only thing separating the two.
 */
describe("formatMeetingDateLabel", () => {
	it("omits the year for a meeting in the current year", () => {
		expect(
			formatMeetingDateLabel(new Date("2026-09-09T12:00:00Z"), 2026),
		).toBe("Sept 9");
	});

	it("includes the year once the meeting is not in the current year", () => {
		expect(
			formatMeetingDateLabel(new Date("2025-09-09T12:00:00Z"), 2026),
		).toBe("Sept 9, 2025");
	});

	it("includes the year for a FUTURE year too, not just a past one", () => {
		// A scheduled-ahead transcript is unusual but a clock skew or an
		// imported calendar makes it reachable, and "Jan 4" with no year would
		// be read as this year's.
		expect(
			formatMeetingDateLabel(new Date("2027-01-04T00:00:00Z"), 2026),
		).toBe("Jan 4, 2027");
	});

	it("returns undefined for a transcript with no date", () => {
		// `ProjectMeetingTranscript.meetingDate` is nullable. The caller renders
		// a bare `"…" meeting` for this, never an empty paren.
		expect(formatMeetingDateLabel(null, 2026)).toBeUndefined();
		expect(formatMeetingDateLabel(undefined, 2026)).toBeUndefined();
	});

	it("returns undefined for an unparseable date rather than 'NaN'", () => {
		expect(
			formatMeetingDateLabel(new Date("not a date"), 2026),
		).toBeUndefined();
	});

	it("reads the date in UTC, so the label does not move with the server's timezone", () => {
		// 23:30 UTC on the 9th is already the 10th east of UTC and still the
		// 9th west of it. Pinning UTC is what stops two servers rendering the
		// same transcript differently.
		expect(
			formatMeetingDateLabel(new Date("2026-09-09T23:30:00Z"), 2026),
		).toBe("Sept 9");
		expect(
			formatMeetingDateLabel(new Date("2026-09-10T00:30:00Z"), 2026),
		).toBe("Sept 10");
	});

	it("abbreviates September as 'Sept', which Intl's en-US short month does not", () => {
		// Guards the hand-written table against being 'simplified' back into
		// `Intl.DateTimeFormat(..., { month: "short" })`, which renders "Sep"
		// under en-US and "Sept" only under en-GB — an ICU-data detail that can
		// change under a Node upgrade with nothing to catch it.
		expect(
			new Intl.DateTimeFormat("en-US", {
				month: "short",
				timeZone: "UTC",
			}).format(new Date("2026-09-09T12:00:00Z")),
		).not.toBe("Sept");
		expect(
			formatMeetingDateLabel(new Date("2026-09-09T12:00:00Z"), 2026),
		).toBe("Sept 9");
	});

	it("covers every month boundary", () => {
		const labels = Array.from({ length: 12 }, (_, month) =>
			formatMeetingDateLabel(new Date(Date.UTC(2026, month, 1)), 2026),
		);
		expect(labels).toEqual([
			"Jan 1",
			"Feb 1",
			"Mar 1",
			"Apr 1",
			"May 1",
			"Jun 1",
			"Jul 1",
			"Aug 1",
			"Sept 1",
			"Oct 1",
			"Nov 1",
			"Dec 1",
		]);
	});
});
