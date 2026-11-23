/**
 * The synthetic meetings of the Parlume notes evaluation and the transcript
 * each becomes. Every fixture is invented: its people are "... Example",
 * its organization example-org and its links example.com.
 *
 * A fixture's segments carry numbers of their own (`id`). The ground truth
 * names segments by those numbers; the model sees transcript line numbers,
 * which `buildEvalTranscript` maps back.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { PARLUME_TRANSCRIPT_SPEECH_HEADER } from "@repo/utils/parlume-notes";
import { z } from "zod";
import { parlumeTranscriptLine } from "../../modules/projects/lib/parlume-transcript-line";

export const DEFAULT_FIXTURES_DIR = path.join(__dirname, "fixtures");

const segmentSchema = z.object({
	id: z.number().int().positive(),
	speaker: z.string().min(1).nullable(),
	/** Joined without signing in: the transcript marks the line unverified. */
	guest: z.boolean().optional(),
	source: z.enum(["SPEECH", "CHAT", "EVENT"]).default("SPEECH"),
	/** A chat message may hold several lines, none of them empty. */
	text: z.string().regex(/^[^\n]+(?:\n[^\n]+)*$/),
	startMs: z.number().int().nonnegative(),
	endMs: z.number().int().nonnegative(),
});

/**
 * Generated speech that makes a fixture long without hand-writing every
 * line: `count` lines after segment `afterSegment`, one every `everyMs`,
 * taking turns among `speakers` and filling `{topic}` in `lines`.
 */
const fillerSchema = z.object({
	afterSegment: z.number().int().positive(),
	count: z.number().int().positive(),
	everyMs: z.number().int().positive(),
	speakers: z.array(z.string().min(1)).min(1),
	lines: z.array(z.string().min(1)).min(1),
	topics: z.array(z.string().min(1)).min(1),
});

/**
 * Each keyword slot must be met by the produced text; `a|b` accepts either
 * word, and a slot of several words needs all of them. The slots carry the
 * meaning, negation included (see `scores.ts`).
 */
const keywordsSchema = z.array(z.string().min(1)).min(1);

const truthDecisionSchema = z.object({
	text: z.string().min(1),
	keywords: keywordsSchema,
	/** Where the meeting said it. Evidence for a reviewer; not scored. */
	segments: z.array(z.number().int().positive()).min(1),
});

const truthActionSchema = z.object({
	text: z.string().min(1),
	keywords: keywordsSchema,
	segments: z.array(z.number().int().positive()).min(1),
	owner: z.string().min(1).nullable(),
	due: z.string().min(1).nullable(),
});

const expectedSuggestionSchema = z.object({
	kind: z.enum(["answer", "missed_question"]),
	text: z.string().min(1),
	keywords: keywordsSchema,
});

const workItemSchema = z.object({
	identifier: z.string().min(1),
	title: z.string().min(1),
	status: z.string().min(1),
	priority: z.string().min(1),
	owner: z.string().min(1).nullable(),
});

const fixtureSchema = z.object({
	id: z.string().regex(/^[a-z0-9-]+$/),
	title: z.string().min(1),
	/** What the meeting exercises, for the fixture list in the docs. */
	covers: z.array(z.string().min(1)).min(1),
	segments: z.array(segmentSchema).min(1),
	filler: z.array(fillerSchema).default([]),
	truth: z.object({
		decisions: z.array(truthDecisionSchema),
		actionItems: z.array(truthActionSchema),
	}),
	suggestions: z.object({
		/** A live suggestion pass runs after each of these segments. */
		passesAfter: z.array(z.number().int().positive()).min(1),
		workItems: z.array(workItemSchema).default([]),
		agenda: z.string().min(1).nullable().default(null),
		previousQuestions: z.array(z.string().min(1)).default([]),
		expected: z.array(expectedSuggestionSchema),
	}),
});

export type ParlumeEvalFixture = z.infer<typeof fixtureSchema>;
export type TruthDecision = z.infer<typeof truthDecisionSchema>;
export type TruthAction = z.infer<typeof truthActionSchema>;
export type ExpectedSuggestion = z.infer<typeof expectedSuggestionSchema>;

