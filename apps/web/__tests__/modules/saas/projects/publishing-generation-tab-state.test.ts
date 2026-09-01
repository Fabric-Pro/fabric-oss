import {
	isRestrictingThread,
	normalizePostType,
	resolveGenerationTabStates,
	resolveRestrictions,
} from "@saas/projects/components/publishing-suite/generation-tab-state";
import type { PlanningAnalysisDocument } from "@saas/projects/components/publishing-suite/planning-analysis-content";
import { describe, expect, it } from "vitest";

/**
 * Generation tab states (Fizzy #1853, Phase 2B-1).
 *
 * Pure — no React, no network — because a resolver can be driven to every state
 * a component can only be coaxed into, and the states are where the bugs are.
 */

/** A Planning & Analysis document carrying only the contentTypes buckets. */
function analysisWith(
	buckets: Partial<
		Record<
			"recommended" | "needsConfirmation" | "deferred",
			{ type: string; rationale: string }[]
		>
	>,
): PlanningAnalysisDocument {
	const filled = (
		["recommended", "needsConfirmation", "deferred"] as const
	).flatMap((key) => {
		const items = buckets[key] ?? [];
		return items.length > 0 ? [{ key, label: key, items }] : [];
	});
	return {
		prose: [],
		keyDetails: [],
		buckets:
			filled.length > 0
				? [
						{
							key: "contentTypes",
							label: "Content types",
							buckets: filled,
						},
					]
				: [],
		sourceSignals: [],
		risks: [],
		questions: [],
		preDraftGuidance: null,
	};
}

const NO_RESTRICTIONS = { global: false, byPostType: new Set<string>() };

function statesFor(
	input: Parameters<typeof resolveGenerationTabStates>[0],
): Record<string, { state: string; needsAttention: boolean }> {
	const out: Record<string, { state: string; needsAttention: boolean }> = {};
	for (const tab of resolveGenerationTabStates(input)) {
		out[tab.postType] = {
			state: tab.state,
			needsAttention: tab.needsAttention,
		};
	}
	return out;
}

describe("normalizePostType", () => {
	it("maps the prompt's own phrasings onto the enum", () => {
		expect(normalizePostType("Short Post / Tweet")).toBe("TWEET");
		expect(normalizePostType("Tweet")).toBe("TWEET");
		expect(normalizePostType("short post")).toBe("TWEET");
		expect(normalizePostType("Blog Post")).toBe("BLOG_POST");
		expect(normalizePostType("blog")).toBe("BLOG_POST");
		expect(normalizePostType("Case Study")).toBe("CASE_STUDY");
		expect(normalizePostType("Stakeholder Email")).toBe(
			"STAKEHOLDER_EMAIL",
		);
	});

	it("ignores casing, punctuation and surrounding whitespace", () => {
		expect(normalizePostType("  BLOG-POST  ")).toBe("BLOG_POST");
		expect(normalizePostType("blog_post")).toBe("BLOG_POST");
		expect(normalizePostType("Case  Study.")).toBe("CASE_STUDY");
	});

	it("returns null for the content types this phase does not own", () => {
		// 2A's schema keeps `type` a free string on purpose: FR32's supported set
		// includes three types that are not in the enum, and narrowing it would
		// make the model drop them. Ignoring them here is the correct answer, not
		// a gap.
		expect(normalizePostType("Webinar/Demo Script")).toBeNull();
		expect(normalizePostType("Video Walkthrough Script")).toBeNull();
		expect(normalizePostType("Newsletter Blurb")).toBeNull();
		expect(normalizePostType("")).toBeNull();
	});

	it("never matches on a substring", () => {
		// "post" appears in "Blog Post" too. A substring rule would make the
		// blog tab claim to be a tweet.
		expect(normalizePostType("post")).toBeNull();
		expect(normalizePostType("study")).toBeNull();
		expect(normalizePostType("email")).toBeNull();
	});
});

