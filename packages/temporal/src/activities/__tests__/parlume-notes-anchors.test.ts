import { describe, expect, it } from "vitest";
import {
	anchorParlumeNotes,
	checkpointWindows,
	renderParlumeNotes,
	splitParlumeTranscript,
	type TranscriptLine,
} from "../parlume-notes-anchors";

// A synthetic meeting. Line 1 is the speech header; the numbers below are the
// lines of the transcript context, as the transcript reader counts them.
const TRANSCRIPT = [
	"Captured incoming speech:",
	"Avery Diaz: we will not move the launch to Friday, it stays on Monday.", // 2
	"Bob Brennan: I'll take the release notes, done by Thursday.", // 3
	"[chat] Casey Lee: um so like, the BILLING export -- does it ship?? with the launch", // 4
	"Avery Diaz: the migration script needs a review before we merge it.", // 5
	"",
	"Recorded Fabric responses and mutation receipts:",
	"Request 1: Create the billing export feature",
	"Action receipt: create_feature — FAILED",
].join("\n");

function shownMap(lines: TranscriptLine[]): Map<number, string> {
	return new Map(lines.map((line) => [line.line, line.text]));
}

const { lines, records } = splitParlumeTranscript(TRANSCRIPT);
const allShown = shownMap(lines);

describe("splitParlumeTranscript", () => {
	it("numbers the meeting's own lines as the transcript reader does, and keeps Fabric's records apart", () => {
		expect(lines.map((line) => line.line)).toEqual([2, 3, 4, 5]);
		expect(lines[0]?.text).toBe(
			"Avery Diaz: we will not move the launch to Friday, it stays on Monday.",
		);
		expect(records).toContain("Action receipt: create_feature — FAILED");
		expect(records.startsWith("Recorded Fabric responses")).toBe(true);
	});
});

// A meeting in which Parlume posted to the chat, as finalization writes it: a
// chat message of several lines ends each line but its last with "\r".
const WITH_PARLUME_POSTS = [
	"Captured incoming speech:",
	"[chat] Fabric Parlume: [P1] Fabric Parlume (AI assistant) is in this meeting\r", // 2
	"I transcribe the meeting and write notes.\r", // 3
	'To pause me, say or type "Parlume, pause". Parlume page', // 4
	"Dana Example: Parlume, what is this project about?", // 5
	"[chat] Fabric Parlume (unverified speaker): [P3] Detail for Dana Example\r", // 6
	"It has two open backlog items.\r", // 7
	"Decision: move the beta to May.\r", // 8
	"• Next step: Sam Example drafts the pricing page by Friday.", // 9
	"we keep the beta in April, the team agreed.", // 10
	"[chat] Sam Example: Agenda for Friday:\r", // 11
	"Status: pricing page draft\r", // 12
	"Owner: Sam Example", // 13
	"[Parlume] Listening paused by Dana Example.", // 14
	"Dana Example: Parlume, stop.", // 15
].join("\n");

describe("splitParlumeTranscript with Parlume's own chat posts", () => {
	const split = splitParlumeTranscript(WITH_PARLUME_POSTS);

	it("leaves every line of Parlume's posts out, marked or not, and keeps the content's line numbers", () => {
		expect(split.lines.map((line) => line.line)).toEqual([
			5, 10, 11, 12, 13, 14, 15,
		]);
		expect(split.lines[1]?.text).toBe(
			"we keep the beta in April, the team agreed.",
		);
	});

	it("keeps each line of a person's chat message of several lines", () => {
		expect(
			split.lines
				.filter((line) => line.line >= 11 && line.line <= 13)
				.map((line) => line.text),
		).toEqual([
			"[chat] Sam Example: Agenda for Friday:",
			"Status: pricing page draft",
			"Owner: Sam Example",
		]);
	});

	it("leaves a person's chat line in that names Parlume", () => {
		const { lines: kept } = splitParlumeTranscript(
			[
				"Captured incoming speech:",
				"[chat] Dana Example: Fabric Parlume: please post the roadmap",
			].join("\n"),
		);
		expect(kept.map((line) => line.line)).toEqual([2]);
	});

	it("drops a note citing a line of Parlume's post, and keeps one citing a person's chat line", () => {
		const { notes, stats } = anchorParlumeNotes(
			{
				decisions: [
					{
						text: "The beta moves to May.",
						segment: 8,
						quote: "move the beta to May",
					},
				],
				actionItems: [
					{
						text: "Draft the pricing page.",
						segment: 9,
						quote: "Sam Example drafts the pricing page by Friday",
						owner: "Sam Example",
						due: "by Friday",
					},
					{
						text: "Own the pricing page draft.",
						segment: 13,
						quote: "Owner: Sam Example",
						owner: "Sam Example",
					},
				],
			},
			shownMap(split.lines),
		);
		expect(notes).toEqual([
			{
				kind: "action",
				text: "Own the pricing page draft.",
				anchorLine: 13,
				quote: "Owner: Sam Example",
				tentativeOwnerName: "Sam Example",
			},
		]);
		expect(stats.dropped.segment_unknown).toBe(2);
	});
});

