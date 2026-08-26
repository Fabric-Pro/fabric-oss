/**
 * Tests for extractClarifyingQuestion in the document_generator chat-node.
 *
 * This agent only binds write_document_local, so it signals a clarifying question
 * as a fenced `clarifying-question` JSON block (per the shared follow-up prompt);
 * the chat-node parses it and synthesizes an ask_clarifying_question tool call so
 * the frontend renders the interactive card. This guards the parser.
 */

import { describe, expect, it } from "vitest";
import { extractClarifyingQuestion } from "../nodes/chat-node";

describe("extractClarifyingQuestion (document_generator)", () => {
	it("parses a fenced clarifying-question block with options", () => {
		const text = [
			"```clarifying-question",
			'{ "question": "Which datastore?", "options": ["PostgreSQL", "MongoDB"] }',
			"```",
		].join("\n");
		const result = extractClarifyingQuestion(text);
		expect(result).not.toBeNull();
		expect(result?.question).toBe("Which datastore?");
		expect(result?.options).toEqual(["PostgreSQL", "MongoDB"]);
	});

	it("caps options at 3", () => {
		const text =
			'```json\n{ "question": "Pick one", "options": ["a","b","c","d","e"] }\n```';
		expect(extractClarifyingQuestion(text)?.options).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	it("accepts a bare JSON object (no fence)", () => {
		const result = extractClarifyingQuestion(
			'{ "question": "Auth method?", "options": ["OAuth"] }',
		);
		expect(result?.question).toBe("Auth method?");
	});

	it("returns null for normal prose (not a clarifying block)", () => {
		expect(
			extractClarifyingQuestion("Here is your updated document. Done!"),
		).toBeNull();
	});

	it("returns null when question is missing/empty", () => {
		expect(
			extractClarifyingQuestion('{ "options": ["a","b"] }'),
		).toBeNull();
		expect(
			extractClarifyingQuestion('{ "question": "   ", "options": [] }'),
		).toBeNull();
	});
});
