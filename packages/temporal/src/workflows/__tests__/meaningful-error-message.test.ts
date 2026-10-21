import { describe, expect, it } from "vitest";
import { extractMeaningfulErrorMessage } from "../meaningful-error-message";

describe("workflow failure message fallback", () => {
	it.each([undefined, null, "unstructured failure", {}])(
		"uses the caller's neutral fallback for %s",
		(error) => {
			expect(
				extractMeaningfulErrorMessage(error, "Direct chat failed"),
			).toBe("Direct chat failed");
		},
	);

	it("prefers the inner error to the fallback", () => {
		expect(
			extractMeaningfulErrorMessage(
				new Error("Activity task failed", {
					cause: new Error("Example provider is not configured"),
				}),
				"Direct chat failed",
			),
		).toBe("Example provider is not configured");
	});
});