describe("resolveGenerationTabStates — the four states", () => {
	it("is AVAILABLE for every type when no analysis has run", () => {
		const states = statesFor({
			analysis: null,
			generatedPostTypes: [],
			restrictions: NO_RESTRICTIONS,
		});

		// With no analysis there is no recommendation. Saying otherwise would
		// invent one.
		expect(states.TWEET.state).toBe("AVAILABLE");
		expect(states.BLOG_POST.state).toBe("AVAILABLE");
		expect(states.CASE_STUDY.state).toBe("AVAILABLE");
		expect(states.STAKEHOLDER_EMAIL.state).toBe("AVAILABLE");
	});

	it("is RECOMMENDED for a type the analysis recommends", () => {
		const states = statesFor({
			analysis: analysisWith({
				recommended: [{ type: "Blog Post", rationale: "why" }],
			}),
			generatedPostTypes: [],
			restrictions: NO_RESTRICTIONS,
		});

		expect(states.BLOG_POST.state).toBe("RECOMMENDED");
		expect(states.TWEET.state).toBe("AVAILABLE");
	});

	it("is NEEDS_CONFIRMATION for both the needsConfirmation and deferred buckets", () => {
		// The card enumerates ONE state covering both — "Deferred / Needs
		// Confirmation" — so the two buckets collapse.
		const states = statesFor({
			analysis: analysisWith({
				needsConfirmation: [{ type: "Tweet", rationale: "a" }],
				deferred: [{ type: "Case Study", rationale: "b" }],
			}),
			generatedPostTypes: [],
			restrictions: NO_RESTRICTIONS,
		});

		expect(states.TWEET.state).toBe("NEEDS_CONFIRMATION");
		expect(states.CASE_STUDY.state).toBe("NEEDS_CONFIRMATION");
	});

	it("is GENERATED when a READY draft exists", () => {
		const states = statesFor({
			analysis: null,
			generatedPostTypes: ["TWEET"],
			restrictions: NO_RESTRICTIONS,
		});

		expect(states.TWEET.state).toBe("GENERATED");
	});

	it("is GENERATED when only a WORKING draft exists", () => {
		// A user who saved a body has content for that type, whatever became of
		// the candidate it came from. Reading candidates only would leave the tab
		// claiming nothing exists while the user's own draft sits behind it.
		const states = statesFor({
			analysis: null,
			generatedPostTypes: ["BLOG_POST"],
			restrictions: NO_RESTRICTIONS,
		});

		expect(states.BLOG_POST.state).toBe("GENERATED");
	});
});

describe("resolveGenerationTabStates — precedence", () => {
	it("ranks GENERATED over NEEDS_CONFIRMATION over RECOMMENDED over AVAILABLE", () => {
		const states = statesFor({
			analysis: analysisWith({
				recommended: [
					{ type: "Tweet", rationale: "r" },
					{ type: "Blog Post", rationale: "r" },
				],
				needsConfirmation: [{ type: "Blog Post", rationale: "n" }],
			}),
			generatedPostTypes: ["TWEET"],
			restrictions: NO_RESTRICTIONS,
		});

		// TWEET is both recommended and generated -> GENERATED wins.
		expect(states.TWEET.state).toBe("GENERATED");
		// BLOG_POST is both recommended and needs-confirmation -> the cautious
		// bucket wins, so a type flagged for approval is never promoted with a
		// star by the same analysis that flagged it.
		expect(states.BLOG_POST.state).toBe("NEEDS_CONFIRMATION");
		expect(states.CASE_STUDY.state).toBe("AVAILABLE");
	});
});

