import { describe, expect, it } from "vitest";
import {
	formatLiveTranscript,
	formatParlumeHistory,
	LIVE_TRANSCRIPT_WINDOW_MS,
	liveTranscriptStart,
	MAX_LIVE_TRANSCRIPT_CHARS,
	MAX_PARLUME_HISTORY_TURNS,
	PARLUME_PROJECT_RAG_CHUNKS,
} from "../parlume-voice-context";

describe("voice context budgets", () => {
	it("reads three minutes, 4,000 characters, three passages and four earlier answers", () => {
		expect(LIVE_TRANSCRIPT_WINDOW_MS).toBe(3 * 60 * 1000);
		expect(MAX_LIVE_TRANSCRIPT_CHARS).toBe(4_000);
		expect(PARLUME_PROJECT_RAG_CHUNKS).toBe(3);
		expect(MAX_PARLUME_HISTORY_TURNS).toBe(4);
	});

	it("starts the transcript window three minutes before now", () => {
		const now = Date.UTC(2026, 9, 15, 12, 0, 0);
		expect(liveTranscriptStart(now).getTime()).toBe(now - 180_000);
	});
});

describe("formatLiveTranscript", () => {
	it("lists lines oldest first from rows read newest first", () => {
		expect(
			formatLiveTranscript([
				{ text: "third", speakerName: "Sam" },
				{ text: "second", speakerName: null },
				{ text: "first", speakerName: "Alex" },
			]),
		).toBe("Alex: first\nAttendee: second\nSam: third");
	});

	it("keeps the most recent characters when it is over budget", () => {
		const transcript = formatLiveTranscript([
			{ text: `newest ${"n".repeat(2_500)}`, speakerName: "Alex" },
			{ text: `older ${"o".repeat(2_500)}`, speakerName: "Sam" },
		]);
		expect(transcript).toHaveLength(MAX_LIVE_TRANSCRIPT_CHARS);
		expect(transcript.endsWith("n".repeat(2_500))).toBe(true);
		expect(transcript).toContain("Alex: newest ");
		expect(transcript).not.toContain("Sam: older");
	});

	it("does not modify the rows it is given", () => {
		const rows = [
			{ text: "b", speakerName: null },
			{ text: "a", speakerName: null },
		];
		formatLiveTranscript(rows);
		expect(rows.map((row) => row.text)).toEqual(["b", "a"]);
	});

	it("is empty for a quiet meeting", () => {
		expect(formatLiveTranscript([])).toBe("");
	});
});

describe("formatParlumeHistory", () => {
	it("replays completed answers oldest first as user and assistant messages", () => {
		expect(
			formatParlumeHistory([
				{ requestText: "second?", responseText: "Two." },
				{ requestText: "first?", responseText: "One." },
			]),
		).toEqual([
			{ role: "user", content: "first?" },
			{ role: "assistant", content: "One." },
			{ role: "user", content: "second?" },
			{ role: "assistant", content: "Two." },
		]);
	});

	it("skips a turn that was never answered", () => {
		expect(
			formatParlumeHistory([
				{ requestText: "unanswered?", responseText: null },
			]),
		).toEqual([]);
	});
});
