import {
	ActivityFailure,
	ApplicationFailure,
	RetryState,
	TimeoutFailure,
	TimeoutType,
} from "@temporalio/common";
import { describe, expect, it } from "vitest";
import {
	classifyScanFailure,
	describeScanFailureMessage,
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

/** The failure a scan step's exhausted retries hand the workflow's catch. */
function activityFailure(activityType: string, cause: Error): ActivityFailure {
	return new ActivityFailure(
		"Activity task failed",
		activityType,
		"7",
		RetryState.MAXIMUM_ATTEMPTS_REACHED,
		"worker@host",
		cause,
	);
}

describe("describeScanFailureMessage", () => {
	it("names the failed step and its real cause instead of Temporal's wrapper text", () => {
		const err = activityFailure(
			"persistScanResultsActivity",
			ApplicationFailure.create({
				message:
					"Unique constraint failed on the fields: (`fingerprint`)",
				type: "PrismaClientKnownRequestError",
			}),
		);
		expect(describeScanFailureMessage(err)).toBe(
			"Saving the scan results failed: Unique constraint failed on the fields: (`fingerprint`)",
		);
	});

	it("labels the context-gather and mark-running steps", () => {
		expect(
			describeScanFailureMessage(
				activityFailure(
					"gatherScanContextActivity",
					ApplicationFailure.create({ message: "Project not found" }),
				),
			),
		).toBe("Gathering the project content failed: Project not found");
		expect(
			describeScanFailureMessage(
				activityFailure(
					"markScanRunningActivity",
					ApplicationFailure.create({ message: "Scan row missing" }),
				),
			),
		).toBe("Starting the scan failed: Scan row missing");
	});

	it("keeps the cause alone for an activity it has no step label for", () => {
		expect(
			describeScanFailureMessage(
				activityFailure(
					"someOtherActivity",
					ApplicationFailure.create({ message: "boom" }),
				),
			),
		).toBe("boom");
	});

	it("passes the wholesale 'every scanner failed' error through unchanged", () => {
		const thrown = new Error(
			"Every scanner failed to complete (Security, Accessibility).",
		);
		expect(describeScanFailureMessage(thrown)).toBe(thrown.message);
	});
});

/** The message the workflow's catch records: step message plus hint. */
function recordedMessage(error: unknown): string {
	return ensureScanFailureHint(describeScanFailureMessage(error), error);
}

describe("failed scan step message", () => {
	it("says a timed-out step timed out, without blaming the AI model", () => {
		const err = activityFailure(
			"gatherScanContextActivity",
			new TimeoutFailure(
				"Activity task timed out",
				undefined,
				TimeoutType.START_TO_CLOSE,
			),
		);
		expect(recordedMessage(err)).toBe(
			"Gathering the project content timed out. This can happen on a large project or a busy worker and is usually temporary — please try again in a few minutes.",
		);
	});

	it("gives an unavailable step a service hint, as its own sentence", () => {
		const err = activityFailure(
			"persistScanResultsActivity",
			Object.assign(new Error("Connection reset by peer"), {
				code: "ECONNRESET",
			}),
		);
		expect(recordedMessage(err)).toBe(
			"Saving the scan results failed: Connection reset by peer. A service the scan depends on was temporarily unavailable. This is usually temporary — please try again shortly.",
		);
	});

	it("keeps the AI-model hint for the wholesale scanner failure", () => {
		const rateHint = describeScanFailureReason([
			new Error("429 rate limit"),
		]) as string;
		const thrown = new Error(
			`Every scanner failed to complete (Security). ${rateHint}`,
		);
		expect(recordedMessage(thrown)).toBe(thrown.message);
		expect(rateHint).toContain("The AI model was rate-limited");
	});
});