describe("resolveGenerationTabStates — needsAttention", () => {
	it("stays true for a GENERATED type the analysis deferred", () => {
		// THE load-bearing case. `GENERATED` outranks `NEEDS_CONFIRMATION`, so
		// without an independent marker the tab would stop warning the moment a
		// draft existed — and 2A mints NO question for `deferred`
		// (`resolveConfirmationQuestions` derives only from `needsConfirmation`
		// and `requiresApproval`), so a marker keyed on open questions alone
		// would show nothing here at all.
		const states = statesFor({
			analysis: analysisWith({
				deferred: [{ type: "Blog Post", rationale: "not yet" }],
			}),
			generatedPostTypes: ["BLOG_POST"],
			restrictions: NO_RESTRICTIONS,
		});

		expect(states.BLOG_POST.state).toBe("GENERATED");
		expect(states.BLOG_POST.needsAttention).toBe(true);
	});

	it("stays true for a GENERATED type the analysis flagged for confirmation", () => {
		const states = statesFor({
			analysis: analysisWith({
				needsConfirmation: [{ type: "Tweet", rationale: "approve?" }],
			}),
			generatedPostTypes: ["TWEET"],
			restrictions: NO_RESTRICTIONS,
		});

		expect(states.TWEET.state).toBe("GENERATED");
		expect(states.TWEET.needsAttention).toBe(true);
	});

	it("is true from an open restricting question even with no analysis bucket", () => {
		// The other arm of the disjunction. A test for one arm alone passes
		// against an implementation that only has that arm.
		const states = statesFor({
			analysis: null,
			generatedPostTypes: [],
			restrictions: { global: true, byPostType: new Set<string>() },
		});

		expect(states.TWEET.state).toBe("AVAILABLE");
		expect(states.TWEET.needsAttention).toBe(true);
		expect(states.BLOG_POST.needsAttention).toBe(true);
	});

	it("is true for only the post type a CONTENT_TYPE question names", () => {
		const states = statesFor({
			analysis: null,
			generatedPostTypes: [],
			restrictions: { global: false, byPostType: new Set(["BLOG_POST"]) },
		});

		expect(states.BLOG_POST.needsAttention).toBe(true);
		expect(states.TWEET.needsAttention).toBe(false);
	});

	it("is false when nothing is outstanding", () => {
		const states = statesFor({
			analysis: analysisWith({
				recommended: [{ type: "Tweet", rationale: "r" }],
			}),
			generatedPostTypes: [],
			restrictions: NO_RESTRICTIONS,
		});

		expect(states.TWEET.needsAttention).toBe(false);
	});
});

describe("resolveGenerationTabStates — rationale for the panel", () => {
	it("carries the analysis's own rationale and bucket (FR6/FR7)", () => {
		const tabs = resolveGenerationTabStates({
			analysis: analysisWith({
				recommended: [
					{ type: "Blog Post", rationale: "the work is explainable" },
				],
			}),
			generatedPostTypes: [],
			restrictions: NO_RESTRICTIONS,
		});
		const blog = tabs.find((t) => t.postType === "BLOG_POST");

		expect(blog?.rationale).toBe("the work is explainable");
		expect(blog?.bucket).toBe("recommended");
	});

	it("leaves rationale null for a type the analysis never mentions", () => {
		const tabs = resolveGenerationTabStates({
			analysis: analysisWith({
				recommended: [{ type: "Blog Post", rationale: "r" }],
			}),
			generatedPostTypes: [],
			restrictions: NO_RESTRICTIONS,
		});
		const tweet = tabs.find((t) => t.postType === "TWEET");

		expect(tweet?.rationale).toBeNull();
		expect(tweet?.bucket).toBeNull();
	});
});

