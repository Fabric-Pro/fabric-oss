/**
 * The code-fence rule of the shared formatting rules (Fizzy #2946).
 *
 * Fences are for code, JSON, shell and Mermaid, and also for the content
 * blocks a document's own instructions define: a client Proposal's Main
 * prompt asks for stat tiles, cards, columns and cover details, and the theme
 * draws exactly those four. The rule names them and no other language, so it
 * never invites a fence a document did not ask for.
 */

import { describe, expect, it } from "vitest";
import {
	getMarkdownFormattingRulesPrompt,
	MARKDOWN_FORMATTING_RULES,
} from "../src/core/formatting-rules";

const CONTENT_BLOCK_LANGUAGES = ["stat-tiles", "cards", "columns", "cover"];

/** The languages a rule's "content blocks … define (…)" clause names. */
function contentBlockLanguages(rule: string): string[] | null {
	const match = rule.match(
		/the content blocks a document's own instructions define \(([^)]*)\)/,
	);
	return match
		? match[1].split(",").map((language) => language.trim())
		: null;
}

describe("the code-fence rule", () => {
	const fenceRule = MARKDOWN_FORMATTING_RULES.sectionRules.codeBlocks.find(
		(rule) => rule.startsWith("Use code fences ONLY for"),
	);

	it("still limits fences to code, JSON, shell and Mermaid", () => {
		expect(fenceRule).toMatch(
			/^Use code fences ONLY for actual code, JSON payloads, shell commands, Mermaid diagrams, or /,
		);
	});

	it("allows exactly the four content blocks, when a document's instructions define them", () => {
		expect(contentBlockLanguages(fenceRule ?? "")).toEqual(
			CONTENT_BLOCK_LANGUAGES,
		);
	});

	it("says the same in the rendered prompt's code-block rules and output contract", () => {
		const prompt = getMarkdownFormattingRulesPrompt();
		expect(prompt).toContain(`- ${fenceRule}`);
		const contract = prompt
			.split("\n")
			.find((line) => line.startsWith("3. Use fenced blocks only for"));
		expect(contract).toMatch(
			/^3\. Use fenced blocks only for actual examples such as JSON, code, shell commands, or Mermaid, and for /,
		);
		expect(contentBlockLanguages(contract ?? "")).toEqual(
			CONTENT_BLOCK_LANGUAGES,
		);
	});

	it("names the content blocks in those two rules only", () => {
		const prompt = getMarkdownFormattingRulesPrompt();
		expect(prompt.split("stat-tiles")).toHaveLength(3);
	});
});
