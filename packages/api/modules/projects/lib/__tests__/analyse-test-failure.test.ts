import { FAILURE_MESSAGE_LIMIT, TestFailureKind } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
	ANALYSIS_FAILURE_MESSAGE_LIMIT,
	buildFailureEvidence,
	describeRecurrence,
	normaliseKind,
	TEST_FAILURE_KINDS,
} from "../analyse-test-failure";

const BASE = {
	testName: "resets the password",
	classname: "auth/password.spec.ts",
	failureMessage: "AssertionError: expected 200 to equal 401",
	occurrences: 1,
	firstSeenAt: new Date("2026-07-01T00:00:00.000Z"),
	lastSeenAt: new Date("2026-07-01T00:00:00.000Z"),
	caseTitle: "A user resets their password",
};

/**
 * The analysis is a GUESS shown beside facts, so what matters is that it cannot
 * overstate itself: an unrecognised kind degrades to UNKNOWN, and the model is
 * never handed an empty evidence block it would have to fill in from nothing.
 */
describe("the closed set tracks the database", () => {
	it("takes its values from the schema enum, not a hand-written copy", () => {
		// A restated copy compiles cleanly for as long as it happens to agree, so
		// a value added to the schema would not surface until a model returned it
		// and this silently normalised it to UNKNOWN.
		expect([...TEST_FAILURE_KINDS].sort()).toEqual(
			Object.values(TestFailureKind).sort(),
		);
	});

	it("shows the model the same evidence the bug body carries", () => {
		// Two 1500s kept in step by a comment is a promise nothing enforces, and a
		// reader comparing the bug body to the analysis must be looking at the
		// same text.
		expect(ANALYSIS_FAILURE_MESSAGE_LIMIT).toBe(FAILURE_MESSAGE_LIMIT);
	});
});

describe("normaliseKind", () => {
	it("accepts the canonical values", () => {
		for (const kind of [
			"PRODUCT_BUG",
			"TEST_DEFECT",
			"ENVIRONMENT",
			"FLAKY",
			"UNKNOWN",
		]) {
			expect(normaliseKind(kind)).toBe(kind);
		}
	});

	it("accepts the shapes a model actually returns", () => {
		// The reason the generation schema is a plain string and not a z.enum: a
		// strict enum turns each of these into a schema-rejection retry, for a
		// field that is advisory anyway.
		expect(normaliseKind("product bug")).toBe("PRODUCT_BUG");
		expect(normaliseKind("Product-Bug")).toBe("PRODUCT_BUG");
		expect(normaliseKind("  test_defect  ")).toBe("TEST_DEFECT");
		expect(normaliseKind("flaky")).toBe("FLAKY");
	});

	it("degrades anything unrecognised to UNKNOWN rather than throwing", () => {
		// A mis-spelled kind must not cost the reader an otherwise good cause
		// paragraph, and must never be presented as a judgement Fabric can defend.
		for (const raw of [
			undefined,
			"",
			"probably a bug",
			"REGRESSION",
			"PRODUCT_BUG_MAYBE",
		]) {
			expect(normaliseKind(raw)).toBe("UNKNOWN");
		}
	});
});

describe("describeRecurrence", () => {
	it("distinguishes seen-once from a long-running failure", () => {
		expect(
			describeRecurrence({
				occurrences: 1,
				firstSeenAt: new Date("2026-07-01T00:00:00.000Z"),
				lastSeenAt: new Date("2026-07-01T06:00:00.000Z"),
			}),
		).toBe("Seen once. First and last seen the same day.");

		expect(
			describeRecurrence({
				occurrences: 21,
				firstSeenAt: new Date("2026-07-01T00:00:00.000Z"),
				lastSeenAt: new Date("2026-07-22T00:00:00.000Z"),
			}),
		).toBe(
			"Seen 21 times. First seen 21 days before the most recent occurrence.",
		);
	});

	it("reads the span from the timestamps, not the clock", () => {
		// Same finding analysed twice must describe the same history — otherwise
		// re-running the analysis silently changes the evidence and the model can
		// reasonably reach a different conclusion for no reason.
		const input = {
			occurrences: 3,
			firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
			lastSeenAt: new Date("2026-01-03T00:00:00.000Z"),
		};

		expect(describeRecurrence(input)).toBe(describeRecurrence(input));
		expect(describeRecurrence(input)).toContain("2 days");
	});

	it("never reports a negative span", () => {
		// lastSeenAt should never precede firstSeenAt, but a clock skew between
		// the ingesting worker and the database is exactly the kind of thing that
		// would put "-1 days" in a prompt.
		expect(
			describeRecurrence({
				occurrences: 2,
				firstSeenAt: new Date("2026-07-02T00:00:00.000Z"),
				lastSeenAt: new Date("2026-07-01T00:00:00.000Z"),
			}),
		).toContain("same day");
	});
});

describe("buildFailureEvidence", () => {
	it("gives the model the identity, the history and the assertion", () => {
		const evidence = buildFailureEvidence(BASE);

		expect(evidence).toContain("resets the password");
		expect(evidence).toContain("auth/password.spec.ts");
		// The matched case's title tells the model what the test was FOR, which a
		// symbol name often does not.
		expect(evidence).toContain("A user resets their password");
		expect(evidence).toContain("Seen once.");
		expect(evidence).toContain("expected 200 to equal 401");
	});

	it("says the output is missing rather than leaving a blank section", () => {
		// A model shown an empty block infers nothing and invents something. Told
		// the output is absent, it has the one fact it needs to answer UNKNOWN,
		// which is the correct answer for a failure with no evidence.
		const evidence = buildFailureEvidence({
			...BASE,
			failureMessage: null,
		});

		expect(evidence).toContain("no failure output");
		expect(evidence).not.toMatch(/WHAT CI REPORTED:\s*$/);
	});

	it("treats a whitespace-only message as missing", () => {
		expect(
			buildFailureEvidence({ ...BASE, failureMessage: "   \n  " }),
		).toContain("no failure output");
	});

	it("truncates a runner that dumps a whole log file", () => {
		// Without this, one runner's 4 MB of stdout pushes the identity and the
		// recurrence history out of context — the parts that make the answer
		// possible.
		const evidence = buildFailureEvidence({
			...BASE,
			failureMessage: "x".repeat(ANALYSIS_FAILURE_MESSAGE_LIMIT + 5_000),
		});

		expect(evidence).toContain("truncated");
		expect(evidence.length).toBeLessThan(
			ANALYSIS_FAILURE_MESSAGE_LIMIT + 500,
		);
	});

	it("omits the case line entirely when no case matched", () => {
		// Rather than "Linked Fabric test case: none", which reads as a fact about
		// the case rather than an absence of one.
		const evidence = buildFailureEvidence({ ...BASE, caseTitle: null });

		expect(evidence).not.toContain("Linked Fabric test case");
	});
});
