/**
 * The scorers, on hand-written model replies (`recorded/`) run through the
 * real notes and suggestion passes with the model mocked: the anchor check
 * keeps or drops each note as it would in a meeting, and the scores are what
 * the evaluation would report. No model is called.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parlumeNotesOutputSchema } from "@repo/temporal/parlume-notes-anchors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { evaluateFixture } from "../evaluate";
import { parseEvalFixture } from "../fixture";
import {
	meetsKeywords,
	sameDue,
	sameOwner,
	scoreDecisions,
	scoreSuggestions,
} from "../scores";

const mocks = vi.hoisted(() => ({
	generateText: vi.fn(),
	generateObject: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateText: mocks.generateText,
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: vi.fn(),
	Output: { object: (spec: unknown) => spec },
}));
vi.mock("@repo/database", () => ({
	db: {},
	getBoundPromptForAgent: vi.fn(),
	hasProjectAccess: vi.fn(),
	logAiUsageAsync: vi.fn(),
	tenantWhere: vi.fn(),
}));
vi.mock("@repo/rag", () => ({
	retrieveProjectContexts: vi.fn(),
	formatContextsForPrompt: vi.fn(),
}));

const EVALS = path.join(__dirname, "..");

const recordedSchema = z.object({
	notes: parlumeNotesOutputSchema,
	suggestions: z.array(
		z.object({
			suggest: z.boolean(),
			kind: z.string(),
			text: z.string(),
			speaker: z.string(),
			quote: z.string(),
			topic: z.string(),
		}),
	),
});

function readJson(...parts: string[]): unknown {
	return JSON.parse(readFileSync(path.join(EVALS, ...parts), "utf8"));
}

const MODEL = {
	canonicalName: "claude-haiku-5-5",
	provider: "ANTHROPIC_DIRECT",
	model: "test-model",
};

/** The fixture through the passes, the model answering with its recording. */
async function evaluateRecorded(id: string) {
	const reply = recordedSchema.parse(readJson("recorded", `${id}.json`));
	mocks.generateText.mockResolvedValue({
		output: reply.notes,
		usage: { inputTokens: 1_000, outputTokens: 200 },
		finishReason: "stop",
		response: {},
	});
	for (const object of reply.suggestions) {
		mocks.generateObject.mockResolvedValueOnce({
			object,
			usage: { inputTokens: 300, outputTokens: 40 },
		});
	}
	mocks.generateObject.mockResolvedValue({
		object: { suggest: false },
		usage: { inputTokens: 300, outputTokens: 5 },
	});
	const usage = { inputTokens: 0, outputTokens: 0 };
	const result = await evaluateFixture({
		fixture: parseEvalFixture(readJson("fixtures", `${id}.json`)),
		notesModel: MODEL,
		suggestionModel: MODEL,
		prompts: { notes: "Notes instructions.", suggestion: "Suggest." },
		usage,
	});
	return { result, usage };
}

beforeEach(() => {
	vi.resetAllMocks();
});

describe("scores on recorded replies", () => {
	it("counts a note citing the wrong segment, and one with no quote, as invalid anchors", async () => {
		const { result } = await evaluateRecorded("sprint-planning-short");

		expect(result.anchors).toEqual({ hits: 6, total: 8 });
		expect(result.anchorStats.dropped).toEqual({
			empty: 1,
			segment_unknown: 0,
			quote_not_in_segment: 1,
		});
		const kept = result.notes.map((note) => note.text);
		expect(kept).not.toContain("The PDF export stays for now.");
	});

	it("maps each kept note back to the fixture segment it cites", async () => {
		const { result } = await evaluateRecorded("sprint-planning-short");

		const decision = result.notes.find((note) => note.kind === "decision");
		expect(decision?.text).toBe("The refund export ships in this sprint.");
		expect(decision?.segment).toBe(5);
	});

	it("flags a decision the meeting did not make, even with a valid quote", async () => {
		const { result } = await evaluateRecorded("sprint-planning-short");

		expect(result.decisions).toEqual({
			produced: 2,
			invented: [
				"Duplicate charge alerts are owned by the on-call team.",
			],
			matched: 1,
			expected: 3,
		});
	});

	it("scores a wrong owner the cited line names, and keeps the right due date", async () => {
		const { result } = await evaluateRecorded("sprint-planning-short");

		expect(result.actions.accuracy).toEqual({ hits: 3, total: 4 });
		const idempotency = result.actions.pairs.find((pair) =>
			pair.expected.includes("idempotency"),
		);
		expect(idempotency?.owner).toEqual({
			produced: "Dev Example",
			expected: "Riley Example",
			ok: false,
		});
		expect(idempotency?.due.ok).toBe(true);
		expect(result.actions.missed).toEqual([]);
	});

	it("scores suggestion precision on the anchored suggestions only", async () => {
		const { result } = await evaluateRecorded("sprint-planning-short");

		// Four passes: a matched missed question, one whose quote nobody
		// said (dropped, as in a meeting), a matched answer, and one that
		// matches nothing expected.
		const { matches, precision } = result.suggestions;
		expect(precision).toEqual({ hits: 2, total: 3 });
		expect(matches.map((match) => match.afterSegment)).toEqual([8, 14, 16]);
		const unmatched = matches.filter((match) => match.matched === null);
		expect(unmatched.map((match) => match.afterSegment)).toEqual([16]);
	});

	it("adds up the tokens of every pass", async () => {
		const { usage } = await evaluateRecorded("sprint-planning-short");

		// One notes pass and four suggestion passes.
		expect(usage).toEqual({ inputTokens: 2_200, outputTokens: 360 });
	});

	it("keeps an inverted-meaning bullet whose quote is in the line, and counts it invented", async () => {
		const { result } = await evaluateRecorded("inverted-meaning");

		// "we should drop the audit log" is in "I'm not saying we should drop
		// the audit log": the anchor holds, the meaning does not.
		expect(result.anchors).toEqual({ hits: 5, total: 5 });
		expect(result.decisions.invented).toEqual([
			"Drop the audit log from this release.",
			"The mobile app ships in March.",
		]);
		expect(result.decisions.matched).toBe(2);
		expect(result.actions.accuracy).toEqual({ hits: 2, total: 2 });
	});
});

