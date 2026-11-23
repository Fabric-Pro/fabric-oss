import { describe, expect, it } from "vitest";
import { liveSession, session } from "../../components/__tests__/fixtures";
import { formatCost, isSessionChanging } from "../parlume-format";

describe("isSessionChanging", () => {
	const now = new Date("2026-10-01T12:00:00Z").getTime();
	const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000);
	const ended = session({ notesStatus: "PENDING", endedAt: minutesAgo(10) });

	it("polls a live session", () => {
		expect(isSessionChanging(liveSession(), now)).toBe(true);
	});

	it("polls notes being written for half an hour after the meeting ends", () => {
		expect(isSessionChanging(ended, now)).toBe(true);
		expect(
			isSessionChanging({ ...ended, endedAt: minutesAgo(31) }, now),
		).toBe(false);
	});

	it("polls again for half an hour after the notes are asked for again", () => {
		expect(
			isSessionChanging(
				{
					...ended,
					endedAt: minutesAgo(600),
					notesRequestedAt: minutesAgo(5).toISOString(),
				},
				now,
			),
		).toBe(true);
		expect(
			isSessionChanging(
				{
					...ended,
					endedAt: minutesAgo(600),
					notesRequestedAt: minutesAgo(45).toISOString(),
				},
				now,
			),
		).toBe(false);
	});

	it("does not poll written or failed notes, or notes with no time to wait from", () => {
		expect(
			isSessionChanging({ ...ended, notesStatus: "COMPLETED" }, now),
		).toBe(false);
		expect(
			isSessionChanging({ ...ended, notesStatus: "FAILED" }, now),
		).toBe(false);
		expect(isSessionChanging({ ...ended, endedAt: null }, now)).toBe(false);
	});
});

describe("formatCost", () => {
	it("shows exactly zero as $0.00", () => {
		expect(formatCost(0)).toBe("$0.00");
	});

	it("never shows a negative amount", () => {
		expect(formatCost(-250)).toBe("$0.00");
	});

	it("floors anything above zero and below a cent at < $0.01", () => {
		expect(formatCost(1)).toBe("< $0.01");
		expect(formatCost(5_000)).toBe("< $0.01");
		expect(formatCost(9_999)).toBe("< $0.01");
	});

	it("shows a whole cent from one cent up", () => {
		expect(formatCost(10_000)).toBe("$0.01");
		expect(formatCost(12_300)).toBe("$0.01");
	});

	it("rounds to the nearest cent", () => {
		expect(formatCost(14_900)).toBe("$0.01");
		expect(formatCost(15_000)).toBe("$0.02");
		expect(formatCost(2_345_678)).toBe("$2.35");
		expect(formatCost(4_996_000)).toBe("$5.00");
	});

	it("separates thousands", () => {
		expect(formatCost(1_234_567_890)).toBe("$1,234.57");
	});
});
