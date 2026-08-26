import { describe, expect, it } from "vitest";
import {
	classifyScanFailure,
	describeScanFailureReason,
	ensureScanFailureHint,
} from "../scan-failure-hint";

/** Build a Temporal-style wrapped failure: ActivityFailure -> ... -> root. */
function wrap(message: string, cause: unknown): Error {
	const e = new Error(message);
	(e as Error & { cause?: unknown }).cause = cause;
	return e;
}

describe("classifyScanFailure", () => {
	it("returns 'unknown' for no reasons", () => {
		expect(classifyScanFailure([])).toBe("unknown");
	});

	it("returns 'unknown' when nothing matches", () => {
		expect(classifyScanFailure([new Error("boom: schema mismatch")])).toBe(
			"unknown",
		);
	});

	it("detects a plain rate-limit message", () => {
		expect(
			classifyScanFailure([new Error("Rate limit reached for model")]),
		).toBe("rate_limit");
	});

	it("detects a 429 status code carried on the error object", () => {
		const e = Object.assign(new Error("Too Many Requests"), {
			statusCode: 429,
		});
		expect(classifyScanFailure([e])).toBe("rate_limit");
	});

	it("detects a TPM / tokens-per-minute quota message", () => {
		expect(
			classifyScanFailure([
				new Error("Request exceeded the tokens per minute (TPM) limit"),
			]),
		).toBe("rate_limit");
	});

	it("detects a Temporal activity timeout", () => {
		expect(
			classifyScanFailure([
				wrap(
					"Activity task failed",
					new Error("Activity task timed out"),
				),
			]),
		).toBe("timeout");
	});

	it("detects a startToClose deadline exceeded", () => {
		expect(
			classifyScanFailure([
				new Error("startToClose timeout of 30 minutes exceeded"),
			]),
		).toBe("timeout");
	});

	it("detects an upstream 503 / overloaded", () => {
		expect(
			classifyScanFailure([
				new Error("503 Service Unavailable: overloaded"),
			]),
		).toBe("unavailable");
	});

	it("detects a dropped connection", () => {
		const e = Object.assign(new Error("request failed"), {
			code: "ECONNRESET",
		});
		expect(classifyScanFailure([e])).toBe("unavailable");
	});

	it("walks the .cause chain to reach the real rate-limit reason", () => {
		const root = Object.assign(new Error("429 Too Many Requests"), {
			statusCode: 429,
		});
		const app = wrap("Activity task failed", root);
		const activity = wrap("All 12 accessibility scan chunk(s) failed", app);
		expect(classifyScanFailure([activity])).toBe("rate_limit");
	});

	it("prefers the more actionable rate_limit over a co-occurring timeout", () => {
		expect(
			classifyScanFailure([
				new Error("request timed out"),
				new Error("rate limit exceeded"),
			]),
		).toBe("rate_limit");
	});
});

describe("describeScanFailureReason", () => {
	it("returns null (bare message kept) when unclassifiable", () => {
		expect(
			describeScanFailureReason([new Error("weird failure")]),
		).toBeNull();
	});

	it("returns a reassuring, retry-oriented hint for rate limiting", () => {
		const hint = describeScanFailureReason([new Error("429 rate limit")]);
		expect(hint).toContain("rate-limited");
		expect(hint).toContain("try again");
	});

	it("returns a large-scan / busy-worker hint for timeouts", () => {
		const hint = describeScanFailureReason([
			wrap("Activity task failed", new Error("Activity task timed out")),
		]);
		expect(hint).toContain("didn't respond in time");
		expect(hint).toContain("try again");
	});

	it("returns a temporary-unavailability hint for upstream 5xx", () => {
		const hint = describeScanFailureReason([new Error("502 Bad Gateway")]);
		expect(hint).toContain("temporarily unavailable");
	});
});

describe("ensureScanFailureHint", () => {
	it("appends a hint to a non-wholesale failure whose cause is classifiable", () => {
		// A context-gather / persist throw reaches the workflow catch as a bare
		// Temporal ActivityFailure — no hint yet. Classify its cause and append.
		const err = wrap(
			"Activity task failed",
			new Error("Activity task timed out"),
		);
		const out = ensureScanFailureHint("Activity task failed", err);
		expect(out).toContain("Activity task failed");
		expect(out).toContain("didn't respond in time");
	});

	it("leaves an unclassifiable failure message untouched", () => {
		const err = new Error("Prisma: unique constraint violated");
		expect(ensureScanFailureHint(err.message, err)).toBe(err.message);
	});

	it("is idempotent — never double-hints the wholesale branch's message", () => {
		// The wholesale branch throws base + hint (from the raw per-scanner
		// reasons). That same Error flowing through the catch must not re-append.
		const rateHint = describeScanFailureReason([
			new Error("429 rate limit"),
		]) as string;
		const thrown = new Error(
			`Every scanner failed to complete (Accessibility). ${rateHint}`,
		);
		expect(ensureScanFailureHint(thrown.message, thrown)).toBe(
			thrown.message,
		);
	});
});
