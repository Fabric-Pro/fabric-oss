import { describe, expect, it } from "vitest";
import { extractStreamErrorMessage } from "../src/activities/direct-chat/stream-error";

describe("extractStreamErrorMessage", () => {
	it("returns the message from an Error in the error part", () => {
		const part = {
			type: "error",
			error: new Error("tools: too many tools provided"),
		};
		expect(extractStreamErrorMessage(part)).toBe(
			"tools: too many tools provided",
		);
	});

	it("returns a string error verbatim", () => {
		const part = { type: "error", error: "input_schema is invalid" };
		expect(extractStreamErrorMessage(part)).toBe("input_schema is invalid");
	});

	it("serializes an object error (e.g. provider 400 body)", () => {
		const part = {
			type: "error",
			error: { status: 400, message: "context length exceeded" },
		};
		expect(extractStreamErrorMessage(part)).toContain(
			"context length exceeded",
		);
	});

	it("returns undefined when there is no error payload", () => {
		expect(extractStreamErrorMessage({ type: "error" })).toBeUndefined();
		expect(extractStreamErrorMessage(null)).toBeUndefined();
		expect(extractStreamErrorMessage({ type: "text" })).toBeUndefined();
	});
});