describe("anchorParlumeNotes", () => {
	it("keeps a note whose quote is in the line it cites", () => {
		const { notes, stats } = anchorParlumeNotes(
			{
				decisions: [
					{
						text: "The launch stays on Monday.",
						segment: 2,
						quote: "it stays on Monday",
					},
				],
			},
			allShown,
		);
		expect(notes).toEqual([
			{
				kind: "decision",
				text: "The launch stays on Monday.",
				anchorLine: 2,
				quote: "it stays on Monday",
			},
		]);
		expect(stats).toMatchObject({ proposed: 1, kept: 1 });
	});

	it("drops a quote whose meaning was inverted to fit the note", () => {
		const { notes, stats } = anchorParlumeNotes(
			{
				decisions: [
					{
						text: "The launch moves to Friday.",
						segment: 2,
						quote: "we will move the launch to Friday",
					},
				],
			},
			allShown,
		);
		expect(notes).toEqual([]);
		expect(stats.dropped.quote_not_in_segment).toBe(1);
	});

	it("drops a real quote that cites the wrong line", () => {
		const { notes, stats } = anchorParlumeNotes(
			{
				actionItems: [
					{
						text: "Review the migration script before merging.",
						segment: 3,
						quote: "the migration script needs a review",
					},
				],
			},
			allShown,
		);
		expect(notes).toEqual([]);
		expect(stats.dropped.quote_not_in_segment).toBe(1);
	});

	it("drops a note citing a line outside the part the pass read, or no line at all", () => {
		// A checkpoint pass read lines 2 and 3 only: line 5 is from a part of
		// the meeting it never saw, line 40 does not exist.
		const part = shownMap(lines.filter((line) => line.line <= 3));
		const { notes, stats } = anchorParlumeNotes(
			{
				discussion: [
					{
						text: "The migration script needs a review.",
						segment: 5,
						quote: "the migration script needs a review",
					},
					{
						text: "The budget was approved.",
						segment: 40,
						quote: "the budget is approved",
					},
					{
						text: "Something was said.",
						quote: "something was said",
					},
				],
			},
			part,
		);
		expect(notes).toEqual([]);
		expect(stats.dropped.segment_unknown).toBe(3);
	});

	it("tolerates speech-to-text noise in case, spacing and punctuation", () => {
		const { notes } = anchorParlumeNotes(
			{
				openQuestions: [
					{
						text: "Does the billing export ship with the launch?",
						segment: "[4]",
						quote: "the billing export does it ship with the launch",
					},
				],
			},
			allShown,
		);
		expect(notes).toEqual([
			expect.objectContaining({ kind: "question", anchorLine: 4 }),
		]);
	});

	it("drops a note with no text or no quote", () => {
		const { notes, stats } = anchorParlumeNotes(
			{
				decisions: [
					{ segment: 2, quote: "it stays on Monday" },
					{ text: "The launch stays on Monday.", segment: 2 },
				],
			},
			allShown,
		);
		expect(notes).toEqual([]);
		expect(stats.dropped.empty).toBe(2);
	});

	it("keeps an owner and a due date only when the cited line names them", () => {
		const { notes, stats } = anchorParlumeNotes(
			{
				actionItems: [
					{
						text: "Write the release notes.",
						segment: 3,
						quote: "I'll take the release notes",
						owner: "Bob Brennan",
						due: "by Thursday",
					},
					{
						text: "Write the release notes.",
						segment: 3,
						quote: "I'll take the release notes",
						owner: "Avery Diaz",
						due: "by Friday",
					},
					{
						text: "Review the migration script.",
						segment: 5,
						quote: "the migration script needs a review",
						owner: "Avery",
						due: "end of sprint",
					},
				],
			},
			allShown,
		);
		expect(notes).toEqual([
			{
				kind: "action",
				text: "Write the release notes.",
				anchorLine: 3,
				quote: "I'll take the release notes",
				tentativeOwnerName: "Bob Brennan",
				dueHint: "by Thursday",
			},
			{
				kind: "action",
				text: "Write the release notes.",
				anchorLine: 3,
				quote: "I'll take the release notes",
			},
			{
				kind: "action",
				text: "Review the migration script.",
				anchorLine: 5,
				quote: "the migration script needs a review",
				tentativeOwnerName: "Avery",
			},
		]);
		expect(stats).toMatchObject({ ownersDropped: 1, duesDropped: 2 });
	});
});

describe("checkpointWindows", () => {
	it("keeps a meeting that fits in one part, and cuts a longer one between lines", () => {
		expect(checkpointWindows(lines, 10_000)).toEqual([lines]);
		const parts = checkpointWindows(lines, 160);
		expect(parts.length).toBeGreaterThan(1);
		expect(parts.flat()).toEqual(lines);
	});
});

describe("renderParlumeNotes", () => {
	it("writes a Markdown section per kind, with an action item's owner and due date", () => {
		expect(
			renderParlumeNotes([
				{ kind: "action", text: "Write the notes.", anchorLine: 3 },
				{
					kind: "decision",
					text: "The launch stays on Monday.",
					anchorLine: 2,
				},
				{
					kind: "action",
					text: "Draft the release notes.",
					anchorLine: 3,
					tentativeOwnerName: "Bob Brennan",
					dueHint: "by Thursday",
				},
			]),
		).toBe(
			[
				"### Decisions",
				"- The launch stays on Monday.",
				"",
				"### Action items",
				"- Write the notes.",
				"- Draft the release notes. (Owner: Bob Brennan, Due: by Thursday)",
			].join("\n"),
		);
	});
});
