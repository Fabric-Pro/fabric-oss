import { describe, expect, it } from "vitest";
import { unwrapPmSyncError } from "../pm-sync-error-unwrap";

describe("unwrapPmSyncError", () => {
	it("returns the message and error name for a plain Error", () => {
		const e = new Error("Connection refused");
		const result = unwrapPmSyncError(e);
		expect(result.message).toBe("Connection refused");
		expect(result.errorClass).toBe("Error");
	});

	it("walks past 'Activity task failed' wrappers to reach the real cause", () => {
		const root = new Error(
			"PM ticket fetch failed for 75 via wit_get_work_item: Error retrieving work item: Client does not support form elicitation.",
		);
		const wrapper = new Error("Activity task failed");
		(wrapper as Error & { cause?: unknown }).cause = root;

		const result = unwrapPmSyncError(wrapper);
		expect(result.message).toContain("form elicitation");
		expect(result.message).toContain("wit_get_work_item");
	});

	it("walks past 'Workflow execution failed' wrappers", () => {
		const inner = new Error("Auth refused by ADO");
		(inner as Error & { type?: string }).type = "PmAuthError";
		const wrapper = new Error("Workflow execution failed");
		(wrapper as Error & { cause?: unknown }).cause = inner;

		const result = unwrapPmSyncError(wrapper);
		expect(result.message).toBe("Auth refused by ADO");
		expect(result.errorClass).toBe("PmAuthError");
	});

	it("walks two levels deep (ActivityFailure -> ApplicationFailure -> Error)", () => {
		const root = new Error("ECONNRESET");
		const middle = new Error("Activity task failed");
		(middle as Error & { cause?: unknown }).cause = root;
		const outer = new Error("Activity task failed");
		(outer as Error & { cause?: unknown }).cause = middle;

		const result = unwrapPmSyncError(outer);
		expect(result.message).toBe("ECONNRESET");
	});

	it("prefers the deepest non-generic message over an intermediate one", () => {
		const root = new Error("PmFetchParseError: unparsable JSON");
		(root as Error & { type?: string }).type = "PmFetchParseError";
		const middle = new Error("Outer wrapper detail");
		(middle as Error & { cause?: unknown }).cause = root;

		const result = unwrapPmSyncError(middle);
		expect(result.message).toContain("unparsable JSON");
		expect(result.errorClass).toBe("PmFetchParseError");
	});

	it("truncates the message to 500 chars", () => {
		const long = "x".repeat(900);
		const result = unwrapPmSyncError(new Error(long));
		expect(result.message.length).toBe(500);
	});

	it("falls back to UnknownError class and Unknown error message for empty input", () => {
		const result = unwrapPmSyncError(null);
		expect(result.errorClass).toBe("UnknownError");
		expect(result.message).toBe("null");
	});

	it("handles non-Error thrown values gracefully", () => {
		const result = unwrapPmSyncError("just a string");
		expect(result.message).toBe("just a string");
	});

	it("recovers a classified ApplicationFailure (type+message) under an ActivityFailure wrapper", () => {
		// Shape Temporal produces when an activity throws
		// ApplicationFailure.nonRetryable(userMessage, "context_length").
		const appFailure = new Error(
			"The selected context was too large for the AI model. Narrow the date range or include fewer sources, then retry.",
		);
		(appFailure as Error & { type?: string }).type = "context_length";
		const activityFailure = new Error("Activity task failed");
		(activityFailure as Error & { cause?: unknown }).cause = appFailure;

		const result = unwrapPmSyncError(activityFailure);
		expect(result.errorClass).toBe("context_length");
		expect(result.message).toMatch(/too large for the AI model/);
	});
});
