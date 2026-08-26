/**
 * A case an adversarial lens invented arrives as PROPOSED, not DRAFT.
 *
 * Sceptic roles were already consumed — they shape the drafting prompt via
 * `describeQaPolicy` — but every case the model returned was forced to `DRAFT`,
 * so an AI's speculative suggestion joined the suite on equal footing with a
 * case the acceptance criteria actually asked for. The mocks (B4) ask for those
 * to be accepted or rejected first, and `TestCaseState` had no state to say so.
 *
 * The distinction has teeth beyond presentation: PROPOSED is excluded from the
 * coverage count, so a project's "tested by N cases" cannot rise merely because
 * something was suggested.
 */

import { describe, expect, it } from "vitest";
import { normalizeDraftedTestCases } from "../lib/prompts/test-case-drafting";

/** One well-formed case, so only the field under test varies. */
function rawCase(extra: Record<string, unknown> = {}) {
	return {
		title: "Reject a discount that would make the total negative",
		preconditions: "A cart with a £10 subtotal",
		acceptanceCriterionRef: "AC 2",
		priority: "HIGH",
		steps: [
			{ action: "Apply a 200% discount", expected: "Total clamps to 0" },
		],
		...extra,
	};
}

describe("drafted case state", () => {
	it("marks a sceptic-authored case PROPOSED", () => {
		const [c] = normalizeDraftedTestCases({
			testCases: [rawCase({ scepticRole: "security" })],
		});

		expect(c.state).toBe("PROPOSED");
		expect(c.scepticRole).toBe("security");
	});

	it("leaves an ordinary case as DRAFT", () => {
		// Derived straight from the acceptance criteria: the team has effectively
		// asked for it already, so there is nothing to accept.
		const [c] = normalizeDraftedTestCases({ testCases: [rawCase()] });

		expect(c.state).toBe("DRAFT");
		expect(c.scepticRole).toBeNull();
	});

	it("matches a role case-insensitively rather than downgrading it", () => {
		// "Security" and "security" mean the same thing; rejecting one would
		// silently turn a proposal into a draft nobody was asked to review.
		const [c] = normalizeDraftedTestCases({
			testCases: [rawCase({ scepticRole: "  Security " })],
		});

		expect(c.state).toBe("PROPOSED");
		expect(c.scepticRole).toBe("security");
	});

	it("treats an unknown lens as not sceptic-authored", () => {
		// The role list is restated in this package (it cannot import the database
		// layer), so drift is possible. Degrading to an ordinary DRAFT is the safe
		// direction: the case still exists, it just is not gated.
		const [c] = normalizeDraftedTestCases({
			testCases: [rawCase({ scepticRole: "vibes" })],
		});

		expect(c.state).toBe("DRAFT");
		expect(c.scepticRole).toBeNull();
	});

	it("never returns READY, whatever the model says", () => {
		// The AI proposes or drafts; deciding a case is finished stays a person's
		// call in both branches.
		const states = normalizeDraftedTestCases({
			testCases: [
				rawCase({ state: "READY" }),
				rawCase({ state: "READY", scepticRole: "ux" }),
			],
		}).map((c) => c.state);

		expect(states).toEqual(["DRAFT", "PROPOSED"]);
	});
});
