import { describe, expect, it } from "vitest";
import {
	clarificationOf,
	formatClarificationTurn,
	parseClarificationTurn,
} from "../lib/clarification-turns";

describe("clarification turns", () => {
	it("preserves the history wording and punctuation", () => {
		expect(
			formatClarificationTurn({
				question: 'By "staging," do you mean the branch?',
				answer: "Yes: staging",
			}),
		).toBe(
			'Clarification — By "staging," do you mean the branch?: Yes: staging',
		);
	});
	it("returns only string question and answer fields", () => {
		expect(
			parseClarificationTurn({
				question: "Which branch?",
				answer: "staging",
				privateField: "private-value",
			}),
		).toEqual({ question: "Which branch?", answer: "staging" });
	});
	it.each([
		null,
		undefined,
		[],
		"text",
		{ question: 42, answer: "staging" },
		{ question: "Which branch?", answer: {} },
		{ question: "Which branch?" },
	])("ignores malformed saved data %j", (value) => {
		expect(parseClarificationTurn(value)).toBeUndefined();
	});
	it("reads structured user messages and leaves legacy text uninterpreted", () => {
		const metadata = {
			clarification: { question: "Which branch?", answer: "staging" },
		};
		expect(clarificationOf({ role: "user", metadata })).toEqual(
			metadata.clarification,
		);
		expect(
			clarificationOf({ role: "assistant", metadata }),
		).toBeUndefined();
		expect(clarificationOf({ role: "user" })).toBeUndefined();
	});
});