describe("resolveRestrictions", () => {
	const thread = (over: Record<string, unknown>) => ({
		root: {
			id: "r",
			parentId: null,
			kind: "QUESTION" as const,
			status: "OPEN",
			authorType: "AGENT" as const,
			authorUserId: null,
			questionId: "q",
			decisionKind: null,
			subject: null,
			summary: null,
			content: null,
			recommendedResponse: null,
			whyItMatters: null,
			answerSource: null,
			analysisVersion: null,
			createdAt: new Date(),
			...over,
		},
		replies: [],
	});

	it("treats a safety-critical open question as restricting every type", () => {
		// An unapproved customer name or metric is not about one content type —
		// it constrains anything generated from this topic.
		for (const kind of [
			"CUSTOMER_NAME",
			"ASSET_APPROVAL",
			"METRICS_APPROVAL",
			"INTERNAL_UI",
			"VIDEO_WALKTHROUGH",
		]) {
			const r = resolveRestrictions([thread({ decisionKind: kind })]);
			expect(r.global).toBe(true);
		}
	});

	it("scopes a CONTENT_TYPE question to the post type its subject names", () => {
		const r = resolveRestrictions([
			thread({ decisionKind: "CONTENT_TYPE", subject: "Blog Post" }),
		]);

		expect(r.global).toBe(false);
		expect([...r.byPostType]).toEqual(["BLOG_POST"]);
	});

	it("fails SAFE when a CONTENT_TYPE question's subject cannot be mapped", () => {
		// `subject` is free text. A real decision phrased in a way the synonym
		// map has not seen would otherwise resolve to null and be dropped —
		// turning an unresolved approval into no warning at all. Restricting
		// every type over-warns; dropping it under-warns, and only one of those
		// lets a draft assert something nobody approved.
		const r = resolveRestrictions([
			thread({
				decisionKind: "CONTENT_TYPE",
				subject: "an unusual phrasing nobody listed",
			}),
		]);

		expect(r.global).toBe(true);
	});

	it("still scopes precisely when the subject IS mappable", () => {
		// The fail-safe above must not swallow the precise path: a recognised
		// subject restricts ONE type, not all four.
		const r = resolveRestrictions([
			thread({ decisionKind: "CONTENT_TYPE", subject: "Case Study" }),
		]);

		expect(r.global).toBe(false);
		expect([...r.byPostType]).toEqual(["CASE_STUDY"]);
	});

	it("ignores questions that are already answered", () => {
		// A resolved decision is not a restriction. Counting one would make the
		// warning permanent and teach the reader to ignore it.
		const r = resolveRestrictions([
			thread({ decisionKind: "CUSTOMER_NAME", status: "RESOLVED" }),
		]);

		expect(r.global).toBe(false);
	});

	it("ignores AI_UPDATE notes, which are not questions", () => {
		const r = resolveRestrictions([
			thread({ kind: "AI_UPDATE", decisionKind: "CUSTOMER_NAME" }),
		]);

		expect(r.global).toBe(false);
	});

	it("isRestrictingThread judges each thread on its OWN kind", () => {
		// A per-thread predicate, never a property of the set. The aggregated
		// `global` flag says "something restricts everything"; it says nothing
		// about whether THIS thread is one of them.
		expect(
			isRestrictingThread(thread({ decisionKind: "CUSTOMER_NAME" })),
		).toBe(true);
		expect(
			isRestrictingThread(thread({ decisionKind: "CONTENT_TYPE" })),
		).toBe(true);
		expect(
			isRestrictingThread(thread({ decisionKind: "AUTHORSHIP" })),
		).toBe(false);
		expect(
			isRestrictingThread(thread({ decisionKind: "AUDIENCE_SCOPE" })),
		).toBe(false);
		// Status and kind still gate it.
		expect(
			isRestrictingThread(
				thread({ decisionKind: "CUSTOMER_NAME", status: "RESOLVED" }),
			),
		).toBe(false);
		expect(
			isRestrictingThread(
				thread({ kind: "AI_UPDATE", decisionKind: "CUSTOMER_NAME" }),
			),
		).toBe(false);
	});

	it("fails safe for a CONTENT_TYPE question carrying no subject at all", () => {
		// Restricting by kind, but naming nothing to scope to. Dropping it
		// would lose the restriction; scoping it to nothing would too.
		const r = resolveRestrictions([
			thread({ decisionKind: "CONTENT_TYPE", subject: null }),
		]);

		expect(r.global).toBe(true);
	});

	it("ignores an open question of a non-restricting kind", () => {
		const r = resolveRestrictions([thread({ decisionKind: "AUTHORSHIP" })]);

		expect(r.global).toBe(false);
		expect(r.byPostType.size).toBe(0);
	});
});
