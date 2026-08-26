import { describe, expect, it } from "vitest";
import {
	composeAgendaPrompt,
	MEETING_AGENDA_AGENT_KEY,
	MEETING_AGENDA_PROMPT_FALLBACK_BODY,
} from "../build-agenda-prompt";
import type { AgendaContext } from "../collect-agenda-context";

const CONTEXT: AgendaContext = {
	priorMeetings: [],
	hadPriorTranscripts: false,
	carriedActionItems: [],
	openActionItems: [
		{
			text: "Draft the migration",
			tentativeOwnerName: null,
			dueHint: null,
		},
	],
	openDecisions: [],
	blockedStories: [],
	truncated: {
		actionItems: false,
		decisions: false,
		blockedStories: false,
		carriedActionItems: false,
	},
};

const composeFull = (
	templateBody: string,
	format: Parameters<typeof composeAgendaPrompt>[0]["format"],
) =>
	composeAgendaPrompt({
		templateBody,
		format,
		meetingSubject: "Fabric DSU",
		occurrenceStart: new Date("2026-07-25T09:00:00Z"),
		context: CONTEXT,
	});

const compose = async (
	templateBody: string,
	format: Parameters<typeof composeAgendaPrompt>[0]["format"],
) => (await composeFull(templateBody, format)).prompt;

describe("agent key", () => {
	it("is the exact string the seed and the binding UI use", () => {
		// A typo here resolves nothing and falls back forever, silently.
		expect(MEETING_AGENDA_AGENT_KEY).toBe("meeting_agenda_generator");
	});
});

describe("composeAgendaPrompt guards", () => {
	it("uses a bound template body over the default", async () => {
		const prompt = await compose(
			"CUSTOM PERSONA\n{{{open_action_items}}}",
			"HANDLEBARS",
		);
		expect(prompt).toContain("CUSTOM PERSONA");
		expect(prompt).toContain("Draft the migration");
		expect(prompt).not.toContain("You are preparing an agenda");
	});

	it("still appends the locked clauses to a custom body that omits them", async () => {
		const prompt = await compose("CUSTOM PERSONA ONLY", "HANDLEBARS");
		expect(prompt).toContain(
			"Every item must trace to the context above. Invent nothing.",
		);
	});

	it("guard 1: renders as Handlebars when the format does no templating", async () => {
		// MARKDOWN returns the body verbatim with NO error, which would ship the
		// model a prompt containing literal mustaches and zero meeting data.
		const prompt = await compose(
			MEETING_AGENDA_PROMPT_FALLBACK_BODY,
			"MARKDOWN",
		);
		expect(prompt).toContain("Draft the migration");
		expect(prompt).not.toContain("{{");
	});

	it("guard 2: recovers with the default body when a bound template cannot render", async () => {
		const prompt = await compose(
			"{{#if has_open_action_items}}broken",
			"HANDLEBARS",
		);
		expect(prompt).toContain("You are preparing an agenda");
		expect(prompt).toContain("Draft the migration");
		expect(prompt).not.toContain("{{");
	});

	it("guard 2: recovers when a Handlebars body is bound under LIQUID", async () => {
		const prompt = await compose(
			MEETING_AGENDA_PROMPT_FALLBACK_BODY,
			"LIQUID",
		);
		expect(prompt).toContain("Draft the migration");
		expect(prompt).not.toContain("{{");
	});

	it("guard 2: does not fire on meeting data that happens to contain mustaches", async () => {
		// An action item is user prose and can legitimately mention "{{". Tripping
		// the guard on that would discard a working org prompt — a worse bug than
		// the one the guard exists to catch. Only "{{{" or "{{#" surviving the
		// render is template syntax.
		const { prompt } = await composeAgendaPrompt({
			templateBody: "CUSTOM BODY\n{{{open_action_items}}}",
			format: "HANDLEBARS",
			meetingSubject: "Fabric DSU",
			occurrenceStart: new Date("2026-07-25T09:00:00Z"),
			context: {
				...CONTEXT,
				openActionItems: [
					{
						text: "Document the {{name}} placeholder syntax",
						tentativeOwnerName: null,
						dueHint: null,
					},
				],
			},
		});

		expect(prompt).toContain("CUSTOM BODY");
		expect(prompt).toContain("Document the {{name}} placeholder syntax");
		// The org body survived — it was NOT replaced by the default.
		expect(prompt).not.toContain("You are preparing an agenda");
	});
});

