/**
 * apply_document_patches runs every patch's content through
 * stripToolDefinitions. That sanitizer trims, which is right for a whole
 * section but not for a replace_text fragment, whose leading indent and
 * trailing newline are part of the edit.
 */

import { applyPatches } from "@repo/agent-prompts";
import { describe, expect, it } from "vitest";
import {
	finalizeEditedDocument,
	stripToolDefinitions,
} from "../nodes/chat-node";

const DOC = [
	"## Export",
	"",
	"```yaml",
	"team_availability_export:",
	"  date_range:",
	'    start: "<selected start date>"',
	'    end: "<selected end date>"',
	"  output:",
	"    format: csv",
	"```",
	"",
].join("\n");

function applyAsAgent(find: string, replace: string): string {
	const { success, result } = applyPatches(
		DOC,
		[{ op: "replace_text", find, replace }],
		{ sanitizeContent: (content) => stripToolDefinitions(content, DOC) },
	);
	expect(success).toBe(true);
	return result;
}

describe("replace_text through the agent's content sanitizer", () => {
	it("keeps the indent of the first replaced line and the trailing newline", () => {
		const find =
			'  date_range:\n    start: "<selected start date>"\n    end: "<selected end date>"\n';
		const replace = `${find}    timezone: pm_local\n`;

		expect(applyAsAgent(find, replace)).toBe(DOC.replace(find, replace));
	});

	it("still sanitizes the fragment's content", () => {
		const result = applyAsAgent("format: csv", "format: csv [removed]");

		expect(result).toContain("    format: csv\n```");
		expect(result).not.toContain("[removed]");
	});

	it("does not add a trailing newline the matched text lacks", () => {
		const result = applyAsAgent("  output:", "  output:\n");

		expect(result).toBe(DOC);
	});

	it("does not add an indent the matched text lacks", () => {
		const result = applyAsAgent("format: csv", "    format: json");

		expect(result).toBe(DOC.replace("format: csv", "format: json"));
	});

	it("does not split a table when only the row is matched", () => {
		const doc = "## T\n\n| a | b |\n| --- | --- |\n| c | d |\n| e | f |\n";
		const { success, result } = applyPatches(
			doc,
			[{ op: "replace_text", find: "| c | d |", replace: "| x | y |\n" }],
			{
				sanitizeContent: (content) =>
					stripToolDefinitions(content, doc),
			},
		);

		expect(success).toBe(true);
		expect(result).toBe(doc.replace("| c | d |", "| x | y |"));
	});

	it("straightens curly quotes the model introduces and keeps the author's", () => {
		const doc = "## Rules\n\nThe badge reads “Draft only”.\n";
		const { success, result } = applyPatches(
			doc,
			[
				{
					op: "replace_text",
					find: "The badge reads “Draft only”.",
					replace:
						"The badge reads “Draft only”; a missing role shows “Unassigned”.",
				},
			],
			{
				sanitizeContent: (content) =>
					stripToolDefinitions(content, doc),
			},
		);

		expect(success).toBe(true);
		expect(finalizeEditedDocument(result, doc)).toBe(
			'## Rules\n\nThe badge reads “Draft only”; a missing role shows "Unassigned".\n',
		);
	});

	it("keeps an author's closing quote when the edit fragment cuts through the quotation", () => {
		const doc = "## Rules\n\nSay “hello world” twice.\n";
		const { success, result } = applyPatches(
			doc,
			[{ op: "replace_text", find: "world”", replace: "earth”" }],
			{
				sanitizeContent: (content) =>
					stripToolDefinitions(content, doc),
			},
		);

		expect(success).toBe(true);
		expect(finalizeEditedDocument(result, doc)).toBe(
			"## Rules\n\nSay “hello earth” twice.\n",
		);
	});

	it("deletes the text when the replacement is empty", () => {
		const result = applyAsAgent("    format: csv\n", "");

		expect(result).toBe(DOC.replace("    format: csv\n", ""));
	});
});
