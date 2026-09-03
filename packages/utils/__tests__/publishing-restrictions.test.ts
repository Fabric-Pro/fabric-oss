import { describe, expect, it } from "vitest";
import {
	EXTRA_RESTRICTING_KINDS_BY_POST_TYPE,
	isRestrictingThread,
	type RestrictionThreadRoot,
	restrictsPostType,
} from "../lib/publishing-restrictions";

/**
 * Per-post-type restrictions (Fizzy #1854, Publishing Suite Phase 2C).
 *
 * The load-bearing case here is a NEGATIVE one: the same open `CLAIM_STRENGTH`
 * question must restrict a Case Study and leave a Tweet alone. A suite that only
 * asserts the positive would pass just as happily against a `restrictsPostType`
 * that ignored `postType` entirely and restricted everything.
 */

const thread = (
	over: Partial<RestrictionThreadRoot["root"]>,
): RestrictionThreadRoot => ({
	root: {
		kind: "QUESTION",
		status: "OPEN",
		decisionKind: null,
		subject: null,
		...over,
	},
});

describe("restrictsPostType", () => {
	it("restricts a Case Study on an open claim-strength question", () => {
		// "Is this result strong enough to claim?" is the question a case
		// study is built around — it cannot be left open and written past.
		expect(
			restrictsPostType(
				thread({ decisionKind: "CLAIM_STRENGTH" }),
				"CASE_STUDY",
			),
		).toBe(true);
	});

	it("leaves a Tweet alone on that same question", () => {
		// THE control. A tweet that may not yet claim the number just does not
		// mention it, so the question does not constrain the draft. If this
		// ever goes green as `true`, the extra set has stopped being per-type
		// and has silently become a second global set.
		expect(
			restrictsPostType(
				thread({ decisionKind: "CLAIM_STRENGTH" }),
				"TWEET",
			),
		).toBe(false);
	});

	it("leaves a Blog Post alone on that same question", () => {
		expect(
			restrictsPostType(
				thread({ decisionKind: "CLAIM_STRENGTH" }),
				"BLOG_POST",
			),
		).toBe(false);
	});

	it("restricts every type on a shared safety-critical kind", () => {
		// The additive half must not have displaced the shared half: an
		// unapproved customer name is a fact no format may assert.
		expect(
			restrictsPostType(
				thread({ decisionKind: "CUSTOMER_NAME" }),
				"TWEET",
			),
		).toBe(true);
		expect(
			restrictsPostType(
				thread({ decisionKind: "CUSTOMER_NAME" }),
				"CASE_STUDY",
			),
		).toBe(true);
	});

	it("restricts a Case Study on audience scope and codebase detail too", () => {
		for (const kind of ["AUDIENCE_SCOPE", "CODEBASE_DETAIL"]) {
			expect(
				restrictsPostType(thread({ decisionKind: kind }), "CASE_STUDY"),
			).toBe(true);
			expect(
				restrictsPostType(thread({ decisionKind: kind }), "TWEET"),
			).toBe(false);
		}
	});

	it("ignores an answered claim-strength decision", () => {
		// An answered decision is not a restriction. Counting one would make
		// the caution permanent and teach its reader to ignore it.
		for (const status of ["ANSWERED", "RESOLVED"]) {
			expect(
				restrictsPostType(
					thread({ decisionKind: "CLAIM_STRENGTH", status }),
					"CASE_STUDY",
				),
			).toBe(false);
		}
	});

	it("ignores an AI_UPDATE carrying a claim-strength kind", () => {
		// A note, not a question — nobody has been asked to decide anything.
		expect(
			restrictsPostType(
				thread({ kind: "AI_UPDATE", decisionKind: "CLAIM_STRENGTH" }),
				"CASE_STUDY",
			),
		).toBe(false);
	});

	it("ignores a kind in no set at all", () => {
		expect(
			restrictsPostType(
				thread({ decisionKind: "AUTHORSHIP" }),
				"CASE_STUDY",
			),
		).toBe(false);
	});

	it("ignores a post type with no extra set at all", () => {
		// Two of the four types have no entry, and the lookup must MISS cleanly
		// for them rather than throw or fall back to a neighbour's set. Asserted
		// on TWEET now that STAKEHOLDER_EMAIL has an entry of its own — the case
		// this replaces used STAKEHOLDER_EMAIL for exactly this purpose, and
		// leaving it there would have turned a real guarantee into a stale
		// assertion about a type that has since acquired a set.
		expect(
			restrictsPostType(
				thread({ decisionKind: "CLAIM_STRENGTH" }),
				"TWEET",
			),
		).toBe(false);
		expect(EXTRA_RESTRICTING_KINDS_BY_POST_TYPE.TWEET).toBeUndefined();
		expect(EXTRA_RESTRICTING_KINDS_BY_POST_TYPE.BLOG_POST).toBeUndefined();
	});

	it("misses cleanly on a post type nobody has heard of", () => {
		// A `Record<string, …>` lookup on an unknown key returns undefined, and
		// the guard for that is what stops a future post type — or a typo at a
		// call site — throwing inside a prompt build.
		expect(
			restrictsPostType(
				thread({ decisionKind: "CLAIM_STRENGTH" }),
				"NOT_A_POST_TYPE",
			),
		).toBe(false);
	});
});