/** A segment of the meeting as it is spoken, generated filler included. */
export type EvalSegment = {
	/** The fixture's own number; null for generated filler. */
	id: number | null;
	speaker: string | null;
	guest: boolean;
	source: "SPEECH" | "CHAT" | "EVENT";
	text: string;
	startMs: number;
	endMs: number;
};

export function parseEvalFixture(json: unknown): ParlumeEvalFixture {
	return fixtureSchema.parse(json);
}

/** The fixtures at `paths`: each a `.json` file or a directory of them. */
export async function loadEvalFixtures(
	paths: ReadonlyArray<string>,
): Promise<ParlumeEvalFixture[]> {
	const files: string[] = [];
	for (const entry of paths) {
		if ((await stat(entry)).isDirectory()) {
			const names = (await readdir(entry))
				.filter((name) => name.endsWith(".json"))
				.sort();
			files.push(...names.map((name) => path.join(entry, name)));
		} else {
			files.push(entry);
		}
	}
	const fixtures: ParlumeEvalFixture[] = [];
	for (const file of files) {
		try {
			fixtures.push(
				parseEvalFixture(JSON.parse(await readFile(file, "utf8"))),
			);
		} catch (error) {
			throw new Error(
				`${file}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return fixtures;
}

/** The meeting in spoken order, with each filler expanded after its segment. */
export function evalSegments(fixture: ParlumeEvalFixture): EvalSegment[] {
	const spoken: EvalSegment[] = fixture.segments.map((segment) => ({
		...segment,
		guest: segment.guest === true,
	}));
	for (const filler of fixture.filler) {
		const after = fixture.segments.find(
			(segment) => segment.id === filler.afterSegment,
		);
		if (!after) {
			throw new Error(
				`${fixture.id}: filler follows unknown segment ${filler.afterSegment}`,
			);
		}
		for (let index = 0; index < filler.count; index++) {
			const startMs = after.endMs + 1_000 + index * filler.everyMs;
			const template = filler.lines[index % filler.lines.length] ?? "";
			const round = Math.floor(index / filler.lines.length);
			const topic = filler.topics[round % filler.topics.length] ?? "";
			spoken.push({
				id: null,
				speaker:
					filler.speakers[index % filler.speakers.length] ?? null,
				guest: false,
				source: "SPEECH",
				text: template.replaceAll("{topic}", topic),
				startMs,
				endMs: startMs + Math.max(filler.everyMs - 1_000, 1),
			});
		}
	}
	return spoken.sort((a, b) => a.startMs - b.startMs);
}

/** How a fixture's speakers reach the transcript: a guest as a Teams visitor. */
function speakerId(segment: EvalSegment): string | null {
	if (!segment.speaker) {
		return null;
	}
	const slug = segment.speaker.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	return segment.guest ? `8:teamsvisitor:${slug}` : `8:orgid:${slug}`;
}

type EvalTranscript = {
	/** The transcript context's content, as finalization writes it. */
	content: string;
	/** The fixture segment each transcript line holds; null for filler. */
	segmentAtLine: ReadonlyMap<number, number | null>;
};

/**
 * The saved transcript of the fixture: the speech header on line 1, then each
 * segment, on as many lines as its text holds, through the line format
 * finalization uses. The meeting has no Fabric records: the evaluation
 * measures notes of what was said.
 */
export function buildEvalTranscript(
	fixture: ParlumeEvalFixture,
): EvalTranscript {
	const marks = { memberSpeakerIds: [], guestSpeakerIds: [] };
	const entries = [PARLUME_TRANSCRIPT_SPEECH_HEADER];
	const segmentAtLine = new Map<number, number | null>();
	let lastLine = 1;
	for (const segment of evalSegments(fixture)) {
		const entry = parlumeTranscriptLine(
			{
				text: segment.text,
				speakerName: segment.speaker,
				speakerId: speakerId(segment),
				source: segment.source,
			},
			marks,
		);
		entries.push(entry);
		const firstLine = lastLine + 1;
		lastLine += entry.split("\n").length;
		for (let line = firstLine; line <= lastLine; line++) {
			segmentAtLine.set(line, segment.id);
		}
	}
	return { content: `${entries.join("\n")}\n`, segmentAtLine };
}
