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

/** A minimal OPEN CONTENT_TYPE question naming `subject`, for `resolveRestrictions`. */
function openContentTypeThread(subject: string) {
	return {
		root: {
			kind: "QUESTION",
			status: "OPEN",
			decisionKind: "CONTENT_TYPE",
			subject,
		},
	};
}

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

	it("maps every LinkedIn phrasing, however the table spells it", () => {
		expect(normalizePostType("LinkedIn Post")).toBe("LINKEDIN_POST");
		expect(normalizePostType("LinkedIn")).toBe("LINKEDIN_POST");
		// The synonym table stores this one SPACED, unlike its neighbours, so
		// the source never carries a 14-character run beside the word
		// "linkedin" — that shape is gitleaks' `linkedin-client-id` rule, and
		// the OSS publication gate scans with a default config that has no
		// allowlist and never reads this repo's `.gitleaks.toml`. The entries
		// are normalized when the lookup map is built, so spelling one with a
		// space must not change what it resolves to. This case is what says so.
		expect(normalizePostType("LinkedIn Update")).toBe("LINKEDIN_POST");
		expect(normalizePostType("linkedin update")).toBe("LINKEDIN_POST");
		expect(normalizePostType("linkedin-update")).toBe("LINKEDIN_POST");
	});

	it("returns null for the content types this phase does not own", () => {
		// 2A's schema keeps `type` a free string on purpose: FR32's supported set
		// has nine types. #1988 (Phase 2D-1) brought Webinar / Demo Script into
		// the owned set (see the describe block below), leaving three — Video
		// Walkthrough Script, Newsletter Blurb and AI-assisted Video Walkthrough
		// — that this phase still does not own, and narrowing the schema to the
		// enum would make the model drop them. Ignoring them here is the
		// correct answer, not a gap.
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

describe("WEBINAR_SCRIPT synonyms (Fizzy #1988, Phase 2D-1)", () => {
	// Widening `SYNONYMS` changes two shipped surfaces at once —
	// `resolveRestrictions`'s CONTENT_TYPE scoping and
	// `resolveGenerationTabStates`'s bucket lookup — and no existing test
	// caught either, because the existing fail-safe case (below) uses a
	// subject that stays unmapped throughout.
	it("maps the exact label the LLM is whitelisted to emit for this type", () => {
		// "Webinar / Demo Script" (`publishing-suite-schema.ts`'s
		// `POST_TYPE_LABELS`) is the exact label the LLM is whitelisted to emit
		// for this content type, and it normalizes to this slash form. This
		// mapped to null before this phase owned the type; restoring it flipped
		// is the point — the earlier assertion was deleted rather than inverted
		// when `WEBINAR_SCRIPT` joined the enum.
		expect(normalizePostType("Webinar/Demo Script")).toBe("WEBINAR_SCRIPT");
	});

	it("maps the bare 'Demo Script' synonym", () => {
		// The second `SYNONYMS` entry ("demoscript") had no case of its own
		// anywhere in this suite before this one.
		expect(normalizePostType("Demo Script")).toBe("WEBINAR_SCRIPT");
	});

	/**
	 * `CONTENT_TYPE` no longer restricts anything, webinar included.
	 *
	 * These two arrived with the sixth content type and were correct against
	 * the predicate as it stood: an unmapped subject hit the fail-safe and
	 * warned on every tab, and the synonym widening narrowed that to the one
	 * tab it named. Both are moot now — the kind was removed from
	 * `isRestrictingThread` entirely, because the inline checklist replaced
	 * these questions and the panel filters every one of them out of the list a
	 * reader can answer. A legacy row was cautioning tabs with nothing behind
	 * them and no way to clear it.
	 *
	 * Kept and inverted rather than deleted: reintroducing the caution is the
	 * failure mode, so it wants a test that fails if anyone does. The synonym
	 * widening itself still has coverage — `normalizePostType("Demo Script")`
	 * above, and the bucket case below.
	 */
	it("does not restrict on a webinar CONTENT_TYPE question", () => {
		const r = resolveRestrictions([
			openContentTypeThread("Webinar Script"),
		]);

		expect(r.global).toBe(false);
		expect(r.byPostType.has("WEBINAR_SCRIPT")).toBe(false);
	});

	it("does not fail safe for a phrasing nobody listed either", () => {
		// This one used to escalate to every tab. A row nobody can answer must
		// not be able to caution the whole page, in any phrasing.
		const r = resolveRestrictions([
			openContentTypeThread("an unusual phrasing nobody listed"),
		]);

		expect(r.global).toBe(false);
	});

	it("resolves the bucket for an analysis written before the type existed", () => {
		// The second call site the widening reaches: `readContentTypeBuckets`,
		// via `resolveGenerationTabStates`. Stored analyses already name
		// "Webinar or Demo Script" — the planning prompt's own phrasing — so
		// they populate the new tab's badge retroactively rather than leaving
		// it stuck on AVAILABLE forever.
		const tabs = resolveGenerationTabStates({
			analysis: analysisWith({
				deferred: [
					{ type: "Webinar or Demo Script", rationale: "not yet" },
				],
			}),
			generatedPostTypes: [],
			restrictions: NO_RESTRICTIONS,
		});

		expect(tabs.find((t) => t.postType === "WEBINAR_SCRIPT")?.bucket).toBe(
			"deferred",
		);
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

	/**
	 * A legacy `CONTENT_TYPE` thread must restrict NOTHING.
	 *
	 * These three cases asserted the opposite, and were correct when written:
	 * the topic asked "should we produce a Blog Post?" as a question, and an
	 * unanswered one held the tab. The contract moved when the inline checklist
	 * replaced those questions and the panel began filtering every
	 * `CONTENT_TYPE` row out of the answerable list at any status — but nothing
	 * updated the restriction predicate, so rows written before that change
	 * kept holding tabs with no question behind them and no way to clear it.
	 *
	 * Inverted rather than deleted: the failure mode is reintroducing the
	 * caution, so it wants a test that fails if anyone does.
	 */
	it("does not restrict on a legacy CONTENT_TYPE thread", () => {
		const r = resolveRestrictions([
			thread({ decisionKind: "CONTENT_TYPE", subject: "Blog Post" }),
		]);

		expect(r.global).toBe(false);
		expect([...r.byPostType]).toEqual([]);
	});

	it("does not fail safe on an unmappable CONTENT_TYPE subject either", () => {
		// The old fail-safe escalated an unrecognised subject to EVERY tab.
		// That was the right call while the question was answerable and the
		// worst one after: one legacy row cautioned the whole page forever.
		const r = resolveRestrictions([
			thread({
				decisionKind: "CONTENT_TYPE",
				subject: "an unusual phrasing nobody listed",
			}),
		]);

		expect(r.global).toBe(false);
		expect([...r.byPostType]).toEqual([]);
	});

	it("still restricts on the safety-critical kinds beside it", () => {
		// The removal is scoped to one kind. An unapproved customer name is
		// still a fact no draft may assert, and still holds every type.
		const r = resolveRestrictions([
			thread({ decisionKind: "CONTENT_TYPE", subject: "Case Study" }),
			thread({ decisionKind: "CUSTOMER_NAME" }),
		]);

		expect(r.global).toBe(true);
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
		).toBe(false);
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

	it("ignores a CONTENT_TYPE question carrying no subject at all", () => {
		// This one used to escalate to every tab. A row nobody can answer must
		// not be able to caution the whole page.
		const r = resolveRestrictions([
			thread({ decisionKind: "CONTENT_TYPE", subject: null }),
		]);

		expect(r.global).toBe(false);
	});

	it("ignores an open question of a non-restricting kind", () => {
		const r = resolveRestrictions([thread({ decisionKind: "AUTHORSHIP" })]);

		expect(r.global).toBe(false);
		expect(r.byPostType.size).toBe(0);
	});

	// #1854 (2C). The BADGE half of the per-type restriction set.
	//
	// `GenerationPanel` builds its own per-panel LIST from `restrictsPostType`;
	// this is the other half, and neither substitutes for the other. Shipping
	// only the list left the panel warning about an open CLAIM_STRENGTH question
	// while the tab strip beside it read a plain "Available" — under-warning at
	// the one level whose stated purpose is to be seen on a tab the reader has
	// NOT opened.
	it("marks a CASE_STUDY-only kind on the badge, and only for that type", () => {
		const r = resolveRestrictions([
			thread({ decisionKind: "CLAIM_STRENGTH" }),
		]);

		expect(r.byPostType.has("CASE_STUDY")).toBe(true);
		// The negative control that makes the assertion above mean something:
		// a widened SHARED set would light every tab, which is what the
		// per-type set exists to avoid.
		expect(r.byPostType.has("TWEET")).toBe(false);
		expect(r.byPostType.has("BLOG_POST")).toBe(false);
		// Not global either — `isRestrictingThread` is deliberately unchanged.
		expect(r.global).toBe(false);
	});

	it("still marks a shared safety-critical kind for every type", () => {
		const r = resolveRestrictions([
			thread({ decisionKind: "CUSTOMER_NAME" }),
		]);

		expect(r.global).toBe(true);
	});
});
