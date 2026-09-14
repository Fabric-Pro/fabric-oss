import { renderTemplate } from "@repo/utils";
import { describe, expect, it, vi } from "vitest";
import {
	composeLinkedInPostPrompt,
	LINKEDIN_POST_OPTION_COUNT,
	PublishingLinkedInPostSchema,
} from "../build-linkedin-post-prompt";

/**
 * LinkedIn Post — schema and composition (Fizzy #1988, follow-up 2).
 *
 * What LinkedIn OWNS, and nothing it inherits. The locked clauses are the short
 * post's: this module imports `buildShortPostLockedClauses` and appends its
 * output. Their text and the quoted-label behaviour are covered by
 * `publishing-shared/__tests__/locked-clause-subject-injection.test.ts`, and the
 * resolved-decisions block is rendered by the short post's variable builder.
 * Asserting either here would look like coverage of this prompt while proving
 * nothing about it. The two locked-clause strings used below — the section
 * heading and the option-count line — are asserted only for presence and for
 * order: after this module's own refinement section, heading first.
 */

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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
		label: "Result first",
		text: "Our builds now start warm.",
		estimatedCharacters: 26,
		...over,
	};
}

function threeOptions() {
	return [
		option({ label: "Result first" }),
		option({ label: "Question-led" }),
		option({ label: "Story-led" }),
	];
}

