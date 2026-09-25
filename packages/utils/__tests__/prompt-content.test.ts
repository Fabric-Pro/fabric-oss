import { describe, expect, it } from "vitest";
import {
	PROMPT_CONTENT_EMPTY_MESSAGE,
	PROMPT_CONTENT_MAX_LENGTH,
	promptContentProblem,
	promptContentTooLongMessage,
} from "../lib/prompt-content";

describe("promptContentTooLongMessage", () => {
	it("names the given length and the max, grouped for readability", () => {
		expect(promptContentTooLongMessage(100_000)).toBe(
			"Prompt content is 100,000 characters; the maximum is 50,000.",
		);
	});
});

describe("promptContentProblem", () => {
	it("returns the empty message for a blank body", () => {
		expect(promptContentProblem("")).toBe(PROMPT_CONTENT_EMPTY_MESSAGE);
		expect(promptContentProblem("   \n\t ")).toBe(
			PROMPT_CONTENT_EMPTY_MESSAGE,
		);
	});

	it("returns the empty message for a body of only invisible characters", () => {
		// Same defect class blank-content.ts guards: content that is non-empty
		// to a length check but blank to every reader (Fizzy #2178 QA).
		expect(promptContentProblem("​")).toBe(PROMPT_CONTENT_EMPTY_MESSAGE);
	});

	it("returns the too-long message for a body over the max", () => {
		const tooLong = "x".repeat(PROMPT_CONTENT_MAX_LENGTH + 1);
		expect(promptContentProblem(tooLong)).toBe(
			promptContentTooLongMessage(tooLong.length),
		);
	});

	it("returns null for a body at exactly the max", () => {
		const atMax = "x".repeat(PROMPT_CONTENT_MAX_LENGTH);
		expect(promptContentProblem(atMax)).toBeNull();
	});

	it("returns null for ordinary content", () => {
		expect(promptContentProblem("Write an agenda.")).toBeNull();
	});
});
