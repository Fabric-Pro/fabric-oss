/**
 * An allowance a call spent is given back only when the call certainly did
 * nothing. A call that timed out may still have run (a workflow run started),
 * so its allowance stays spent and a retry asks.
 */
import { describe, expect, it } from "vitest";
import { isDefiniteRefusal } from "../fabric-gateway-client";

describe("isDefiniteRefusal", () => {
	it("is a refusal when the tool answered with an error", () => {
		expect(
			isDefiniteRefusal({ error: "The workflow is not published" }),
		).toBe(true);
	});

	it("is not a refusal when the call timed out and may have run", () => {
		expect(
			isDefiniteRefusal({
				error: "fabric_execute_workflow did not respond in time. Check before trying again.",
				outcomeUnknown: true,
			}),
		).toBe(false);
	});

	it("is not a refusal for a result", () => {
		expect(isDefiniteRefusal({ execution: { id: "exec-1" } })).toBe(false);
		expect(isDefiniteRefusal(null)).toBe(false);
		expect(isDefiniteRefusal("done")).toBe(false);
	});
});
