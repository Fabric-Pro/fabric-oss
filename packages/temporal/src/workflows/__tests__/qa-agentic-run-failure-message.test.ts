/**
 * `rootCauseMessage` — what a blocked run tells the person reading it.
 *
 * A failing activity arrives as an `ActivityFailure` whose own message is the
 * fixed string "Activity task failed". Reading only that produced one
 * unactionable line for every possible cause, which is exactly what the first
 * scripted run to be dispatched on staging reported: the sandbox was
 * unreachable, and the run said "The runner failed: ActivityFailure: Activity
 * task failed".
 *
 * These cases are the shapes Temporal actually produces, not invented ones.
 */

import { describe, expect, it } from "vitest";

import { rootCauseMessage } from "../qa-agentic-run";

/** An `ActivityFailure`-shaped error: generic message, real reason in `cause`. */
function activityFailure(cause: unknown): Error {
	const err = new Error("Activity task failed");
	err.name = "ActivityFailure";
	(err as Error & { cause?: unknown }).cause = cause;
	return err;
}

describe("rootCauseMessage", () => {
	it("reaches past the wrapper to the reason", () => {
		// The staging case, verbatim.
		const err = activityFailure(
			new Error("SANDBOX_WORKER_URL environment variable is required"),
		);
		expect(rootCauseMessage(err)).toBe(
			"SANDBOX_WORKER_URL environment variable is required",
		);
	});

	it("never returns the wrapper's own message when a cause explains more", () => {
		const err = activityFailure(new Error("connect ECONNREFUSED"));
		expect(rootCauseMessage(err)).not.toMatch(/Activity task failed/);
	});

	it("takes the DEEPEST explanation, not the first", () => {
		// Temporal wraps twice: ActivityFailure -> ApplicationFailure -> cause.
		const err = activityFailure(
			Object.assign(new Error("Script execution failed"), {
				cause: new Error("Chromium is not installed in this image"),
			}),
		);
		expect(rootCauseMessage(err)).toBe(
			"Chromium is not installed in this image",
		);
	});

	it("falls back to the wrapper when there is genuinely nothing else", () => {
		// No cause at all — better to say the unhelpful thing than an empty string.
		const bare = new Error("Activity task failed");
		bare.name = "ActivityFailure";
		expect(rootCauseMessage(bare)).toContain("Activity task failed");
	});

	it("handles a plain thrown value", () => {
		expect(rootCauseMessage("boom")).toBe("boom");
	});

	it("survives a circular cause chain", () => {
		// A chain that points at itself must terminate, not hang the workflow.
		const a = new Error("outer");
		const b = new Error("inner");
		(a as Error & { cause?: unknown }).cause = b;
		(b as Error & { cause?: unknown }).cause = a;
		expect(rootCauseMessage(a)).toBeTruthy();
	});

	it("ignores an empty cause message rather than reporting nothing", () => {
		const err = activityFailure(new Error(""));
		expect(rootCauseMessage(err)).toContain("Activity task failed");
	});
});
