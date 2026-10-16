import { FabricToolError } from "@saas/mcp/lib/fabric-tool-client";
import { describe, expect, it } from "vitest";
import { isBusyError, userMessageOf } from "../user-message-of";

const FALLBACK = "Could not add your comment. Try again.";

function refusal(reason: string | undefined, message = "Server words.") {
	return new FabricToolError(message, "fabric_page_comment_add", { reason });
}

describe("userMessageOf", () => {
	it.each([
		["busy", "The page is busy. Try again in a moment."],
		[
			"rate_limited",
			"Too many writes on this page. Try again in 20 seconds.",
		],
		["limit", "A page holds at most 2000 records."],
		["usage_limit", "Your AI usage limit is reached."],
	])("shows the words the tool gave for %s", (reason, message) => {
		expect(userMessageOf(refusal(reason, message), FALLBACK)).toBe(message);
	});

	it.each([
		["a reason meant for a developer", refusal("version_conflict")],
		["no reason", refusal(undefined, "fabric_page_comment_add failed")],
		[
			"an HTTP failure",
			new FabricToolError(
				"fabric_page_comment_add failed with HTTP 503",
				"t",
			),
		],
		[
			"an unreadable answer",
			new FabricToolError("x returned no result", "t"),
		],
		["any other error", new Error("Failed to fetch")],
		["something thrown that is not an error", "oops"],
	])("shows the sentence written for the action for %s", (_label, error) => {
		expect(userMessageOf(error, FALLBACK)).toBe(FALLBACK);
	});

	it("never shows a tool id or an HTTP status", () => {
		const messages = [
			new FabricToolError(
				"fabric_page_comment_add failed with HTTP 500",
				"t",
			),
			new FabricToolError(
				"fabric_get_frame returned an unreadable answer",
				"t",
			),
			new Error("HTTP 404"),
		].map((error) => userMessageOf(error, FALLBACK));

		for (const message of messages) {
			expect(message).not.toMatch(/fabric_|HTTP/);
		}
	});
});

describe("isBusyError", () => {
	it("is true for a tool that said the page is busy, and for nothing else", () => {
		expect(isBusyError(refusal("busy"))).toBe(true);
		expect(isBusyError(refusal("rate_limited"))).toBe(false);
		expect(isBusyError(refusal(undefined))).toBe(false);
		expect(
			isBusyError(Object.assign(new Error("busy"), { reason: "busy" })),
		).toBe(false);
	});
});