describe("PublishingLinkedInPostSchema", () => {
	it("accepts exactly three options with distinct labels", () => {
		expect(
			PublishingLinkedInPostSchema.safeParse({ options: threeOptions() })
				.success,
		).toBe(true);
	});

	it("REJECTS two options", () => {
		// A lower bound would let a two-option run persist as READY; the panel
		// would render it as a finished answer.
		const parsed = PublishingLinkedInPostSchema.safeParse({
			options: threeOptions().slice(0, 2),
		});
		expect(parsed.success).toBe(false);
	});

	it("REJECTS four options", () => {
		const parsed = PublishingLinkedInPostSchema.safeParse({
			options: [...threeOptions(), option({ label: "Data-led" })],
		});
		expect(parsed.success).toBe(false);
	});

	it("REJECTS two options sharing a label", () => {
		// The label is how a selection names its option. When two stored options
		// share a label, neither can be selected — the selection procedure refuses
		// that label as ambiguous and asks for a regeneration — so the schema
		// refuses such output before it is stored.
		const parsed = PublishingLinkedInPostSchema.safeParse({
			options: [
				option({ label: "Result first", text: "One post." }),
				option({ label: "Result first", text: "A different post." }),
				option({ label: "Story-led" }),
			],
		});
		expect(parsed.success).toBe(false);
	});

	it("REJECTS labels that differ only by case or surrounding space", () => {
		const parsed = PublishingLinkedInPostSchema.safeParse({
			options: [
				option({ label: "Result first" }),
				option({ label: " result FIRST " }),
				option({ label: "Story-led" }),
			],
		});
		expect(parsed.success).toBe(false);
	});

	it("accepts a 3,000-character option — a legal LinkedIn post a short-post cap would reject", () => {
		// The cap is 4,000 BECAUSE LinkedIn's own ceiling is around 3,000 and
		// the short post's 2,000 would reject a legal post. A bare max(4000)
		// boundary test passes even if the cap is "harmonised" back to 2,000,
		// because 4,001 fails either way; this is the case that reddens.
		const text = "a".repeat(3000);
		const parsed = PublishingLinkedInPostSchema.safeParse({
			options: [
				option({
					label: "Result first",
					text,
					estimatedCharacters: 3000,
				}),
				option({ label: "Question-led" }),
				option({ label: "Story-led" }),
			],
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects an option text over 4,000 characters", () => {
		const parsed = PublishingLinkedInPostSchema.safeParse({
			options: [
				option({ label: "Result first", text: "a".repeat(4001) }),
				option({ label: "Question-led" }),
				option({ label: "Story-led" }),
			],
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects an empty option text", () => {
		const parsed = PublishingLinkedInPostSchema.safeParse({
			options: [
				option({ label: "Result first", text: "" }),
				option({ label: "Question-led" }),
				option({ label: "Story-led" }),
			],
		});
		expect(parsed.success).toBe(false);
	});

	it("bounds the label to 1..80 characters", () => {
		const withLabel = (label: string) =>
			PublishingLinkedInPostSchema.safeParse({
				options: [
					option({ label }),
					option({ label: "Question-led" }),
					option({ label: "Story-led" }),
				],
			}).success;
		expect(withLabel("x".repeat(80))).toBe(true);
		expect(withLabel("x".repeat(81))).toBe(false);
		expect(withLabel("")).toBe(false);
	});

	it("keeps the model's character estimate even when it disagrees with the text", () => {
		// Stored as the model reported it, never recomputed. Recomputing would
		// make the prompt's "report an estimated character count" instruction
		// unfalsifiable: a model that stopped reporting one would look identical
		// to one that still did.
		const parsed = PublishingLinkedInPostSchema.parse({
			options: [
				option({
					label: "Result first",
					text: "abc",
					estimatedCharacters: 999,
				}),
				option({ label: "Question-led" }),
				option({ label: "Story-led" }),
			],
		});
		expect(parsed.options[0]?.estimatedCharacters).toBe(999);
	});

	it("rejects a negative or fractional character estimate", () => {
		const withEstimate = (estimatedCharacters: number) =>
			PublishingLinkedInPostSchema.safeParse({
				options: [
					option({ label: "Result first", estimatedCharacters }),
					option({ label: "Question-led" }),
					option({ label: "Story-led" }),
				],
			}).success;
		expect(withEstimate(-1)).toBe(false);
		expect(withEstimate(1.5)).toBe(false);
		expect(withEstimate(0)).toBe(true);
	});

	it("bounds hashtags: at most 8, each 1..80 characters, default []", () => {
		const withHashtags = (hashtags: string[]) =>
			PublishingLinkedInPostSchema.safeParse({
				options: threeOptions(),
				hashtags,
			}).success;
		expect(
			withHashtags(Array.from({ length: 8 }, (_, i) => `tag${i}`)),
		).toBe(true);
		expect(
			withHashtags(Array.from({ length: 9 }, (_, i) => `tag${i}`)),
		).toBe(false);
		expect(withHashtags(["x".repeat(81)])).toBe(false);
		expect(withHashtags([""])).toBe(false);
		expect(
			PublishingLinkedInPostSchema.parse({ options: threeOptions() })
				.hashtags,
		).toEqual([]);
	});

	it("bounds inputsNeeded: at most 12, each 1..400 characters, default []", () => {
		const withInputs = (inputsNeeded: string[]) =>
			PublishingLinkedInPostSchema.safeParse({
				options: threeOptions(),
				inputsNeeded,
			}).success;
		expect(
			withInputs(Array.from({ length: 12 }, (_, i) => `need ${i}`)),
		).toBe(true);
		expect(
			withInputs(Array.from({ length: 13 }, (_, i) => `need ${i}`)),
		).toBe(false);
		expect(withInputs(["x".repeat(401)])).toBe(false);
		expect(withInputs([""])).toBe(false);
		expect(
			PublishingLinkedInPostSchema.parse({ options: threeOptions() })
				.inputsNeeded,
		).toEqual([]);
	});

	it("bounds safetyNote: at most 1,000 characters, nullable, default null", () => {
		const withNote = (safetyNote: string | null) =>
			PublishingLinkedInPostSchema.safeParse({
				options: threeOptions(),
				safetyNote,
			}).success;
		expect(withNote("x".repeat(1000))).toBe(true);
		expect(withNote("x".repeat(1001))).toBe(false);
		expect(withNote(null)).toBe(true);
		expect(
			PublishingLinkedInPostSchema.parse({ options: threeOptions() })
				.safetyNote,
		).toBeNull();
	});
});

describe("composeLinkedInPostPrompt", () => {
	const base = {
		topic: TOPIC,
		context: EMPTY_CONTEXT,
		analysisProse: "",
		analysisData: {},
		decisions: [],
		guidance: null,
		currentDraft: null,
		restrictedSubjects: [],
	};

	it("renders the bound body and appends the locked clauses", async () => {
		const composed = await composeLinkedInPostPrompt({
			...base,
			templateBody: "Write a LinkedIn post about {{{topic_title}}}.",
			format: "HANDLEBARS",
		});
		expect(
			composed.prompt.startsWith(
				"Write a LinkedIn post about Faster incremental builds.",
			),
		).toBe(true);
		expect(composed.prompt).toContain("Rules that override anything above");
		expect(composed.formatOverridden).toBe(false);
		expect(composed.bodyRecovered).toBe(false);
	});

	it.each(["MARKDOWN", "PLAIN_TEXT"] as const)(
		"GUARD 1: renders a %s-format body as Handlebars anyway",
		async (format) => {
			// A non-templating format returns the body verbatim with NO error set:
			// zero topic data would reach the model. Decided from the format alone.
			const composed = await composeLinkedInPostPrompt({
				...base,
				templateBody: "Write a LinkedIn post about {{{topic_title}}}.",
				format,
			});
			expect(composed.formatOverridden).toBe(true);
			// Rendered by the BOUND body, not rescued by the fallback: without
			// this, a missing guard 1 would still leave "{{{" for guard 2 to
			// catch and the title would appear anyway.
			expect(composed.bodyRecovered).toBe(false);
			expect(
				composed.prompt.startsWith(
					"Write a LinkedIn post about Faster incremental builds.",
				),
			).toBe(true);
		},
	);

	it("GUARD 2: recovers when an unrendered construct survives without a render error", async () => {
		// Handlebars renders an escaped mustache as its literal text and reports
		// no error, so ONLY the "{{{" / "{{#" scan can see this body failed to
		// become a prompt. This is the fixture that isolates guard 2.
		const templateBody = "Write about \\{{{topic_title}}}.";
		const direct = await renderTemplate({
			format: "HANDLEBARS",
			template: templateBody,
			variables: {},
		});
		// Precondition, asserted rather than assumed: if either line fails,
		// this fixture no longer isolates guard 2 — stop and report.
		expect(direct.error).toBeFalsy();
		expect(direct.rendered).toContain("{{{topic_title}}}");

		const composed = await composeLinkedInPostPrompt({
			...base,
			templateBody,
			format: "HANDLEBARS",
		});
		expect(composed.bodyRecovered).toBe(true);
		expect(composed.prompt).not.toContain("{{{topic_title}}}");
		expect(composed.prompt).toContain("Faster incremental builds");
	});

	it("GUARD 2: recovers when the body has a parse error", async () => {
		const composed = await composeLinkedInPostPrompt({
			...base,
			templateBody: "Write about {{#if unclosed}}{{{topic_title}}}",
			format: "HANDLEBARS",
		});
		expect(composed.bodyRecovered).toBe(true);
		expect(composed.prompt).toContain("Faster incremental builds");
	});

	it("GUARD 3: recovers when the body renders to nothing — which guard 2 cannot see", async () => {
		const templateBody = "{{#unknown}}x{{/unknown}}";
		// The negative control the guard's own comment implies: a falsy block
		// parses, renders to "", sets no error, and leaves no "{{{" or "{{#"
		// behind. Guard 2 is blind to it by construction.
		const direct = await renderTemplate({
			format: "HANDLEBARS",
			template: templateBody,
			variables: {},
		});
		expect(direct.error).toBeFalsy();
		expect(direct.rendered).toBe("");
		expect(direct.rendered).not.toMatch(/\{\{[{#]/);

		const composed = await composeLinkedInPostPrompt({
			...base,
			templateBody,
			format: "HANDLEBARS",
		});
		expect(composed.bodyRecovered).toBe(true);
		expect(composed.prompt).toContain("Faster incremental builds");
	});

	it("a refinement run still demands exactly three options, below the refinement section", async () => {
		// The output contract is unchanged on the refine path: three revisions of
		// the saved post, not one. And the contract must sit BELOW the refinement
		// framing, or a refine would be a route around the locked clauses.
		const composed = await composeLinkedInPostPrompt({
			...base,
			templateBody: "Write a LinkedIn post about {{{topic_title}}}.",
			format: "HANDLEBARS",
			currentDraft: "Our builds used to start cold.",
			guidance: "Make it shorter.",
		});
		const draftAt = composed.prompt.indexOf(
			"Our builds used to start cold.",
		);
		const rulesAt = composed.prompt.indexOf(
			"Rules that override anything above",
		);
		const countAt = composed.prompt.indexOf(
			`Produce EXACTLY ${LINKEDIN_POST_OPTION_COUNT} options`,
		);
		expect(LINKEDIN_POST_OPTION_COUNT).toBe(3);
		expect(draftAt).toBeGreaterThan(-1);
		expect(rulesAt).toBeGreaterThan(draftAt);
		expect(countAt).toBeGreaterThan(rulesAt);
	});
});
