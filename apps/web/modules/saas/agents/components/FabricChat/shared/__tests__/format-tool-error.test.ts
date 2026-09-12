import { describe, expect, it } from "vitest";
import { formatToolError } from "../ToolCallList";

describe("formatToolError", () => {
	it("unwraps the message from an error object", () => {
		expect(
			formatToolError(undefined, {
				error: "No workspaces are attached to this chat.",
			}),
		).toBe("No workspaces are attached to this chat.");
	});

	it("unwraps a JSON string and prefers the error field", () => {
		expect(
			formatToolError('{"error":"Rate limited","code":429}', undefined),
		).toBe("Rate limited");
	});

	it("keeps plain text and falls back when nothing was sent", () => {
		expect(formatToolError("Timed out", { error: "ignored" })).toBe(
			"Timed out",
		);
		expect(formatToolError(undefined, undefined)).toBe(
			"This tool reported an error but sent no details.",
		);
	});
});
