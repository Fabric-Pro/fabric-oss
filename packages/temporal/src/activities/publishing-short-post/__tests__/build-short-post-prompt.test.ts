import { describe, expect, it } from "vitest";
import {
	buildShortPostLockedClauses,
	buildShortPostVariables,
	composeShortPostPrompt,
	flattenPlanningAnalysis,
	PublishingShortPostSchema,
	SHORT_POST_OPTION_COUNT,
} from "../build-short-post-prompt";

/**
 * The pure half of Short Post generation (Fizzy #1853, Phase 2B-2).
 *
 * No model, no database, no Temporal context — every case here drives the
 * schema, the variables or the composition directly, which is why they live in
 * separate modules from the activity that uses them.
 */

const TOPIC = {
	id: "topic-1",
	title: "Faster incremental builds",
	pitch: "Builds now reuse a warm cache.",
	angle: null,
	subject: null,
	relevantFunctionTags: [],
	postTypeRecommendations: null,
	contributors: [],
};

const EMPTY_CONTEXT = {
	stories: [],
	documents: [],
	transcripts: [],
	repoPrs: [],
};

function option(over: Record<string, unknown> = {}) {
	return {
		label: "Direct",
		text: "Builds are faster now.",
		estimatedCharacters: 24,
		...over,
	};
}

