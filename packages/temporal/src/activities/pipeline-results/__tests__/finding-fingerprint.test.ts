import { describe, expect, it } from "vitest";
import {
	fingerprintFinding,
	normaliseFailureMessage,
} from "../finding-fingerprint";

/**
 * The whole value of a fingerprint is that the SAME fault keeps the SAME id
 * across runs while a DIFFERENT fault gets a new one. These tests pin both
 * directions, because failing either way is silent: too stable and two faults
 * merge; too volatile and every nightly run mints fresh findings nobody reads.
 */
describe("fingerprintFinding", () => {
	const base = {
		testName: "applies a percentage discount",
		classname: "test/cart.test.js",
		failureMessage: "expected -100 to be 80",
	};

	it("is stable across runs of the identical failure", () => {
		expect(fingerprintFinding(base)).toBe(fingerprintFinding({ ...base }));
	});

	it("survives the parts of a stack trace that change every run", () => {
		// Same fault, different machine, different run — absolute paths, line
		// numbers, elapsed time and object ids all move.
		const monday = fingerprintFinding({
			...base,
			failureMessage:
				"expected -100 to be 80\n at C:\\build\\42\\test\\cart.test.js:118:9 (took 231ms) id=9f2ab441c0de",
		});
		const tuesday = fingerprintFinding({
			...base,
			failureMessage:
				"expected -100 to be 80\n at /tmp/ci-run/test/cart.test.js:126:11 (took 187ms) id=0a71ffcd9931",
		});
		expect(monday).toBe(tuesday);
	});

	it("changes when the assertion itself changes", () => {
		expect(
			fingerprintFinding({
				...base,
				failureMessage: "expected undefined to be an object",
			}),
		).not.toBe(fingerprintFinding(base));
	});

	it("distinguishes two different tests with the same message", () => {
		expect(
			fingerprintFinding({
				...base,
				testName: "applies a fixed discount",
			}),
		).not.toBe(fingerprintFinding(base));
	});

	it("distinguishes the same test name in different suites", () => {
		expect(
			fingerprintFinding({ ...base, classname: "test/checkout.test.js" }),
		).not.toBe(fingerprintFinding(base));
	});

	it("still fingerprints a failure with no message", () => {
		// Run-level-only ingests (a provider that reported no per-test detail)
		// must group by identity rather than each becoming a new finding.
		const a = fingerprintFinding({ ...base, failureMessage: null });
		const b = fingerprintFinding({ ...base, failureMessage: undefined });
		expect(a).toBe(b);
		expect(a).toHaveLength(16);
	});

	it("ignores case and surrounding whitespace", () => {
		expect(
			fingerprintFinding({
				testName: "  Applies A Percentage Discount ",
				classname: " TEST/cart.test.js ",
				failureMessage: "Expected -100 To Be 80",
			}),
		).toBe(fingerprintFinding(base));
	});

	it("is a short hex digest, not a full hash", () => {
		expect(fingerprintFinding(base)).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("normaliseFailureMessage", () => {
	it("collapses volatile detail but keeps the assertion readable", () => {
		const out = normaliseFailureMessage(
			"Expected 200 but got 500 at /srv/app/handlers/cart.ts:88:14",
		);
		expect(out).toContain("expected");
		expect(out).toContain("<n>");
		expect(out).toContain("<pos>");
		expect(out).not.toContain("/srv/app/handlers");
	});

	it("bounds a runaway message", () => {
		expect(
			normaliseFailureMessage("x".repeat(5000)).length,
		).toBeLessThanOrEqual(400);
	});
});
