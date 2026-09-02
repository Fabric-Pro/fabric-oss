import { describe, expect, it } from "vitest";
import {
	buildBlogPostLockedClauses,
	composeBlogPostPrompt,
	composeWorkingDraftBody,
	PublishingBlogPostSchema,
} from "../build-blog-post-prompt";

/**
 * The pure half of Blog Post generation (Fizzy #1853, Phase 2B-3).
 *
 * No model, no database, no Temporal context — every case here drives the
 * schema, the body composition or the prompt composition directly, which is why
 * they live in separate modules from the activity that uses them.
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

function post(over: Record<string, unknown> = {}) {
	return {
		title: "Faster incremental builds",
		subtitle: "How a warm cache changed the inner loop",
		body: "## Why this matters\n\nBuilds used to start cold.",
		// Deliberately tokens that appear NOWHERE in the title, subtitle or
		// body, so "these stayed out of the editable text" is a claim the
		// assertion can actually make.
		categories: ["Toolchain"],
		keywords: ["ci-pipeline", "warm-start"],
		inputsNeeded: [],
		safetyNote: null,
		...over,
	};
}

describe("PublishingBlogPostSchema", () => {
	it("accepts one post with its publishing suggestions", () => {
		const parsed = PublishingBlogPostSchema.safeParse(post());
		expect(parsed.success).toBe(true);
	});

	it("REJECTS an empty body, which would seed an empty working draft", () => {
		// DV5 makes the first generation write this text straight into the
		// topic's working draft. An empty body would therefore not fail
		// visibly — it would silently produce a blank editor.
		const parsed = PublishingBlogPostSchema.safeParse(post({ body: "" }));
		expect(parsed.success).toBe(false);
	});

	it("REJECTS a missing title, which the composed body is built from", () => {
		const parsed = PublishingBlogPostSchema.safeParse(post({ title: "" }));
		expect(parsed.success).toBe(false);
	});

	it("accepts a null subtitle, which the prompt calls optional", () => {
		const parsed = PublishingBlogPostSchema.safeParse(
			post({ subtitle: null }),
		);
		expect(parsed.success).toBe(true);
	});

	it("defaults the optional sections rather than requiring them", () => {
		const parsed = PublishingBlogPostSchema.safeParse({
			title: "A title",
			body: "Some body text.",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.categories).toEqual([]);
			expect(parsed.data.keywords).toEqual([]);
			expect(parsed.data.inputsNeeded).toEqual([]);
			expect(parsed.data.safetyNote).toBeNull();
			expect(parsed.data.subtitle).toBeNull();
		}
	});

	it("has no options field — one post is the whole difference from a tweet", () => {
		const parsed = PublishingBlogPostSchema.safeParse(post());
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data).not.toHaveProperty("options");
		}
	});
});

describe("composeWorkingDraftBody", () => {
	it("carries the title into the editable text", () => {
		// The title is a separate FIELD so the panel can show it without
		// parsing Markdown. If it did not also reach the body, the first thing
		// every author would do is retype their own headline.
		const body = composeWorkingDraftBody({
			title: "Faster incremental builds",
			subtitle: null,
			body: "Builds used to start cold.",
		});
		expect(body).toBe(
			"# Faster incremental builds\n\nBuilds used to start cold.",
		);
	});

	it("renders a subtitle as emphasis, not as a heading", () => {
		// A `##` subtitle competes with the post's own section headings in
		// every Markdown renderer, so the author would have to fix the outline
		// before publishing.
		const body = composeWorkingDraftBody({
			title: "T",
			subtitle: "A subtitle",
			body: "Text.",
		});
		expect(body).toBe("# T\n\n_A subtitle_\n\nText.");
		expect(body).not.toContain("## A subtitle");
	});

	it("omits a blank subtitle rather than emitting empty emphasis", () => {
		const body = composeWorkingDraftBody({
			title: "T",
			subtitle: "   ",
			body: "Text.",
		});
		expect(body).toBe("# T\n\nText.");
		expect(body).not.toContain("__");
	});

	it("leaves the publishing suggestions OUT of the editable text", () => {
		// The whole reason this prompt uses structured output. Categories and
		// keywords are advice to the publisher; inside the body they become
		// text the author deletes by hand after every regeneration.
		const body = composeWorkingDraftBody(post());
		expect(body).not.toContain("Toolchain");
		expect(body).not.toContain("ci-pipeline");
		expect(body).not.toContain("warm-start");
		expect(body).not.toMatch(/Suggested/i);
	});
});

describe("buildBlogPostLockedClauses", () => {
	it("asks for ONE post rather than a set of alternatives", () => {
		const clauses = buildBlogPostLockedClauses();
		expect(clauses).toMatch(/ONE post/);
	});

	it("keeps the suggestions out of the body, which no schema can enforce", () => {
		// The schema accepts a body containing "## Suggested Keywords" — it is
		// still a string. Only the prompt can prevent it.
		const clauses = buildBlogPostLockedClauses();
		expect(clauses).toMatch(/Suggested categories, suggested keywords/);
	});

	it("carries the approval rules FR28/FR29 turn on", () => {
		const clauses = buildBlogPostLockedClauses();
		expect(clauses).toMatch(/customer name/);
		expect(clauses).toMatch(/Do NOT invent facts/);
		expect(clauses).toMatch(/unshipped work has shipped/);
		expect(clauses).toMatch(/Do NOT publish, schedule or post/);
	});

	it("names the specific unresolved approvals when there are any", () => {
		const clauses = buildBlogPostLockedClauses([
			"Customer name: an example account",
		]);
		expect(clauses).toMatch(/Unresolved approvals for this topic/);
		expect(clauses).toContain("Customer name: an example account");
	});

	it("omits the restrictions block entirely when nothing is unresolved", () => {
		const clauses = buildBlogPostLockedClauses([]);
		expect(clauses).not.toMatch(/Unresolved approvals/);
	});

	it("ignores blank subjects rather than emitting an empty bullet", () => {
		const clauses = buildBlogPostLockedClauses(["  ", ""]);
		expect(clauses).not.toMatch(/Unresolved approvals/);
	});
});

describe("composeBlogPostPrompt", () => {
	const base = {
		topic: TOPIC,
		context: EMPTY_CONTEXT,
		planningAnalysis: null,
		decisions: [],
		guidance: null,
		restrictedSubjects: [],
	};

	it("renders the bound body and appends the locked clauses", async () => {
		const composed = await composeBlogPostPrompt({
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
		// MARKDOWN does no templating at all and reports NO error, so the
		// model would silently receive zero topic data.
		const composed = await composeBlogPostPrompt({
			...base,
			templateBody: "Write about {{{topic_title}}}.",
			format: "MARKDOWN",
		});
		expect(composed.formatOverridden).toBe(true);
		expect(composed.prompt).toContain("Faster incremental builds");
	});

	it("GUARD 2: recovers when the body did not render", async () => {
		const composed = await composeBlogPostPrompt({
			...base,
			templateBody: "Write about {{{topic_title}}",
			format: "HANDLEBARS",
		});
		expect(composed.bodyRecovered).toBe(true);
		expect(composed.prompt).toContain("Faster incremental builds");
	});

	it("GUARD 3: recovers when the body renders to nothing", async () => {
		// A falsy block parses, renders to "", and guard 2 cannot see it
		// precisely because nothing survived.
		const composed = await composeBlogPostPrompt({
			...base,
			templateBody: "{{#unknown}}text{{/unknown}}",
			format: "HANDLEBARS",
		});
		expect(composed.bodyRecovered).toBe(true);
		expect(composed.prompt).toContain("Faster incremental builds");
	});

	it("passes the restricted subjects through to the locked clauses", async () => {
		const composed = await composeBlogPostPrompt({
			...base,
			templateBody: "Write about {{{topic_title}}}.",
			format: "HANDLEBARS",
			restrictedSubjects: ["Metric: adoption rate"],
		});
		expect(composed.prompt).toContain("Metric: adoption rate");
	});

	it("carries the guidance and the confirmed decisions into the prompt", async () => {
		const composed = await composeBlogPostPrompt({
			...base,
			templateBody:
				"{{#if has_guidance}}{{{guidance}}}{{/if}}{{#if has_decisions}}{{{decisions}}}{{/if}}",
			format: "HANDLEBARS",
			guidance: "Aim it at platform teams.",
			decisions: [
				{
					subject: "Naming the customer",
					decisionKind: "OTHER",
					answer: "Keep it anonymous.",
				},
			],
		});
		expect(composed.prompt).toContain("Aim it at platform teams.");
		expect(composed.prompt).toContain("Keep it anonymous.");
	});

	it("says plainly when there is no source context at all", async () => {
		const composed = await composeBlogPostPrompt({
			...base,
			templateBody:
				"{{#if has_any_source_context}}has{{else}}none{{/if}}",
			format: "HANDLEBARS",
		});
		expect(composed.prompt).toContain("none");
	});
});