/**
 * Guard 3. A template can be valid, save cleanly, and still resolve to nothing
 * — at which point the model receives only the locked clauses and emits a
 * one-line agenda that is persisted as READY. Save-time validation cannot see
 * this, because whether a body renders to anything depends on the context it is
 * rendered against.
 */
describe("composeAgendaPrompt blank-render guard", () => {
	it("recovers when a falsy block helper renders the whole body away", async () => {
		// Observed on staging: parses as valid Handlebars, so assertValidTemplate
		// passes it, and `unknown` is simply absent from the variables, making
		// this a falsy block rather than a syntax error.
		const prompt = await compose("{{#unknown}}x{{/unknown}}", "HANDLEBARS");
		expect(prompt).toContain("You are preparing an agenda");
		expect(prompt).toContain("Draft the migration");
	});

	it("recovers when the body renders to whitespace only", async () => {
		const prompt = await compose(
			"{{#if has_prior_meetings}}\n \n{{/if}}",
			"HANDLEBARS",
		);
		expect(prompt).toContain("You are preparing an agenda");
		expect(prompt).toContain("Draft the migration");
	});

	it("reports a blank render as recovered, not as a clean run", async () => {
		const composed = await composeFull(
			"{{#unknown}}x{{/unknown}}",
			"HANDLEBARS",
		);
		expect(composed.bodyRecovered).toBe(true);
		expect(composed.formatOverridden).toBe(false);
	});

	it("recovers when the body renders to zero-width characters only", async () => {
		// Not caught by trim(): a zero-width space survives it, so this render
		// looks like one character of content while the model sees nothing.
		// Reached a bound version on staging (Fizzy #2178 QA).
		const composed = await composeFull(
			"{{#if has_prior_meetings}}Prior work{{/if}}\u200B",
			"HANDLEBARS",
		);
		expect(composed.bodyRecovered).toBe(true);
		expect(composed.prompt).toContain("You are preparing an agenda");
		expect(composed.prompt).toContain("Draft the migration");
	});

	it("does not fire on a body that renders to real content beside invisibles", async () => {
		// Invisible characters riding along with genuine content must not be
		// read as an empty render — that would discard a working org prompt.
		const composed = await composeFull(
			"\u200BGo.\uFEFF\n{{{open_action_items}}}",
			"HANDLEBARS",
		);
		expect(composed.bodyRecovered).toBe(false);
		expect(composed.prompt).toContain("Go.");
		expect(composed.prompt).not.toContain("You are preparing an agenda");
	});

	it("does not fire on a short body that renders to real content", async () => {
		// The guard keys on "rendered to nothing", never on length — a terse
		// working prompt must survive.
		const composed = await composeFull(
			"Go.\n{{{open_action_items}}}",
			"HANDLEBARS",
		);
		expect(composed.bodyRecovered).toBe(false);
		expect(composed.prompt).toContain("Go.");
		expect(composed.prompt).not.toContain("You are preparing an agenda");
	});
});

/**
 * A degraded run still produces a plausible agenda, so the degradation has to
 * be reported rather than inferred. These flags are what the activity records
 * as provenance on the agenda row.
 */
describe("composeAgendaPrompt degradation reporting", () => {
	it("reports a clean render as neither overridden nor recovered", async () => {
		const composed = await composeFull(
			"CUSTOM PERSONA\n{{{open_action_items}}}",
			"HANDLEBARS",
		);
		expect(composed.formatOverridden).toBe(false);
		expect(composed.bodyRecovered).toBe(false);
	});

	it("reports guard 1 when a non-templating format was forced to Handlebars", async () => {
		const composed = await composeFull(
			MEETING_AGENDA_PROMPT_FALLBACK_BODY,
			"MARKDOWN",
		);
		expect(composed.formatOverridden).toBe(true);
		// The body itself rendered fine once the format was corrected.
		expect(composed.bodyRecovered).toBe(false);
	});

	it("reports guard 2 when the bound body could not render", async () => {
		const composed = await composeFull(
			"{{#if has_open_action_items}}broken",
			"HANDLEBARS",
		);
		expect(composed.bodyRecovered).toBe(true);
		expect(composed.formatOverridden).toBe(false);
	});

	it("reports both when a Handlebars body is bound under PLAIN_TEXT", async () => {
		// Guard 1 corrects the format; the body still fails to render as
		// Handlebars only if it is broken, so this asserts the two flags are
		// independent rather than one implying the other.
		const composed = await composeFull(
			"{{#if has_open_action_items}}broken",
			"PLAIN_TEXT",
		);
		expect(composed.formatOverridden).toBe(true);
		expect(composed.bodyRecovered).toBe(true);
	});
});
