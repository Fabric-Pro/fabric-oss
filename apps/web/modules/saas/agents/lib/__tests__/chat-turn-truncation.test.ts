import { describe, expect, it } from "vitest";
import {
	CONTINUE_PROMPT,
	parseTurnTruncation,
	TRUNCATION_NOTICE_COPY,
} from "../chat-turn-truncation";

describe("parseTurnTruncation", () => {
	it("accepts the two limits", () => {
		expect(parseTurnTruncation("output_limit")).toBe("output_limit");
		expect(parseTurnTruncation("step_limit")).toBe("step_limit");
	});

	it("ignores anything else", () => {
		expect(parseTurnTruncation(undefined)).toBeUndefined();
		expect(parseTurnTruncation("length")).toBeUndefined();
		expect(parseTurnTruncation({ kind: "step_limit" })).toBeUndefined();
	});

	it("has the agreed copy", () => {
		expect(TRUNCATION_NOTICE_COPY.output_limit).toBe(
			"This answer was cut off at the length limit — ask me to continue.",
		);
		expect(TRUNCATION_NOTICE_COPY.step_limit).toBe(
			"I ran out of steps — ask me to continue or narrow the question.",
		);
		expect(CONTINUE_PROMPT).toBe("Continue from where you stopped.");
	});
});
