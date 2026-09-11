/**
 * Fizzy #2473 — the date semantics the meeting lookup exists to get right.
 *
 * The bug this tool replaces was a date question answered by semantic search,
 * which reported a present transcript as absent. These tests pin the places
 * where a date-aware lookup could reintroduce the same symptom by being subtly
 * wrong about a range, and the places where its prose could re-teach the model
 * to overstate what it knows.
 */

import { describe, expect, it } from "vitest";
import {
	describeTranscriptFilters,
	formatTranscriptList,
	parseTranscriptDate,
	readTranscriptFilters,
} from "../src/activities/shared/meeting-transcript-listing";

describe("readTranscriptFilters", () => {
	it("covers the WHOLE day when from and to are the same bare date", () => {
		// The original report was about a meeting at 16:01. Reading a bare `to`
		// as midnight would exclude every afternoon meeting and reproduce the
		// exact bug — "no transcripts on the 10th" while one sits there.
		const filters = readTranscriptFilters({
			from: "2026-09-10",
			to: "2026-09-10",
		});

		expect(filters.from?.toISOString()).toBe("2026-09-10T00:00:00.000Z");
		expect(filters.to?.toISOString()).toBe("2026-09-10T23:59:59.999Z");

		const afternoonMeeting = new Date("2026-09-10T16:01:34.000Z");
		expect(afternoonMeeting >= (filters.from as Date)).toBe(true);
		expect(afternoonMeeting <= (filters.to as Date)).toBe(true);
	});

	it("respects an explicit timestamp instead of widening it", () => {
		const filters = readTranscriptFilters({
			from: "2026-09-10T12:00:00.000Z",
			to: "2026-09-10T13:00:00.000Z",
		});

		expect(filters.from?.toISOString()).toBe("2026-09-10T12:00:00.000Z");
		expect(filters.to?.toISOString()).toBe("2026-09-10T13:00:00.000Z");
	});

	it("ignores unparseable or empty input rather than inventing a range", () => {
		const filters = readTranscriptFilters({
			from: "yesterday",
			to: "   ",
			subject: "  ",
			limit: Number.NaN,
		});

		expect(filters.from).toBeUndefined();
		expect(filters.to).toBeUndefined();
		expect(filters.subject).toBeUndefined();
		expect(filters.limit).toBeUndefined();
	});

	it("trims a subject and truncates a fractional limit", () => {
		const filters = readTranscriptFilters({
			subject: "  DSU ",
			limit: 7.9,
		});

		expect(filters.subject).toBe("DSU");
		expect(filters.limit).toBe(7);
	});

	it("returns no filters at all when given nothing", () => {
		expect(readTranscriptFilters(undefined)).toEqual({});
	});
});

describe("parseTranscriptDate", () => {
	it("anchors a bare date to the start or end of that day", () => {
		expect(parseTranscriptDate("2026-09-10", false)?.toISOString()).toBe(
			"2026-09-10T00:00:00.000Z",
		);
		expect(parseTranscriptDate("2026-09-10", true)?.toISOString()).toBe(
			"2026-09-10T23:59:59.999Z",
		);
	});

	it("rejects a non-date string", () => {
		expect(parseTranscriptDate("not-a-date", false)).toBeUndefined();
	});
});

describe("describeTranscriptFilters", () => {
	it("collapses an identical from/to into a single day", () => {
		expect(
			describeTranscriptFilters({
				from: new Date("2026-09-10T00:00:00.000Z"),
				to: new Date("2026-09-10T23:59:59.999Z"),
			}),
		).toBe(" on 2026-09-10");
	});

	it("describes a genuine range and a subject together", () => {
		expect(
			describeTranscriptFilters({
				from: new Date("2026-09-01T00:00:00.000Z"),
				to: new Date("2026-09-10T23:59:59.999Z"),
				subject: "DSU",
			}),
		).toBe(' between 2026-09-01 and 2026-09-10, matching "DSU"');
	});

	it("is empty when unfiltered, so callers do not claim a scope they lack", () => {
		expect(describeTranscriptFilters({})).toBe("");
	});
});

describe("formatTranscriptList", () => {
	const transcript = {
		meetingSubject: "Fabric DSU",
		meetingDate: new Date("2026-09-10T16:01:34.000Z"),
		speakerNames: ["Ada Lovelace", "Grace Hopper"],
		summary: "Discussed availability and the release cut.",
		wasSummarized: false,
	};

	it("leads with the meeting's own date, not an ingest timestamp", () => {
		const output = formatTranscriptList([transcript], 1, {});

		expect(output).toContain("1 meeting transcript:");
		expect(output).toContain("1. 2026-09-10 — Fabric DSU");
		expect(output).toContain("Speakers: Ada Lovelace, Grace Hopper");
	});

	it("discloses truncation so the model cannot read a page as the whole set", () => {
		const output = formatTranscriptList([transcript], 157, {});

		expect(output).toContain("157 meeting transcripts");
		expect(output).toContain("showing the 1 most recent");
	});

	it("flags a stored AI summary rather than passing it off as verbatim", () => {
		const output = formatTranscriptList(
			[{ ...transcript, wasSummarized: true }],
			1,
			{},
		);

		expect(output).toContain("AI summary, not the verbatim transcript");
	});

	it("labels a transcript with no occurrence date instead of guessing one", () => {
		const output = formatTranscriptList(
			[{ ...transcript, meetingDate: null, meetingSubject: null }],
			1,
			{},
		);

		expect(output).toContain("date unknown — Untitled meeting");
	});
});
