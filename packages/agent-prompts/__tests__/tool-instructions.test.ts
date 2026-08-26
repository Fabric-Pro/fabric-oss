/**
 * Tests for tool-instruction builders that gate the `Preserve First, Then
 * Edit` contract.
 *
 * Code-block preservation rides on prompt augmentation alone (no
 * server-side reinject — D4 in spec planning/decisions.md), so the
 * tool-instruction builders MUST name fenced code blocks explicitly in
 * both write-mode (`buildToolInstructions`,
 * `buildToolInstructionsWithoutFormatting`) and patch-mode (reached via
 * `buildToolInstructionsWithoutFormatting(..., "patch")`). Per D5 the
 * rule must apply in both `toolMode` variants.
 *
 * Run with: pnpm --filter @repo/agent-prompts test
 */

import { describe, expect, it } from "vitest";
import {
	buildToolInstructions,
	buildToolInstructionsWithoutFormatting,
} from "../src/core/tool-instructions";

const existingDocument =
	"# Existing Document\n\nThis document has prior content that must be preserved on edit.";

describe("buildToolInstructions (write-mode, with formatting rules)", () => {
	it("names fenced code blocks in the Preserve Document Elements list", () => {
		const instructions = buildToolInstructions(existingDocument);
		expect(instructions).toMatch(/fenced code blocks/i);
	});

	it("scopes the rule to triple-backtick blocks including the language tag", () => {
		const instructions = buildToolInstructions(existingDocument);
		expect(instructions).toContain(
			"triple-backtick blocks, including the language tag",
		);
	});
});

describe("buildToolInstructionsWithoutFormatting (write-mode, unified builder)", () => {
	it("names fenced code blocks in the Preserve Document Elements list", () => {
		const instructions = buildToolInstructionsWithoutFormatting(
			existingDocument,
			true,
			false,
			"write",
		);
		expect(instructions).toMatch(/fenced code blocks/i);
	});

	it("scopes the rule to triple-backtick blocks including the language tag", () => {
		const instructions = buildToolInstructionsWithoutFormatting(
			existingDocument,
			true,
			false,
			"write",
		);
		expect(instructions).toContain(
			"triple-backtick blocks, including the language tag",
		);
	});
});

describe("buildToolInstructionsWithoutFormatting (patch-mode)", () => {
	it("names fenced code blocks in the patch-mode rules", () => {
		const instructions = buildToolInstructionsWithoutFormatting(
			existingDocument,
			true,
			false,
			"patch",
		);
		expect(instructions).toMatch(/fenced code blocks/i);
	});

	it("phrases the rule as a preservation directive guarded on explicit user intent", () => {
		const instructions = buildToolInstructionsWithoutFormatting(
			existingDocument,
			true,
			false,
			"patch",
		);
		expect(instructions).toContain(
			"Preserve fenced code blocks (triple-backtick blocks) verbatim unless the user explicitly asked to modify them",
		);
	});

	it("describes replaceAll for global renames and keeps the exactly-once default", () => {
		const instructions = buildToolInstructionsWithoutFormatting(
			existingDocument,
			true,
			false,
			"patch",
		);
		// Global-rename escape hatch is documented…
		expect(instructions).toContain("replaceAll: true");
		expect(instructions).toMatch(/every occurrence/i);
		// …without weakening the default single-occurrence contract.
		expect(instructions).toMatch(/MUST appear exactly once/);
	});
});