describe("restrictsPostType — Stakeholder Email (Phase 2C slice 2)", () => {
	it("restricts on audience scope and claim strength", () => {
		// An email is ADDRESSED: leadership, a client sponsor and the delivery
		// team need different things said about the same work, so an unsettled
		// AUDIENCE_SCOPE question is a decision about the whole message rather
		// than a detail to omit. CLAIM_STRENGTH decides whether the "why it
		// matters" paragraph may assert a result or has to describe one.
		for (const kind of ["AUDIENCE_SCOPE", "CLAIM_STRENGTH"]) {
			expect(
				restrictsPostType(
					thread({ decisionKind: kind }),
					"STAKEHOLDER_EMAIL",
				),
			).toBe(true);
		}
	});

	it("leaves a Tweet and a Blog Post alone on those same questions", () => {
		// THE control, in the same shape the Case Study's has. Without it, a
		// `restrictsPostType` that ignored `postType` and restricted everything
		// would satisfy the positive case above.
		for (const kind of ["AUDIENCE_SCOPE", "CLAIM_STRENGTH"]) {
			expect(
				restrictsPostType(thread({ decisionKind: kind }), "TWEET"),
			).toBe(false);
			expect(
				restrictsPostType(thread({ decisionKind: kind }), "BLOG_POST"),
			).toBe(false);
		}
	});

	it("does NOT restrict on codebase detail, unlike the case study", () => {
		// The deliberate difference between the two 2C sets, and the case that
		// pins it as a decision rather than an omission. An email to a sponsor
		// is not where a codebase detail leaks — the format pushes toward
		// business value already, and the disclosure rule in the locked clauses
		// covers the residue. Listing it would add a third entry to "open
		// questions that constrain this type" on nearly every technical topic,
		// for a risk this format does not run, and over-warning is how a reader
		// learns to skip the two warnings that do apply.
		expect(
			restrictsPostType(
				thread({ decisionKind: "CODEBASE_DETAIL" }),
				"STAKEHOLDER_EMAIL",
			),
		).toBe(false);
		// …while the case study, which describes the implementation, still does.
		expect(
			restrictsPostType(
				thread({ decisionKind: "CODEBASE_DETAIL" }),
				"CASE_STUDY",
			),
		).toBe(true);
	});

	it("still restricts on every shared safety-critical kind", () => {
		// The additive half must not have displaced the shared half.
		for (const kind of [
			"CUSTOMER_NAME",
			"ASSET_APPROVAL",
			"METRICS_APPROVAL",
			"INTERNAL_UI",
			"VIDEO_WALKTHROUGH",
			"CONTENT_TYPE",
		]) {
			expect(
				restrictsPostType(
					thread({ decisionKind: kind }),
					"STAKEHOLDER_EMAIL",
				),
			).toBe(true);
		}
	});

	it("ignores an answered audience-scope decision", () => {
		for (const status of ["ANSWERED", "RESOLVED"]) {
			expect(
				restrictsPostType(
					thread({ decisionKind: "AUDIENCE_SCOPE", status }),
					"STAKEHOLDER_EMAIL",
				),
			).toBe(false);
		}
	});

	it("ignores an AI_UPDATE carrying an audience-scope kind", () => {
		expect(
			restrictsPostType(
				thread({ kind: "AI_UPDATE", decisionKind: "AUDIENCE_SCOPE" }),
				"STAKEHOLDER_EMAIL",
			),
		).toBe(false);
	});
});

describe("isRestrictingThread is unchanged by the per-type set", () => {
	it("still says no to AUDIENCE_SCOPE", () => {
		// It means "restricts EVERY content type", and Tweet and Blog Post
		// depend on that meaning. The new behaviour is additive and lives in
		// `restrictsPostType`; widening this predicate would have been the
		// tempting shortcut and would have quietly cautioned every tab.
		expect(
			isRestrictingThread(thread({ decisionKind: "AUDIENCE_SCOPE" })),
		).toBe(false);
		expect(
			isRestrictingThread(thread({ decisionKind: "CLAIM_STRENGTH" })),
		).toBe(false);
		expect(
			isRestrictingThread(thread({ decisionKind: "CODEBASE_DETAIL" })),
		).toBe(false);
		// ...while the shared kinds are untouched.
		expect(
			isRestrictingThread(thread({ decisionKind: "CUSTOMER_NAME" })),
		).toBe(true);
		expect(
			isRestrictingThread(thread({ decisionKind: "CONTENT_TYPE" })),
		).toBe(true);
	});
});
