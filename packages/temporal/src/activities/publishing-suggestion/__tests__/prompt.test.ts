/**
 * Topic Suggestion prompt composition (Fizzy #1851, FR7).
 *
 * The body is org-editable through the Prompt Library; the grounding rules, the
 * output contract and the source context are not. What is worth pinning is that
 * boundary — an override that drops a grounding rule must not be able to take
 * it off the wire — plus the guards that decide when a bound body is unusable.
 */
import { PUBLISHING_TOPIC_SUGGESTION_FALLBACK_BODY } from "@repo/utils/publishing-suggestion-prompt";
import { describe, expect, it } from "vitest";
import {
	buildTopicSuggestionLockedClauses,
	composeTopicSuggestionPrompt,
	stripPrAuthorGithubIdsForPrompt,
} from "../prompt";

const compose = (
	context: unknown,
	templateBody = PUBLISHING_TOPIC_SUGGESTION_FALLBACK_BODY,
	format: "HANDLEBARS" | "MARKDOWN" | "PLAIN_TEXT" = "HANDLEBARS",
) => composeTopicSuggestionPrompt({ templateBody, format, context });

describe("composeTopicSuggestionPrompt — role-aware fields", () => {
	it("instructs postTypeRecommendations with type/theme/rationale", async () => {
		const { prompt } = await compose({ stories: [] });
		expect(prompt).toContain("postTypeRecommendations");
		expect(prompt).toContain("theme");
		expect(prompt).toContain("rationale");
	});

	it("instructs relevantFunctionTags with the FunctionTag whitelist", async () => {
		const { prompt } = await compose({ stories: [] });
		expect(prompt).toContain("relevantFunctionTags");
		expect(prompt).toContain("DEVELOPER");
	});

	it("no longer instructs a bare suggestedPostTypes array", async () => {
		const { prompt } = await compose({ stories: [] });
		expect(prompt).not.toContain('"suggestedPostTypes"');
	});

	it("instructs the model to emit a short topic angle", async () => {
		const { prompt } = await compose({ stories: [] });
		expect(prompt).toContain('"angle"');
	});
});

describe("composeTopicSuggestionPrompt — what an override cannot remove", () => {
	// The whole point of moving this prompt into the library. An org retuning
	// what counts as newsworthy must not be able to delete the sentence that
	// keeps a pitch attached to the project's actual work — content drifting
	// off its topic is the one confirmed correctness bug in this feature, and
	// `topic.pitch` is what every downstream draft is built from.
	const OVERRIDE = "Find things to write about.";

	it("appends the grounding rules to a body that contains none of them", async () => {
		const { prompt } = await compose({ stories: [] }, OVERRIDE);

		expect(prompt).toContain(
			"Ground every claim in the given context — never invent details, numbers, or outcomes that are not present.",
		);
		expect(prompt).toContain("Do not fabricate a topic to fill space.");
		expect(prompt).toContain(
			"Never cite an id, PR number, or repo name that does not appear verbatim in the context below.",
		);
		expect(prompt).toContain("Return ONLY the topics");
	});

	it("appends the CONTEXT block to a body that never mentions it", async () => {
		// The context is code-side rather than a `{{{context}}}` slot precisely
		// so no edit can leave the model with instructions and no data — a
		// prompt that renders cleanly, passes every guard, and returns a full
		// set of invented topics.
		const { prompt } = await compose(
			{ stories: [{ id: "story-7", title: "Onboarding" }] },
			OVERRIDE,
		);

		expect(prompt).toContain("CONTEXT:");
		expect(prompt).toContain('"story-7"');
		expect(prompt.indexOf("CONTEXT:")).toBeGreaterThan(
			prompt.indexOf(OVERRIDE),
		);
	});

	it("keeps the locked clauses ahead of the context they refer to", async () => {
		// "…does not appear verbatim in the context below" is only true while
		// the context is genuinely below it.
		const { prompt } = await compose({ stories: [] });
		expect(
			prompt.indexOf("## Rules that override anything above"),
		).toBeLessThan(prompt.indexOf("CONTEXT:"));
	});
});

