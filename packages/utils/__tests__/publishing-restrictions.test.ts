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

	it("ignores a post type with no extra set", () => {
		// STAKEHOLDER_EMAIL's entry lands in a later slice; until it does, the
		// lookup must miss cleanly rather than throw or fall back to another
		// type's set.
		expect(
			restrictsPostType(
				thread({ decisionKind: "CLAIM_STRENGTH" }),
				"STAKEHOLDER_EMAIL",
			),
		).toBe(false);
		expect(
			EXTRA_RESTRICTING_KINDS_BY_POST_TYPE.STAKEHOLDER_EMAIL,
		).toBeUndefined();
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