describe("matching rules", () => {
	it("needs every keyword slot, with alternatives and stems", () => {
		const slots = ["mobile|app", "march", "not|no|later"];
		const cases: Array<[string, string[], boolean]> = [
			["The mobile app will not ship in March.", slots, true],
			["The mobile app ships in March.", slots, false],
			["Shipping the export.", ["ship"], true],
			["Write the migration.", ["migrate"], true],
			["Own the data.", ["owner"], false],
			["Cap work in progress at three.", ["work in progress|wip"], true],
			["Cap progress at three.", ["work in progress|wip"], false],
		];
		for (const [text, keywords, expected] of cases) {
			expect(meetsKeywords(text, keywords), text).toBe(expected);
		}
	});

	it("matches an owner by a name's words, ignoring a transcript mark", () => {
		const cases: Array<[string | undefined, string | null, boolean]> = [
			["Dev", "Dev Example", true],
			["Pat Example (unverified speaker)", "Pat Example", true],
			["Dev Example", "Riley Example", false],
			[undefined, null, true],
			["Sam Example", null, false],
			[undefined, "Sam Example", false],
		];
		for (const [produced, expected, same] of cases) {
			expect(sameOwner(produced, expected), String(produced)).toBe(same);
		}
	});

	it("matches a due date by the words that say when", () => {
		const cases: Array<[string | undefined, string | null, boolean]> = [
			["by Wednesday", "Wednesday", true],
			["by the end of the month", "end of month", true],
			["next Tuesday", "Tuesday", true],
			["Friday", "Thursday", false],
			[undefined, "today", false],
			[undefined, null, true],
		];
		for (const [produced, expected, same] of cases) {
			expect(sameDue(produced, expected), String(produced)).toBe(same);
		}
	});

	it("does not count a replaced decision as invented", () => {
		const truth = [
			{
				text: "Beta on May 4.",
				keywords: ["beta", "may", "4"],
				segments: [2],
			},
			{
				text: "Beta moves to May 18.",
				keywords: ["beta", "may", "18"],
				segments: [9],
			},
		];
		const decision = (text: string) => ({
			kind: "decision" as const,
			text,
			anchorLine: 3,
		});
		const notes = [
			decision("The beta moves from May 4 to May 18."),
			decision("Use Postgres 17."),
		];

		expect(scoreDecisions(notes, truth)).toEqual({
			produced: 2,
			invented: ["Use Postgres 17."],
			matched: 2,
			expected: 2,
		});
	});

	it("matches each expected suggestion once, and only of its kind", () => {
		const expected = [
			{
				kind: "answer" as const,
				text: "PAY-57 is unassigned.",
				keywords: ["pay-57", "unassigned"],
			},
		];
		const said = {
			afterSegment: 1,
			kind: "answer" as const,
			text: "PAY-57 Alert on duplicate charges is unassigned.",
		};
		const again = { ...said, afterSegment: 2 };
		const asked = { ...said, kind: "missed_question" as const };

		const twice = scoreSuggestions([said, again], expected);
		expect(twice.precision).toEqual({ hits: 1, total: 2 });
		const otherKind = scoreSuggestions([asked], expected);
		expect(otherKind.precision).toEqual({ hits: 0, total: 1 });
	});
});
