/**
 * Tests for extractClarifyingQuestion — parses the structured clarifying-question
 * block the model emits (this agent's model won't call the HITL tool, so the
 * chat node synthesizes the ask_clarifying_question tool call from this block,
 * mirroring how it synthesizes confirm_changes).
 */

import { describe, expect, it } from "vitest";
import { extractClarifyingQuestion } from "../nodes/chat-node";

describe("extractClarifyingQuestion", () => {
	it("parses a fenced clarifying-question block", () => {
		const text = [
			"```clarifying-question",
			'{ "question": "Which auth method?", "options": ["SSO", "Password", "Both"] }',
			"```",
		].join("\n");
		expect(extractClarifyingQuestion(text)).toEqual({
			question: "Which auth method?",
			options: ["SSO", "Password", "Both"],
		});
	});

	it("parses a generic ```json fenced block", () => {
		const text =
			'```json\n{ "question": "Which DB?", "options": ["PostgreSQL"] }\n```';
		expect(extractClarifyingQuestion(text)).toEqual({
			question: "Which DB?",
			options: ["PostgreSQL"],
		});
	});

	it("parses bare JSON with no fence", () => {
		const text = '{ "question": "Scope?", "options": ["A", "B"] }';
		expect(extractClarifyingQuestion(text)).toEqual({
			question: "Scope?",
			options: ["A", "B"],
		});
	});

	it("ignores prose around the block and caps options at 3", () => {
		const text = [
			"Sure — let me check.",
			"```clarifying-question",
			'{ "question": "Pick one", "options": ["1","2","3","4","5"] }',
			"```",
		].join("\n");
		expect(extractClarifyingQuestion(text)).toEqual({
			question: "Pick one",
			options: ["1", "2", "3"],
		});
	});

	it("drops empty/non-string options", () => {
		const text =
			'{ "question": "Q", "options": ["ok", "", "  ", 5, "two"] }';
		expect(extractClarifyingQuestion(text)).toEqual({
			question: "Q",
			options: ["ok", "two"],
		});
	});

	it("returns null for normal prose (not a clarifying question)", () => {
		expect(
			extractClarifyingQuestion("Here is your updated document."),
		).toBeNull();
	});

	it("returns null for JSON without a question", () => {
		expect(
			extractClarifyingQuestion('{ "options": ["a", "b"] }'),
		).toBeNull();
	});

	it("tolerates a question with no options (custom-answer only)", () => {
		expect(
			extractClarifyingQuestion('{ "question": "Anything else?" }'),
		).toEqual({ question: "Anything else?", options: [] });
	});

	it("returns null for empty input", () => {
		expect(extractClarifyingQuestion("")).toBeNull();
	});
});
