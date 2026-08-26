import { describe, expect, it } from "vitest";
import { isEffectivelyBlank } from "../lib/blank-content";

describe("isEffectivelyBlank", () => {
	it.each([
		["an empty string", ""],
		["spaces", "   "],
		["newlines and tabs", "\n\t\n"],
		["a non-breaking space", "\u00A0"],
		["a line separator", "\u2028"],
		// The BOM is the one invisible ECMAScript counts as whitespace, so
		// trim() already removes it. Listed here rather than below to keep the
		// two groups honest about which check is doing the work.
		["a byte order mark", "\uFEFF"],
	])("treats %s as blank, as trim() already would", (_label, text) => {
		expect(isEffectivelyBlank(text)).toBe(true);
	});

	it.each([
		["a zero-width space", "\u200B"],
		["a zero-width non-joiner", "\u200C"],
		["a zero-width joiner", "\u200D"],
		["a left-to-right mark", "\u200E"],
		["a word joiner", "\u2060"],
		["a soft hyphen", "\u00AD"],
		["a Mongolian vowel separator", "\u180E"],
	])("treats %s as blank, which trim() does not", (_label, text) => {
		// The point of the helper: every one of these has length >= 1 after
		// trim(), so a `trim().length === 0` check calls them content.
		expect(text.trim().length).toBeGreaterThan(0);
		expect(isEffectivelyBlank(text)).toBe(true);
	});

	it("treats a mixture of invisibles and whitespace as blank", () => {
		expect(isEffectivelyBlank(" \u200B\n\uFEFF\t\u00AD ")).toBe(true);
	});

	it.each([
		["ordinary prose", "Write an agenda."],
		["a single visible character", "x"],
		["visible content padded with whitespace", "\n  x  \n"],
		["visible content among invisibles", "\u200Bx\uFEFF"],
		["template syntax only", "{{{open_action_items}}}"],
	])("does not treat %s as blank", (_label, text) => {
		expect(isEffectivelyBlank(text)).toBe(false);
	});

	it("does not treat a lone emoji as blank", () => {
		// Emoji are built from surrogate pairs and can carry a zero-width
		// joiner between components. Stripping the joiner must not strip the
		// visible characters around it.
		expect(isEffectivelyBlank("👍")).toBe(false);
		expect(isEffectivelyBlank("👨\u200D💻")).toBe(false);
	});
});
