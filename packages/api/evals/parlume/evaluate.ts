/**
 * One fixture through Parlume's own passes: the notes passes the notes
 * activity runs, kept by the same anchor check, and the live suggestion
 * passes the meeting would get, kept by the same anchoring. Then scored.
 */
import type { LanguageModel } from "@repo/ai";
import { isPromptCacheTarget } from "@repo/ai/prompt-cache";
import type { AnchorStats } from "@repo/temporal/parlume-notes-anchors";
import {
	parlumeNotesPass,
	writeAnchoredNotes,
} from "@repo/temporal/parlume-notes-passes";
import {
	LIVE_TRANSCRIPT_WINDOW_MS,
	MAX_LIVE_TRANSCRIPT_SEGMENTS,
} from "@repo/temporal/parlume-voice-context";
import type { ParlumeNoteKind } from "@repo/utils/parlume-notes";
import type { LanguageModelUsage } from "ai";
import {
	formatParlumeWorkItems,
	type ParlumeSuggestionMaterial,
	requestParlumeSuggestion,
} from "../../modules/projects/lib/parlume-suggestions";
import {
	buildEvalTranscript,
	type EvalSegment,
	evalSegments,
	type ParlumeEvalFixture,
} from "./fixture";
import {
	type ActionScore,
	anchorValidity,
	type DecisionScore,
	type ProducedSuggestion,
	type Ratio,
	scoreActionOwners,
	scoreDecisions,
	scoreSuggestions,
	type SuggestionScore,
} from "./scores";

/** A model the run resolved, and the catalog name it resolved to. */
export type EvalModel = {
	canonicalName: string;
	provider: string;
	model: LanguageModel;
};

/** The instructions under test: the defaults, or a candidate prompt. */
export type EvalPrompts = { notes: string; suggestion: string };

export type TokenUsage = { inputTokens: number; outputTokens: number };

type SuggestionPass = {
	afterSegment: number;
	material: ParlumeSuggestionMaterial;
};

function spokenLine(segment: EvalSegment) {
	return { text: segment.text, speakerName: segment.speaker };
}

/**
 * The suggestion passes of a fixture, one after each listed segment, as the
 * bridge would run them then: the last three minutes of speech, the meeting
 * before them and the chat so far, newest first, with the fixture's work
 * items, agenda and previous meeting's questions. The meeting has no project
 * passages: retrieval is not under test. Earlier suggestions are added as
 * the run produces them.
 */
export function suggestionPasses(
	fixture: ParlumeEvalFixture,
): SuggestionPass[] {
	const segments = evalSegments(fixture);
	const { workItems, agenda, previousQuestions } = fixture.suggestions;
	const workItemLines = formatParlumeWorkItems(workItems, workItems.length);
	const questions =
		previousQuestions.length > 0
			? previousQuestions.map((question) => `- ${question}`).join("\n")
			: null;
	return fixture.suggestions.passesAfter.map((afterSegment) => {
		const at = segments.find((segment) => segment.id === afterSegment);
		if (!at) {
			throw new Error(
				`${fixture.id}: suggestion pass after unknown segment ${afterSegment}`,
			);
		}
		const said = segments
			.filter((segment) => segment.endMs <= at.endMs)
			.reverse();
		const speech = said.filter((segment) => segment.source === "SPEECH");
		const windowStart = at.endMs - LIVE_TRANSCRIPT_WINDOW_MS;
		return {
			afterSegment,
			material: {
				speech: speech
					.filter((segment) => segment.endMs >= windowStart)
					.slice(0, MAX_LIVE_TRANSCRIPT_SEGMENTS)
					.map(spokenLine),
				earlierSpeech: speech
					.filter((segment) => segment.endMs < windowStart)
					.map(spokenLine),
				chat: said
					.filter((segment) => segment.source === "CHAT")
					.map(spokenLine),
				workItems: workItemLines,
				agenda,
				previousQuestions: questions,
				passages: null,
				previous: [],
			},
		};
	});
}

type EvalNote = {
	kind: ParlumeNoteKind;
	text: string;
	/** The fixture segment the note cites; null for a filler line. */
	segment: number | null;
	quote: string;
	owner: string | null;
	due: string | null;
};

export type FixtureResult = {
	fixture: string;
	/** Checkpoint parts the notes were written in; 1 for one pass. */
	parts: number;
	anchors: Ratio;
	anchorStats: AnchorStats;
	decisions: DecisionScore;
	actions: ActionScore;
	suggestions: SuggestionScore;
	notes: EvalNote[];
};

/**
 * Runs the fixture's notes and suggestion passes on the models and scores
 * what Parlume would have kept. Every pass's tokens are added to `usage` as
 * it returns, so a fixture that fails part way still counts what it spent.
 */
export async function evaluateFixture(input: {
	fixture: ParlumeEvalFixture;
	notesModel: EvalModel;
	suggestionModel: EvalModel;
	prompts: EvalPrompts;
	usage: TokenUsage;
}): Promise<FixtureResult> {
	const { fixture, prompts, usage } = input;
	const count = (used: LanguageModelUsage) => {
		usage.inputTokens += used.inputTokens ?? 0;
		usage.outputTokens += used.outputTokens ?? 0;
	};

	const transcript = buildEvalTranscript(fixture);
	const { notes, stats, parts } = await writeAnchoredNotes({
		content: transcript.content,
		chatDeliveryFacts: "",
		pass: async (prompt) => {
			const result = await parlumeNotesPass(
				input.notesModel.model,
				prompts.notes,
				prompt,
			);
			count(result.usage);
			return result.output;
		},
	});

	const produced: ProducedSuggestion[] = [];
	for (const pass of suggestionPasses(fixture)) {
		const { suggestion, usage: used } = await requestParlumeSuggestion({
			model: input.suggestionModel.model,
			instructions: prompts.suggestion,
			cacheSharedContext: isPromptCacheTarget(
				input.suggestionModel.provider,
				input.suggestionModel.canonicalName,
			),
			material: {
				...pass.material,
				previous: produced.map((earlier) => earlier.text),
			},
		});
		count(used);
		if (suggestion.suggest) {
			produced.push({
				afterSegment: pass.afterSegment,
				kind: suggestion.kind,
				text: suggestion.text,
			});
		}
	}

	return {
		fixture: fixture.id,
		parts,
		anchors: anchorValidity(stats),
		anchorStats: stats,
		decisions: scoreDecisions(notes, fixture.truth.decisions),
		actions: scoreActionOwners(notes, fixture.truth.actionItems),
		suggestions: scoreSuggestions(produced, fixture.suggestions.expected),
		notes: notes.map((note) => ({
			kind: note.kind,
			text: note.text,
			segment: transcript.segmentAtLine.get(note.anchorLine) ?? null,
			quote: note.quote,
			owner: note.tentativeOwnerName ?? null,
			due: note.dueHint ?? null,
		})),
	};
}
