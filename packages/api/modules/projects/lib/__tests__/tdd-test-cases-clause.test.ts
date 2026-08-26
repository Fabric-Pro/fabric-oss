import { describe, expect, it } from "vitest";
import { tddTestCasesClause } from "../generate-qa-analysis";

/**
 * The TDD flow's feature-review step — "Feature Review based on Requirements AND Test Cases".
 *
 * The `applyTddApproach` switch used to change one sentence of UI copy and
 * nothing else; this clause is what makes it alter an actual outcome.
 */
describe("tddTestCasesClause", () => {
	it("is absent when the project does not run TDD", () => {
		// The caller passes undefined unless applyTddApproach is on — without
		// TDD the cases are drafted AFTER this review, so feeding them back
		// would grade the model's own later output.
		expect(tddTestCasesClause(undefined)).toBe("");
	});

	it("is absent when TDD is on but nothing has been drafted yet", () => {
		expect(tddTestCasesClause([])).toBe("");
	});

	it("lists the cases and asks the model to review the spec against them", () => {
		const clause = tddTestCasesClause([
			{ identifier: "TC-001", title: "Mute a project indefinitely" },
			{ identifier: "TC-002", title: "Reject a past auto-unmute date" },
		]);
		expect(clause).toContain("TC-001: Mute a project indefinitely");
		expect(clause).toContain("TC-002: Reject a past auto-unmute date");
		expect(clause).toContain("test-driven");
		// The three questions the review is meant to answer.
		expect(clause).toContain("contradict");
		expect(clause).toContain("never promises");
		expect(clause).toContain("no case covers");
	});

	it("bounds the list so a mature feature can't blow the prompt budget", () => {
		const many = Array.from({ length: 200 }, (_, i) => ({
			identifier: `TC-${String(i + 1).padStart(3, "0")}`,
			title: `Case ${i + 1}`,
		}));
		const clause = tddTestCasesClause(many);
		expect(clause).toContain("TC-060");
		expect(clause).not.toContain("TC-061");
	});
});

describe("the test-case generation settings step 3 — attributing a warning to the drafted flows", () => {
	const CASES = [{ identifier: "TC-001", title: "Retry once on timeout" }];

	it("asks the model to mark warnings the drafting itself exposed", () => {
		// Fabric runs the card's steps 3 and 5 as ONE analysis pass. Without this
		// instruction the two outputs blend and a reader cannot tell a warning the
		// spec earned on its own from one the drafted flows revealed — and the
		// second kind IS step 3's contribution, the feedback edge that makes
		// drafting cases before implementation worth doing at all.
		const clause = tddTestCasesClause(CASES);

		expect(clause).toContain("Drafting revealed:");
	});

	it("tells it NOT to attribute a criterion that was already vague", () => {
		// Otherwise every warning acquires the prefix and it stops carrying
		// information — the same inflation the off-tier and severity rules guard
		// against elsewhere.
		expect(tddTestCasesClause(CASES)).toMatch(
			/only when the case is the evidence/i,
		);
	});

	it("says nothing about drafting when the project does not run TDD", () => {
		// No cases means no drafting happened before this review, so there is no
		// discovery to attribute.
		expect(tddTestCasesClause(undefined)).toBe("");
	});
});