describe("PublishingShortPostSchema", () => {
	it("accepts exactly three options", () => {
		const parsed = PublishingShortPostSchema.safeParse({
			options: [
				option({ label: "Direct" }),
				option({ label: "Question-led" }),
				option({ label: "Story-led" }),
			],
		});
		expect(parsed.success).toBe(true);
	});

	it("REJECTS two options", () => {
		// FR16 says exactly three. A lower bound would let a short run persist as
		// READY and the panel would render it as a finished answer, with nothing
		// downstream ever noticing the contract had been broken.
		const parsed = PublishingShortPostSchema.safeParse({
			options: [option({ label: "A" }), option({ label: "B" })],
		});
		expect(parsed.success).toBe(false);
	});

	it("REJECTS four options", () => {
		const parsed = PublishingShortPostSchema.safeParse({
			options: [
				option({ label: "A" }),
				option({ label: "B" }),
				option({ label: "C" }),
				option({ label: "D" }),
			],
		});
		expect(parsed.success).toBe(false);
	});

	it("REJECTS two options sharing a label", () => {
		// The label is the selection key: the client sends a label and the server
		// reads that option's text back out of the draft. Two options under one
		// label make the key ambiguous, so picking the second silently adopts the
		// first one's text — the reader chooses one post and a different post is
		// what gets published.
		const parsed = PublishingShortPostSchema.safeParse({
			options: [
				option({ label: "Direct", text: "First." }),
				option({
					label: "Direct",
					text: "Second, entirely different.",
				}),
				option({ label: "Story-led" }),
			],
		});
		expect(parsed.success).toBe(false);
	});

	it("REJECTS labels that differ only by case or surrounding space", () => {
		// These resolve fine as strings, so selection would work. They are
		// rejected because the label's job is to let a person tell the options
		// apart, and "Direct" next to "direct " is not a choice.
		const parsed = PublishingShortPostSchema.safeParse({
			options: [
				option({ label: "Direct" }),
				option({ label: " direct " }),
				option({ label: "Story-led" }),
			],
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects an option with empty text", () => {
		const parsed = PublishingShortPostSchema.safeParse({
			options: [
				option({ text: "" }),
				option({ label: "B" }),
				option({ label: "C" }),
			],
		});
		expect(parsed.success).toBe(false);
	});

	it("defaults the optional sections rather than requiring them", () => {
		// The PO's prompt marks hashtags and inputs-needed "only include if
		// useful". Requiring them would fail a perfectly good run for omitting a
		// section it was told it could omit.
		const parsed = PublishingShortPostSchema.parse({
			options: [
				option({ label: "A" }),
				option({ label: "B" }),
				option({ label: "C" }),
			],
		});
		expect(parsed.hashtags).toEqual([]);
		expect(parsed.inputsNeeded).toEqual([]);
		expect(parsed.safetyNote).toBeNull();
	});

	it("keeps the model's own character estimate", () => {
		// Deliberately not recomputed from `text`: replacing the model's number
		// with ours would make the prompt's "report an estimated character count"
		// instruction unfalsifiable — a model that stopped reporting one would
		// look identical to one that still did.
		const parsed = PublishingShortPostSchema.parse({
			options: [
				option({ label: "A", text: "abc", estimatedCharacters: 999 }),
				option({ label: "B" }),
				option({ label: "C" }),
			],
		});
		expect(parsed.options[0].estimatedCharacters).toBe(999);
	});
});

describe("flattenPlanningAnalysis", () => {
	it("walks whatever the document holds rather than a known field list", () => {
		// The point of walking: 2A owns that schema and keeps evolving it. A
		// field list duplicated here would silently stop passing on whichever
		// section 2A added last, with no test on either side going red.
		const out = flattenPlanningAnalysis({
			keyDetailsToUse: ["Cache reuse", "No config change"],
			aSectionInventedLater: { nested: "still reaches the writer" },
		});
		expect(out).toContain("Key details to use");
		expect(out).toContain("Cache reuse");
		expect(out).toContain("A section invented later");
		expect(out).toContain("still reaches the writer");
	});

	it("returns empty for a missing or non-object analysis", () => {
		expect(flattenPlanningAnalysis(null)).toBe("");
		expect(flattenPlanningAnalysis(undefined)).toBe("");
		expect(flattenPlanningAnalysis("not an object")).toBe("");
	});

	it("drops sections whose values are all empty", () => {
		// An empty section rendered as a bare heading invites the model to fill
		// it — the one thing the grounding rules forbid.
		const out = flattenPlanningAnalysis({ risks: [], notes: "   " });
		expect(out).toBe("");
	});

	it("caps a very long analysis", () => {
		const out = flattenPlanningAnalysis({
			notes: "x".repeat(20_000),
		});
		// Left uncapped, a long worksheet plus the source context it was derived
		// FROM can push one request past the provider's input window, which fails
		// the whole run rather than degrading it.
		expect(out.length).toBeLessThan(9000);
	});
});

describe("buildShortPostVariables", () => {
	it("omits each section when it has nothing", () => {
		const vars = buildShortPostVariables({
			planningAnalysis: null,
			decisions: [],
			guidance: null,
		});
		expect(vars.has_planning_analysis).toBe(false);
		expect(vars.has_decisions).toBe(false);
		expect(vars.has_guidance).toBe(false);
	});

	it("drops a decision with no answer text", () => {
		// An unanswered decision is not a settled instruction. Rendering one
		// would present an open question to the model as though it were decided.
		const vars = buildShortPostVariables({
			planningAnalysis: null,
			decisions: [
				{
					subject: "Customer name",
					decisionKind: "CUSTOMER_NAME",
					answer: "  ",
				},
			],
			guidance: null,
		});
		expect(vars.has_decisions).toBe(false);
	});

	it("names a decision by its kind when it carries no subject", () => {
		const vars = buildShortPostVariables({
			planningAnalysis: null,
			decisions: [
				{
					subject: null,
					decisionKind: "METRICS_APPROVAL",
					answer: "Approved",
				},
			],
			guidance: null,
		});
		expect(vars.decisions).toContain("Metrics approval");
		expect(vars.decisions).toContain("Approved");
	});

	it("caps the guidance", () => {
		const vars = buildShortPostVariables({
			planningAnalysis: null,
			decisions: [],
			guidance: "y".repeat(9000),
		});
		expect(vars.guidance.length).toBeLessThan(2100);
	});

	it("treats whitespace-only guidance as none", () => {
		const vars = buildShortPostVariables({
			planningAnalysis: null,
			decisions: [],
			guidance: "   \n  ",
		});
		expect(vars.has_guidance).toBe(false);
	});
});

describe("buildShortPostLockedClauses", () => {
	it("states the option count the schema enforces", () => {
		const clauses = buildShortPostLockedClauses();
		expect(clauses).toContain(String(SHORT_POST_OPTION_COUNT));
	});

	it("asks for distinct labels, which the schema cannot ask for", () => {
		// `generateObject` converts the schema to JSON Schema, which has no way to
		// express uniqueness across array elements — so the model never sees the
		// refinement that will reject its output. Without this clause the rule
		// exists only as a rejection, and a run fails for a reason it was never
		// told about.
		const clauses = buildShortPostLockedClauses();
		expect(clauses).toMatch(/label must be DIFFERENT/i);
	});

	it("carries the approval rules FR28/FR29 turn on", () => {
		// These have no schema to catch them: a draft asserting an unapproved
		// customer name parses perfectly and persists as READY. Code-side is the
		// only place they hold.
		const clauses = buildShortPostLockedClauses();
		expect(clauses).toMatch(/customer name/i);
		expect(clauses).toMatch(/screenshot/i);
		expect(clauses).toMatch(/metric/i);
	});

	it("names the specific unresolved approvals when there are any", () => {
		const clauses = buildShortPostLockedClauses([
			"Acme Corp",
			"the latency chart",
		]);
		expect(clauses).toContain("Acme Corp");
		expect(clauses).toContain("the latency chart");
		expect(clauses).toMatch(/NOT approved/);
	});

	it("omits the restrictions block entirely when nothing is unresolved", () => {
		// A heading saying "the following are not approved" over an empty list
		// reads as a system that has lost track of its own state.
		const clauses = buildShortPostLockedClauses([]);
		expect(clauses).not.toMatch(/Unresolved approvals/);
	});

	it("ignores blank subjects rather than emitting an empty bullet", () => {
		const clauses = buildShortPostLockedClauses(["  ", ""]);
		expect(clauses).not.toMatch(/Unresolved approvals/);
	});
});

describe("composeShortPostPrompt", () => {
	const base = {
		topic: TOPIC,
		context: EMPTY_CONTEXT,
		planningAnalysis: null,
		decisions: [],
		guidance: null,
		restrictedSubjects: [],
	};

	it("renders the bound body and appends the locked clauses", async () => {
		const composed = await composeShortPostPrompt({
			...base,
			templateBody: "Write about {{{topic_title}}}.",
			format: "HANDLEBARS",
		});
		expect(composed.prompt).toContain("Faster incremental builds");
		expect(composed.prompt).toMatch(/Rules that override anything above/);
		expect(composed.formatOverridden).toBe(false);
		expect(composed.bodyRecovered).toBe(false);
	});

	it("GUARD 1: renders a MARKDOWN-format body as Handlebars anyway", async () => {
		// MARKDOWN does no templating at all and returns the body verbatim with
		// NO error set. For a prompt whose entire context arrives as variables,
		// that silently ships zero topic data and the model writes about nothing
		// in particular while sounding fine doing it.
		const composed = await composeShortPostPrompt({
			...base,
			templateBody: "Write about {{{topic_title}}}.",
			format: "MARKDOWN",
		});
		expect(composed.formatOverridden).toBe(true);
		expect(composed.prompt).toContain("Faster incremental builds");
	});

	it("GUARD 2: recovers when the body did not render", async () => {
		// A parse error is swallowed into a raw-body return, so the tell is an
		// unrendered construct surviving into the output.
		const composed = await composeShortPostPrompt({
			...base,
			templateBody: "Write about {{#if unclosed}}{{{topic_title}}}",
			format: "HANDLEBARS",
		});
		expect(composed.bodyRecovered).toBe(true);
		expect(composed.prompt).toContain("Faster incremental builds");
	});

	it("GUARD 3: recovers when the body renders to nothing", async () => {
		// `{{#unknown}}x{{/unknown}}` is a falsy block, not a syntax error: it
		// parses, renders to "", and guard 2 cannot see it precisely because
		// nothing survived. Without this the model would get only the locked
		// clauses — no instructions and no topic — and still emit three plausible
		// posts that persist as READY.
		const composed = await composeShortPostPrompt({
			...base,
			templateBody: "{{#nope}}anything{{/nope}}",
			format: "HANDLEBARS",
		});
		expect(composed.bodyRecovered).toBe(true);
		expect(composed.prompt).toContain("Faster incremental builds");
	});

	it("passes the restricted subjects through to the locked clauses", async () => {
		const composed = await composeShortPostPrompt({
			...base,
			templateBody: "Write about {{{topic_title}}}.",
			format: "HANDLEBARS",
			restrictedSubjects: ["Acme Corp"],
		});
		// The tab tells the reader these will be generalized rather than
		// asserted. This is the half that makes that true.
		expect(composed.prompt).toContain("Acme Corp");
	});

	it("says plainly when there is no source context at all", async () => {
		const composed = await composeShortPostPrompt({
			...base,
			templateBody:
				"{{#unless has_any_source_context}}NOTHING{{/unless}}",
			format: "HANDLEBARS",
		});
		expect(composed.prompt).toContain("NOTHING");
	});
});
