import { describe, expect, it } from "vitest";
import { connectorErrorMessage } from "../connector-error";

describe("connector errors", () => {
	it.each([
		"Example error",
		{ error: { message: "Example error" } },
		{ errors: [{ message: "Example error" }] },
		{ detail: [{ msg: "Example error" }] },
	])("normalizes provider errors to a string", (value) =>
		expect(connectorErrorMessage(value, "Fallback")).toBe("Example error"),
	);
	it("uses a fallback for an unknown or cyclic shape", () => {
		const value: Record<string, unknown> = {};
		value.error = value;
		expect(connectorErrorMessage(value, "Fallback")).toBe("Fallback");
		expect(connectorErrorMessage({}, "Fallback")).toBe("Fallback");
	});
	it("bounds error payloads", () =>
		expect(
			connectorErrorMessage("x".repeat(5000), "Fallback"),
		).toHaveLength(2000));
	it("redacts credentials before an error can be persisted", () => {
		const text = connectorErrorMessage(
			"Authorization: Bearer example-test-credential",
			"Fallback",
		);
		expect(text).not.toContain("example-test-credential");
	});
});
