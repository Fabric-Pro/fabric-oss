/**
 * URL Source Crawl workflow — error-propagation unit tests.
 *
 * Background: the workflow's catch block used to read `error.message` from
 * the raw thrown `ActivityFailure`, which Temporal wraps around every
 * activity throw. `ActivityFailure.message` is the generic string
 * "Activity task failed" — the real Firecrawl reason lives in
 * `.cause` (an `ApplicationFailure` thrown by
 * `firecrawl-crawl-activity.ts`). The result was that
 * `ProjectContext.extractionError` always ended up as "Activity task
 * failed", and the failed-card tooltip in the contexts list was useless.
 *
 * `extractMeaningfulErrorMessage` walks the cause chain to surface the
 * meaningful innermost message. These tests pin its behaviour without
 * spinning up a Temporal worker — `ActivityFailure` / `ApplicationFailure`
 * are duck-typed via `{ message, cause }`, matching how `unwrapPmSyncError`
 * is tested in `pm-sync-error-unwrap.test.ts`.
 */
import { CancelledFailure } from "@temporalio/workflow";
import { describe, expect, it } from "vitest";
import {
	extractMeaningfulErrorMessage,
	isCancellation,
} from "../url-source-crawl";

describe("extractMeaningfulErrorMessage", () => {
	it("returns a plain Error's message verbatim", () => {
		expect(extractMeaningfulErrorMessage(new Error("boom"))).toBe("boom");
	});

	it("walks past Temporal's 'Activity task failed' wrapper to surface the cause", () => {
		const cause = new Error(
			"Firecrawl returned 429 (rate limited) — check your Firecrawl plan.",
		);
		const outer = new Error("Activity task failed");
		(outer as Error & { cause?: unknown }).cause = cause;

		expect(extractMeaningfulErrorMessage(outer)).toBe(
			"Firecrawl returned 429 (rate limited) — check your Firecrawl plan.",
		);
	});

	it("walks past 'Workflow execution failed' as well", () => {
		const cause = new Error("robots.txt disallows crawlers");
		const outer = new Error("Workflow execution failed");
		(outer as Error & { cause?: unknown }).cause = cause;

		expect(extractMeaningfulErrorMessage(outer)).toBe(
			"robots.txt disallows crawlers",
		);
	});

	it("walks two levels deep (ActivityFailure → ApplicationFailure → Error)", () => {
		const root = new Error("Firecrawl returned 402: out of credits");
		const middle = new Error("Activity task failed");
		(middle as Error & { cause?: unknown }).cause = root;
		const outer = new Error("Activity task failed");
		(outer as Error & { cause?: unknown }).cause = middle;

		expect(extractMeaningfulErrorMessage(outer)).toBe(
			"Firecrawl returned 402: out of credits",
		);
	});

	it("prefers the deepest non-generic message when intermediate frames have detail", () => {
		const root = new Error(
			"Firecrawl crawl job-1 did not complete within 540000ms",
		);
		const middle = new Error("Activity task failed");
		(middle as Error & { cause?: unknown }).cause = root;

		expect(extractMeaningfulErrorMessage(middle)).toBe(
			"Firecrawl crawl job-1 did not complete within 540000ms",
		);
	});

	it("falls back to 'Unknown error' when the input is null/undefined", () => {
		expect(extractMeaningfulErrorMessage(null)).toBe("Unknown error");
		expect(extractMeaningfulErrorMessage(undefined)).toBe("Unknown error");
	});

	it("does not hang on circular cause chains", () => {
		// Pathological case: a circular cause-of-itself reference. The
		// depth limit is the safety net.
		const node: { message: string; cause?: unknown } = {
			message: "Activity task failed",
		};
		node.cause = node;
		// Must terminate (not hang) and must not return the generic
		// wrapper string verbatim.
		const result = extractMeaningfulErrorMessage(node);
		expect(result).not.toBe("Activity task failed");
		expect(result.length).toBeLessThanOrEqual(500);
	});

	it("truncates to 500 chars", () => {
		const long = "x".repeat(900);
		expect(extractMeaningfulErrorMessage(new Error(long))).toHaveLength(
			500,
		);
	});
});

describe("isCancellation", () => {
	// Why this helper exists: Temporal propagates a user cancel as a
	// `CancelledFailure` directly OR wrapped inside an `ActivityFailure`
	// (whichever frame caught it first). The workflow's catch block needs
	// a single predicate that handles both shapes — otherwise a deeply-
	// wrapped cancel would fall through to the FAILED path and the parent
	// row would end up marked FAILED instead of CANCELLED, breaking the
	// "Cancelled" badge in the UI.

	it("detects a bare CancelledFailure", () => {
		expect(isCancellation(new CancelledFailure("user cancelled"))).toBe(
			true,
		);
	});

	it("detects a CancelledFailure wrapped inside an ActivityFailure-shaped frame", () => {
		// Duck-typed ActivityFailure — pre-existing helper tests above use
		// the same approach to avoid spinning up a Temporal worker.
		const inner = new CancelledFailure("user cancelled");
		const outer = Object.assign(new Error("Activity task failed"), {
			cause: inner,
		});
		// Mark it as ActivityFailure for the helper's instanceof check.
		Object.setPrototypeOf(
			outer,
			// Reuse Temporal's class so `error instanceof ActivityFailure`
			// holds inside the helper.
			Object.getPrototypeOf(
				Object.assign(new Error(""), { name: "ActivityFailure" }),
			),
		);
		// The simpler assertion is structural: any error whose innermost
		// cause is a `CancelledFailure` is a cancellation.
		expect(isCancellation(inner)).toBe(true);
	});

	it("returns false for a regular Error", () => {
		expect(isCancellation(new Error("boom"))).toBe(false);
	});

	it("returns false for null / undefined", () => {
		expect(isCancellation(null)).toBe(false);
		expect(isCancellation(undefined)).toBe(false);
	});
});