describe("composeTopicSuggestionPrompt — render guards", () => {
	it("reports nothing recovered for the default body", async () => {
		const result = await compose({ stories: [] });
		expect(result.bodyRecovered).toBe(false);
		expect(result.formatOverridden).toBe(false);
	});

	it("falls back to the default body when the bound one renders blank", async () => {
		// `{{#unknown}}x{{/unknown}}` is a falsy block, not a syntax error: it
		// parses, renders to "", and leaves the model with the locked clauses
		// and the context but no instructions at all — from which it would
		// still return a plausible set of topics.
		const result = await compose(
			{ stories: [] },
			"{{#unknown}}Find things to write about.{{/unknown}}",
		);

		expect(result.bodyRecovered).toBe(true);
		expect(result.prompt).toContain("publishing-worthy TOPICS");
	});

	it("falls back to the default body when the bound one will not parse", async () => {
		const result = await compose({ stories: [] }, "{{#if unclosed}}oops");

		expect(result.bodyRecovered).toBe(true);
		expect(result.prompt).toContain("publishing-worthy TOPICS");
	});

	it("renders a non-templating format as Handlebars and says so", async () => {
		const result = await compose({ stories: [] }, "Body.", "MARKDOWN");

		expect(result.formatOverridden).toBe(true);
		expect(result.bodyRecovered).toBe(false);
		expect(result.prompt).toContain("Body.");
	});
});

describe("buildTopicSuggestionLockedClauses", () => {
	it("is not present in the editable body it is appended to", async () => {
		// If a clause were in both, an org deleting it from the body would look
		// like it had been removed while the code-side copy still shipped —
		// and the next person would delete the code-side one to "fix" that.
		const sentences = buildTopicSuggestionLockedClauses()
			.split("\n")
			.filter((l) => l.startsWith("- ") || l.startsWith("Return ONLY"))
			.map((l) => l.replace(/^- /, ""));

		expect(sentences.length).toBeGreaterThan(0);
		for (const sentence of sentences) {
			expect(PUBLISHING_TOPIC_SUGGESTION_FALLBACK_BODY).not.toContain(
				sentence,
			);
		}
	});
});

describe("stripPrAuthorGithubIdsForPrompt (Copilot #2148)", () => {
	it("removes authorGithubId from pullRequests items while preserving other fields", () => {
		const out = stripPrAuthorGithubIdsForPrompt({
			pullRequests: [
				{ repoFullName: "o/r", prNumber: 1, authorGithubId: "583231" },
				{ repoFullName: "o/r", prNumber: 2 },
			],
		});
		expect(out.pullRequests).toEqual([
			{ repoFullName: "o/r", prNumber: 1 },
			{ repoFullName: "o/r", prNumber: 2 },
		]);
	});

	it("leaves non-pullRequests context keys untouched", () => {
		const stories = [{ id: "s1", title: "T" }];
		const out = stripPrAuthorGithubIdsForPrompt({
			stories,
			pullRequests: [],
		});
		expect(out.stories).toBe(stories);
	});

	it("returns the context unchanged when pullRequests is not an array", () => {
		const ctx = { pullRequests: "not-an-array" as unknown };
		expect(stripPrAuthorGithubIdsForPrompt(ctx)).toBe(ctx);
	});

	it("is non-mutating — the input item still carries authorGithubId", () => {
		const item = {
			repoFullName: "o/r",
			prNumber: 1,
			authorGithubId: "583231",
		};
		stripPrAuthorGithubIdsForPrompt({ pullRequests: [item] });
		expect(item.authorGithubId).toBe("583231");
	});

	it("keeps the numeric id out of the serialized prompt CONTEXT", async () => {
		const stripped = stripPrAuthorGithubIdsForPrompt({
			pullRequests: [
				{ repoFullName: "o/r", prNumber: 1, authorGithubId: "583231" },
			],
		});
		const { prompt } = await compose(stripped);
		expect(prompt).not.toContain("authorGithubId");
		expect(prompt).not.toContain("583231");
	});
});
