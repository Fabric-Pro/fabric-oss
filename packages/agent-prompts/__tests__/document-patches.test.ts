/**
 * Tests for document-patches applier.
 *
 * Covers every supported op, the matching cascades (exact → whitespace →
 * suggestions), error shapes, overlap detection, multi-patch determinism,
 * and the sanitizeContent hook.
 *
 * Run with: pnpm --filter @repo/agent-prompts test
 */

import { describe, expect, it } from "vitest";
import {
	applyPatches,
	type DocumentPatch,
	detectRenameIntent,
	diagnoseOverlap,
	findAllMarkdownStructureDefects,
	listAnchorPaths,
	type PatchError,
	resolveAnchor,
	validateMarkdownStructure,
	validatePatches,
} from "../src/core/document-patches";

// =============================================================================
// Fixtures
// =============================================================================

const SIMPLE_DOC = `# Document Title

## Overview

This is the overview of the document.

It spans multiple paragraphs.

## Requirements

### Must Have

- Requirement one
- Requirement two

### Nice to Have

- Wishlist item

## Scope

### In Scope

- First scoped item

### Out of Scope

- Not included
`;

const NESTED_DOC = `## Overview

Top overview.

## Requirements

### Overview

Requirements overview (same H3 text as the top Overview).

### Must Have

Hard requirements here.

## Scope

### Overview

Scope overview (third "Overview" in the document).
`;

// =============================================================================
// listAnchorPaths
// =============================================================================

describe("listAnchorPaths", () => {
	it("returns all headings as full dot-paths", () => {
		const paths = listAnchorPaths(SIMPLE_DOC);
		expect(paths).toEqual([
			"# Document Title",
			"# Document Title > ## Overview",
			"# Document Title > ## Requirements",
			"# Document Title > ## Requirements > ### Must Have",
			"# Document Title > ## Requirements > ### Nice to Have",
			"# Document Title > ## Scope",
			"# Document Title > ## Scope > ### In Scope",
			"# Document Title > ## Scope > ### Out of Scope",
		]);
	});

	it("handles documents with no headings", () => {
		expect(listAnchorPaths("just plain text\n\nmore text")).toEqual([]);
	});

	it("distinguishes repeated H3 text under different parents", () => {
		const paths = listAnchorPaths(NESTED_DOC);
		expect(paths).toContain("## Requirements > ### Overview");
		expect(paths).toContain("## Scope > ### Overview");
		expect(paths.filter((p) => p.endsWith("### Overview"))).toHaveLength(2);
	});
});

// =============================================================================
// resolveAnchor
// =============================================================================

describe("resolveAnchor", () => {
	it("resolves a unique top-level heading", () => {
		const result = resolveAnchor(SIMPLE_DOC, "## Overview");
		expect(result).toMatchObject({
			level: 2,
			text: "Overview",
		});
	});

	it("resolves a nested heading via path", () => {
		const result = resolveAnchor(
			SIMPLE_DOC,
			"## Requirements > ### Must Have",
		);
		expect(result).toMatchObject({
			level: 3,
			text: "Must Have",
		});
	});

	it("returns anchor_ambiguous for a duplicated H3 without parent", () => {
		const result = resolveAnchor(NESTED_DOC, "### Overview");
		expect(result).toMatchObject({
			code: "anchor_ambiguous",
		});
		// @ts-expect-error narrowing
		expect(result.suggestions).toEqual(
			expect.arrayContaining([
				"## Requirements > ### Overview",
				"## Scope > ### Overview",
			]),
		);
	});

	it("resolves the disambiguated repeated H3", () => {
		const req = resolveAnchor(NESTED_DOC, "## Requirements > ### Overview");
		const scope = resolveAnchor(NESTED_DOC, "## Scope > ### Overview");
		expect(req).toMatchObject({ text: "Overview" });
		expect(scope).toMatchObject({ text: "Overview" });
		// @ts-expect-error narrowing
		expect(req.startLine).not.toBe(scope.startLine);
	});

	it("returns anchor_not_found with suggestions when the heading does not exist", () => {
		const result = resolveAnchor(SIMPLE_DOC, "## Nonexistent");
		expect(result).toMatchObject({ code: "anchor_not_found" });
		// @ts-expect-error narrowing
		expect(result.suggestions).toBeDefined();
	});

	it("returns malformed_anchor for empty input", () => {
		const result = resolveAnchor(SIMPLE_DOC, "");
		expect(result).toMatchObject({ code: "malformed_anchor" });
	});

	it("resolves an anchor with extra whitespace around ' > ' separator", () => {
		const result = resolveAnchor(
			SIMPLE_DOC,
			"## Requirements   >    ### Must Have",
		);
		expect(result).toMatchObject({ text: "Must Have" });
	});

	it("resolves an anchor with trailing punctuation on the heading text", () => {
		const doc = "## Overview:\n\nStuff here.\n";
		const result = resolveAnchor(doc, "## Overview");
		expect(result).toMatchObject({ text: "Overview:" });
	});
});

// =============================================================================
// applyPatches — happy paths
// =============================================================================

describe("applyPatches — happy paths", () => {
	it("replace_section preserves the heading by default", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "## Overview",
				content: "A shiny new overview paragraph.",
			},
		];
		const { success, result, appliedCount } = applyPatches(
			SIMPLE_DOC,
			patches,
		);
		expect(success).toBe(true);
		expect(appliedCount).toBe(1);
		expect(result).toContain("## Overview");
		expect(result).toContain("A shiny new overview paragraph.");
		expect(result).not.toContain("This is the overview of the document.");
		// Untouched sections remain.
		expect(result).toContain("## Requirements");
		expect(result).toContain("### Must Have");
	});

	it("replace_section with keepHeading=false replaces the heading line too", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "## Overview",
				content: "## Summary\n\nA new summary section.",
				keepHeading: false,
			},
		];
		const { success, result } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(true);
		expect(result).toContain("## Summary");
		expect(result).not.toContain("## Overview");
	});

	it("insert_after inserts content after the anchored section", () => {
		const patches: DocumentPatch[] = [
			{
				op: "insert_after",
				anchor: "## Overview",
				content: "## New Section\n\nBrand new content here.\n",
			},
		];
		const { success, result } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(true);
		// The new section should land between Overview and Requirements.
		const newIdx = result.indexOf("## New Section");
		const overviewIdx = result.indexOf("## Overview");
		const reqIdx = result.indexOf("## Requirements");
		expect(newIdx).toBeGreaterThan(overviewIdx);
		expect(newIdx).toBeLessThan(reqIdx);
	});

	it("insert_before inserts content before the anchored section", () => {
		const patches: DocumentPatch[] = [
			{
				op: "insert_before",
				anchor: "## Requirements",
				content: "## Prelude\n\nComing before requirements.\n",
			},
		];
		const { success, result } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(true);
		const preludeIdx = result.indexOf("## Prelude");
		const overviewIdx = result.indexOf("## Overview");
		const reqIdx = result.indexOf("## Requirements");
		expect(preludeIdx).toBeGreaterThan(overviewIdx);
		expect(preludeIdx).toBeLessThan(reqIdx);
	});

	it("append_to_section appends content inside the anchored section", () => {
		const patches: DocumentPatch[] = [
			{
				op: "append_to_section",
				anchor: "## Requirements > ### Must Have",
				content: "- Requirement three (new)",
			},
		];
		const { success, result } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(true);
		expect(result).toContain("- Requirement one");
		expect(result).toContain("- Requirement two");
		expect(result).toContain("- Requirement three (new)");
		// New content stays inside Must Have, before Nice to Have.
		const newIdx = result.indexOf("Requirement three (new)");
		const niceToHaveIdx = result.indexOf("### Nice to Have");
		expect(newIdx).toBeLessThan(niceToHaveIdx);
	});

	it("prepend_to_section inserts content right after the heading line", () => {
		const patches: DocumentPatch[] = [
			{
				op: "prepend_to_section",
				anchor: "## Overview",
				content: "An introductory note.\n",
			},
		];
		const { success, result } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(true);
		const noteIdx = result.indexOf("An introductory note.");
		const headingIdx = result.indexOf("## Overview");
		const bodyIdx = result.indexOf("This is the overview of the document.");
		expect(noteIdx).toBeGreaterThan(headingIdx);
		expect(noteIdx).toBeLessThan(bodyIdx);
	});

	it("delete_section removes the section and all its subsections", () => {
		const patches: DocumentPatch[] = [
			{
				op: "delete_section",
				anchor: "## Requirements",
			},
		];
		const { success, result } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(true);
		expect(result).not.toContain("## Requirements");
		expect(result).not.toContain("### Must Have");
		expect(result).not.toContain("### Nice to Have");
		// Sibling sections still present.
		expect(result).toContain("## Overview");
		expect(result).toContain("## Scope");
	});

	it("replace_text splices a literal match inside the anchored section", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				anchor: "## Requirements > ### Must Have",
				find: "Requirement one",
				replace: "Requirement one (updated)",
			},
		];
		const { success, result } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(true);
		expect(result).toContain("- Requirement one (updated)");
		expect(result).toContain("- Requirement two");
	});
});

// =============================================================================
// applyPatches — matching fallback cascades
// =============================================================================

describe("applyPatches — anchor matching cascade", () => {
	it("anchor with extra whitespace around the separator still resolves", () => {
		const patches: DocumentPatch[] = [
			{
				op: "append_to_section",
				anchor: "## Requirements  >  ### Must Have",
				content: "- Extra requirement",
			},
		];
		const { success, result } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(true);
		expect(result).toContain("- Extra requirement");
	});

	it("anchor with trailing punctuation on the heading text still resolves", () => {
		const doc =
			"## Overview:\n\nOverview body.\n\n## Scope\n\nScope body.\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "## Overview",
				content: "New overview body.",
			},
		];
		const { success, result } = applyPatches(doc, patches);
		expect(success).toBe(true);
		expect(result).toContain("New overview body.");
		expect(result).toContain("## Overview:"); // heading preserved
	});

	it("anchor_not_found surfaces nearest-match suggestions", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "## Overveiw", // typo
				content: "whatever",
			},
		];
		const { success, errors } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(false);
		expect(errors[0]).toMatchObject({ code: "anchor_not_found" });
		expect(errors[0].suggestions?.some((s) => s.includes("Overview"))).toBe(
			true,
		);
	});

	it("anchor_ambiguous surfaces every matching full path", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "### Overview",
				content: "whatever",
			},
		];
		const { success, errors } = applyPatches(NESTED_DOC, patches);
		expect(success).toBe(false);
		expect(errors[0]).toMatchObject({ code: "anchor_ambiguous" });
		expect(errors[0].suggestions).toEqual(
			expect.arrayContaining([
				"## Requirements > ### Overview",
				"## Scope > ### Overview",
			]),
		);
	});
});

describe("applyPatches — replace_text matching cascade", () => {
	it("errors with nearest-substring suggestions when find is absent", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				anchor: "## Requirements > ### Must Have",
				find: "Requirement forty-two",
				replace: "Requirement forty-two (impossible)",
			},
		];
		const { success, errors } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(false);
		expect(errors[0]).toMatchObject({ code: "find_not_in_section" });
	});

	it("errors with line info when find appears multiple times", () => {
		const doc =
			"## Things\n\n- Alpha\n- Alpha\n- Alpha\n\n## Other\n\nnope\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				anchor: "## Things",
				find: "- Alpha",
				replace: "- Beta",
			},
		];
		const { success, errors } = applyPatches(doc, patches);
		expect(success).toBe(false);
		expect(errors[0]).toMatchObject({ code: "find_ambiguous_in_section" });
	});

	it("whitespace-normalized fallback splices back to original position", () => {
		const doc =
			"## Overview\n\nThe quick    brown fox jumps over the    lazy dog.\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				anchor: "## Overview",
				find: "The quick brown fox", // different whitespace
				replace: "A slow orange cat",
			},
		];
		const { success, result } = applyPatches(doc, patches);
		expect(success).toBe(true);
		expect(result).toContain("A slow orange cat");
		expect(result).not.toContain("The quick    brown fox");
	});

	it("handles CRLF input with LF-only find string", () => {
		const doc = "## Overview\r\n\r\nLine one\r\nLine two\r\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				anchor: "## Overview",
				find: "Line one\nLine two",
				replace: "Replaced lines",
			},
		];
		const { success, result } = applyPatches(doc, patches);
		expect(success).toBe(true);
		expect(result).toContain("Replaced lines");
	});
});

// =============================================================================
// applyPatches — replace_text replaceAll
// =============================================================================

describe("applyPatches — replace_text replaceAll", () => {
	const MULTI_DOC = `# Guide

## Usage

Open the Documents area to begin.

The Documents area lists every file.

Return to the Documents area when done.

## Notes

The Documents area is described above.
`;

	it("replaces every occurrence across multiple lines", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "Documents area",
				replace: "Documents tab",
				replaceAll: true,
			},
		];
		const { success, result, appliedCount, replaceTextStats } =
			applyPatches(MULTI_DOC, patches);
		expect(success).toBe(true);
		expect(result).not.toContain("Documents area");
		expect(result.match(/Documents tab/g)).toHaveLength(4);
		expect(appliedCount).toBe(1);
		expect(replaceTextStats).toEqual([
			{
				patchIndex: 0,
				find: "Documents area",
				occurrences: 4,
				replaceAll: true,
				residualOccurrences: 0,
			},
		]);
	});

	it("replaces multiple occurrences on a single line", () => {
		const doc =
			"## Overview\n\nThe Documents area links to the Documents area subfolder in the Documents area root.\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "Documents area",
				replace: "Documents tab",
				replaceAll: true,
			},
		];
		const { success, result, replaceTextStats } = applyPatches(
			doc,
			patches,
		);
		expect(success).toBe(true);
		expect(result).toContain(
			"The Documents tab links to the Documents tab subfolder in the Documents tab root.",
		);
		expect(result).not.toContain("Documents area");
		expect(replaceTextStats?.[0]?.occurrences).toBe(3);
	});

	it("anchored replaceAll stays inside the section and reports residual occurrences", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				anchor: "## Usage",
				find: "Documents area",
				replace: "Documents tab",
				replaceAll: true,
			},
		];
		const { success, result, replaceTextStats } = applyPatches(
			MULTI_DOC,
			patches,
		);
		expect(success).toBe(true);
		expect(result.match(/Documents tab/g)).toHaveLength(3);
		// The ## Notes occurrence is outside the anchored scope.
		expect(result).toContain("The Documents area is described above.");
		expect(replaceTextStats).toEqual([
			{
				patchIndex: 0,
				find: "Documents area",
				occurrences: 3,
				replaceAll: true,
				residualOccurrences: 1,
			},
		]);
	});

	it("behaves like a plain replace when replaceAll is true with a single hit", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				anchor: "## Notes",
				find: "Documents area",
				replace: "Documents tab",
				replaceAll: true,
			},
		];
		const { success, result, replaceTextStats } = applyPatches(
			MULTI_DOC,
			patches,
		);
		expect(success).toBe(true);
		expect(result).toContain("The Documents tab is described above.");
		expect(replaceTextStats?.[0]).toMatchObject({
			occurrences: 1,
			replaceAll: true,
		});
	});

	it("errors find_not_in_section when replaceAll finds nothing", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "Documents sidebar",
				replace: "Documents tab",
				replaceAll: true,
			},
		];
		const { success, errors } = applyPatches(MULTI_DOC, patches);
		expect(success).toBe(false);
		expect(errors[0]).toMatchObject({ code: "find_not_in_section" });
	});

	it("replaces every occurrence of a multi-line find", () => {
		const doc =
			"## Steps\n\nfirst line\nsecond line\n\nmiddle text\n\nfirst line\nsecond line\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "first line\nsecond line",
				replace: "single line",
				replaceAll: true,
			},
		];
		const { success, result, replaceTextStats } = applyPatches(
			doc,
			patches,
		);
		expect(success).toBe(true);
		expect(result).not.toContain("first line");
		expect(result.match(/single line/g)).toHaveLength(2);
		expect(replaceTextStats?.[0]?.occurrences).toBe(2);
	});

	it("replaces whitespace-variant occurrences alongside literal hits", () => {
		// Editor round-trips can leave a double space inside one instance of
		// the phrase. A literal-only scan would replace the clean instances
		// and silently leave the variant behind — the exact failure class
		// this feature exists to fix.
		const doc =
			"## Overview\n\nOpen the Documents area now.\n\nThen the Documents  area again.\n\nFinally the Documents area once more.\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "Documents area",
				replace: "Documents tab",
				replaceAll: true,
			},
		];
		const { success, result, replaceTextStats } = applyPatches(
			doc,
			patches,
		);
		expect(success).toBe(true);
		expect(result).not.toMatch(/Documents\s+area/);
		expect(result.match(/Documents tab/g)).toHaveLength(3);
		expect(replaceTextStats?.[0]?.occurrences).toBe(3);
	});

	it("counts whitespace-variant residuals left outside the anchored scope", () => {
		const doc =
			"## Usage\n\nOpen the Documents area now.\n\n## Notes\n\nSee the Documents  area appendix.\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				anchor: "## Usage",
				find: "Documents area",
				replace: "Documents tab",
				replaceAll: true,
			},
		];
		const { success, replaceTextStats } = applyPatches(doc, patches);
		expect(success).toBe(true);
		expect(replaceTextStats?.[0]?.residualOccurrences).toBe(1);
	});

	it("keeps occurrences on adjacent lines as separate non-conflicting edits", () => {
		const doc =
			"## List\n\n- Documents area one\n- Documents area two\n- Documents area three\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "Documents area",
				replace: "Documents tab",
				replaceAll: true,
			},
		];
		const { success, result, replaceTextStats } = applyPatches(
			doc,
			patches,
		);
		expect(success).toBe(true);
		expect(result).not.toContain("Documents area");
		expect(result.match(/Documents tab/g)).toHaveLength(3);
		expect(replaceTextStats?.[0]?.occurrences).toBe(3);
	});

	it("points colliding replaceAll renames at write_document_local", () => {
		const doc =
			"## Overview\n\nAlpha and Beta share this line.\n\nAlpha again elsewhere.\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "Alpha",
				replace: "Gamma",
				replaceAll: true,
			},
			{
				op: "replace_text",
				find: "Beta",
				replace: "Delta",
				replaceAll: true,
			},
		];
		const { success, errors } = applyPatches(doc, patches);
		expect(success).toBe(false);
		expect(errors[0]).toMatchObject({ code: "overlapping_ranges" });
		expect(errors[0].message).toMatch(/write_document_local/);
	});

	it("falls back to whitespace-normalized matching for replaceAll", () => {
		const doc =
			"## Overview\n\nThe quick    brown fox jumps.\n\nThe quick  brown fox naps.\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "The quick brown fox",
				replace: "A slow orange cat",
				replaceAll: true,
			},
		];
		const { success, result, replaceTextStats } = applyPatches(
			doc,
			patches,
		);
		expect(success).toBe(true);
		expect(result).toContain("A slow orange cat jumps.");
		expect(result).toContain("A slow orange cat naps.");
		expect(replaceTextStats?.[0]?.occurrences).toBe(2);
	});

	it("splices a normalized match that ends at the section-body end", () => {
		// Regression pin: the normalization map's sentinel entry must map a
		// match ending at the very end of the search scope back to the full
		// original length (no truncated or runaway splice).
		const doc = "## Overview\n\nkeep this.\nThe  final    phrase";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				anchor: "## Overview",
				find: "The final phrase",
				replace: "REPLACED",
			},
		];
		const { success, result } = applyPatches(doc, patches);
		expect(success).toBe(true);
		expect(result).toContain("keep this.\nREPLACED");
		expect(result).not.toContain("final");
	});

	it("composes with a structured op in the same call", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				anchor: "## Usage",
				find: "Documents area",
				replace: "Documents tab",
				replaceAll: true,
			},
			{
				op: "append_to_section",
				anchor: "## Notes",
				content: "- Appended note",
			},
		];
		const { success, result, appliedCount } = applyPatches(
			MULTI_DOC,
			patches,
		);
		expect(success).toBe(true);
		expect(result.match(/Documents tab/g)).toHaveLength(3);
		expect(result).toContain("- Appended note");
		expect(appliedCount).toBe(2);
	});

	it("still rejects overlapping_ranges when replaceAll collides with another patch", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "Documents area",
				replace: "Documents tab",
				replaceAll: true,
			},
			{
				op: "replace_section",
				anchor: "## Usage",
				content: "Rewritten usage.",
			},
		];
		const { success, errors } = applyPatches(MULTI_DOC, patches);
		expect(success).toBe(false);
		expect(errors[0]).toMatchObject({ code: "overlapping_ranges" });
	});

	it("guides merging when two replace_text patches collide on one line", () => {
		const doc = "## Overview\n\nAlpha and Beta share this line.\n";
		const patches: DocumentPatch[] = [
			{ op: "replace_text", find: "Alpha", replace: "Gamma" },
			{ op: "replace_text", find: "Beta", replace: "Delta" },
		];
		const { success, errors } = applyPatches(doc, patches);
		expect(success).toBe(false);
		expect(errors[0]).toMatchObject({ code: "overlapping_ranges" });
		expect(errors[0].message).toMatch(/merge/i);
		expect(errors[0].message).toMatch(/ONE replace_text/);
	});

	it("mentions replaceAll in the ambiguity error (literal cascade)", () => {
		const doc =
			"## Things\n\n- Alpha\n- Alpha\n- Alpha\n\n## Other\n\nnope\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				anchor: "## Things",
				find: "- Alpha",
				replace: "- Beta",
			},
		];
		const { success, errors } = applyPatches(doc, patches);
		expect(success).toBe(false);
		expect(errors[0]).toMatchObject({ code: "find_ambiguous_in_section" });
		expect(errors[0].message).toMatch(/"replaceAll": true/);
	});

	it("mentions replaceAll in the ambiguity error (normalized cascade)", () => {
		const doc =
			"## Overview\n\nThe quick    brown fox jumps.\n\nThe quick  brown fox naps.\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "The quick brown fox",
				replace: "A slow orange cat",
			},
		];
		const { success, errors } = applyPatches(doc, patches);
		expect(success).toBe(false);
		expect(errors[0]).toMatchObject({ code: "find_ambiguous_in_section" });
		expect(errors[0].message).toMatch(/"replaceAll": true/);
	});

	it("counts patches, not occurrences, in appliedCount", () => {
		const doc =
			"## A\n\nfoo one here.\n\nfoo two here.\n\n## B\n\nbar one here.\n\nbar two here.\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "foo",
				replace: "FOO",
				replaceAll: true,
			},
			{
				op: "replace_text",
				find: "bar",
				replace: "BAR",
				replaceAll: true,
			},
		];
		const { success, appliedCount, replaceTextStats } = applyPatches(
			doc,
			patches,
		);
		expect(success).toBe(true);
		expect(appliedCount).toBe(2);
		expect(replaceTextStats).toHaveLength(2);
		expect(replaceTextStats?.[0]?.occurrences).toBe(2);
		expect(replaceTextStats?.[1]?.occurrences).toBe(2);
	});

	it("does not count self-referential replacements as residuals", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				anchor: "## Usage",
				find: "Documents area",
				replace: "shared Documents area",
				replaceAll: true,
			},
		];
		const { success, replaceTextStats } = applyPatches(MULTI_DOC, patches);
		expect(success).toBe(true);
		// `replace` contains `find`, so residual counting would always
		// self-trigger — it must be suppressed.
		expect(replaceTextStats?.[0]?.residualOccurrences).toBe(0);
	});

	it("keeps the marker-parity check for replaceAll patches", () => {
		const doc =
			"## Overview\n\nSome **bold intro here.\n\nMore **bold text there.\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "**bold",
				replace: "plain",
				replaceAll: true,
			},
		];
		const { success, errors } = applyPatches(doc, patches);
		expect(success).toBe(false);
		expect(errors[0]).toMatchObject({
			code: "invalid_replacement_content",
		});
	});

	it("validatePatches accepts a multi-hit find only when replaceAll is set", () => {
		const withFlag = validatePatches(MULTI_DOC, [
			{
				op: "replace_text",
				find: "Documents area",
				replace: "Documents tab",
				replaceAll: true,
			},
		]);
		expect(withFlag.valid).toBe(true);

		const withoutFlag = validatePatches(MULTI_DOC, [
			{
				op: "replace_text",
				find: "Documents area",
				replace: "Documents tab",
			},
		]);
		expect(withoutFlag.valid).toBe(false);
		expect(withoutFlag.errors[0]).toMatchObject({
			code: "find_ambiguous_in_section",
		});
	});

	it("rejects replaceAll when occurrences exceed the safety cap", () => {
		const lines = Array.from(
			{ length: 101 },
			(_, i) => `- token entry ${i} marker-x end`,
		);
		const doc = `## Bulk\n\n${lines.join("\n")}\n`;
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "marker-x",
				replace: "marker-y",
				replaceAll: true,
			},
		];
		const { success, errors } = applyPatches(doc, patches);
		expect(success).toBe(false);
		expect(errors[0]).toMatchObject({ code: "find_ambiguous_in_section" });
		expect(errors[0].message).toMatch(/limit of 100/);
	});
});

// =============================================================================
// applyPatches — multi-patch semantics
// =============================================================================

describe("applyPatches — multi-patch semantics", () => {
	it("resolves all anchors against the original baseline (no mutate-as-you-go)", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "## Overview",
				content: "New overview.",
			},
			{
				op: "insert_after",
				anchor: "## Overview",
				content: "## Afterword\n\nInserted after overview.\n",
			},
		];
		const { success, result } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(true);
		expect(result).toContain("New overview.");
		expect(result).toContain("## Afterword");
		// Afterword should appear between Overview and Requirements.
		const afterwordIdx = result.indexOf("## Afterword");
		const reqIdx = result.indexOf("## Requirements");
		expect(afterwordIdx).toBeLessThan(reqIdx);
	});

	it("applied output is identical regardless of non-overlapping patch order", () => {
		const a: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "## Overview",
				content: "A",
			},
			{
				op: "replace_section",
				anchor: "## Scope > ### In Scope",
				content: "- Only this\n",
			},
		];
		const b: DocumentPatch[] = [a[1], a[0]];
		const ra = applyPatches(SIMPLE_DOC, a);
		const rb = applyPatches(SIMPLE_DOC, b);
		expect(ra.success).toBe(true);
		expect(rb.success).toBe(true);
		expect(ra.result).toBe(rb.result);
	});

	it("detects overlapping ranges across two replace_section patches", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "## Requirements",
				content: "Block replacement.",
			},
			{
				op: "replace_section",
				anchor: "## Requirements > ### Must Have",
				content: "Another replacement.",
			},
		];
		const { success, errors } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(false);
		const overlap = errors.find((e) => e.code === "overlapping_ranges");
		expect(overlap).toBeDefined();
		// Enriched error: message names both indices and includes line ranges,
		// and the structured overlapRanges field carries the same data so
		// callers (e.g. diagnoseOverlap) don't have to parse text.
		expect(overlap?.message).toMatch(/index \d+/);
		expect(overlap?.message).toMatch(/lines? \d+/);
		expect(overlap?.overlapRanges).toBeDefined();
		expect(overlap?.overlapRanges?.self.startLine).toBeGreaterThan(0);
		expect(overlap?.overlapRanges?.other.startLine).toBeGreaterThan(0);
		expect(overlap?.overlapRanges?.otherIndex).not.toBe(
			overlap?.patchIndex,
		);
	});

	it("returns original document unchanged when any patch fails", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "## Overview",
				content: "ok",
			},
			{
				op: "replace_section",
				anchor: "## Nonexistent",
				content: "doomed",
			},
		];
		const { success, result, errors } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(false);
		expect(result).toBe(SIMPLE_DOC); // untouched
		expect(errors).toHaveLength(1);
	});
});

// =============================================================================
// applyPatches — shape validation
// =============================================================================

describe("applyPatches — shape validation", () => {
	it("errors when replace_text is missing find", () => {
		const patches = [
			{
				op: "replace_text",
				anchor: "## Overview",
				replace: "new",
			},
		] as DocumentPatch[];
		const { success, errors } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(false);
		expect(errors[0]).toMatchObject({ code: "missing_find_replace" });
	});

	it("errors when replace_section is missing content", () => {
		const patches = [
			{
				op: "replace_section",
				anchor: "## Overview",
			},
		] as DocumentPatch[];
		const { success, errors } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(false);
		expect(errors[0]).toMatchObject({ code: "missing_content" });
	});

	it("errors on unsupported op", () => {
		const patches = [
			{
				op: "rewrite_entire_thing" as unknown as DocumentPatch["op"],
				anchor: "## Overview",
				content: "nope",
			},
		] as DocumentPatch[];
		const { success, errors } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(false);
		expect(errors[0]).toMatchObject({ code: "unsupported_op" });
	});
});

// =============================================================================
// sanitizeContent hook
// =============================================================================

describe("applyPatches — sanitizeContent hook", () => {
	it("runs the sanitizer over every patch's content field", () => {
		const seen: string[] = [];
		const sanitize = (c: string) => {
			seen.push(c);
			return c.replace(/BAD/g, "");
		};
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "## Overview",
				content: "Clean BAD content",
			},
			{
				op: "append_to_section",
				anchor: "## Requirements > ### Must Have",
				content: "- New BAD requirement",
			},
		];
		const { success, result } = applyPatches(SIMPLE_DOC, patches, {
			sanitizeContent: sanitize,
		});
		expect(success).toBe(true);
		expect(seen).toHaveLength(2);
		expect(result).toContain("Clean  content");
		expect(result).not.toContain("BAD");
	});

	it("runs the sanitizer on replace_text replace field", () => {
		let sanitized = false;
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				anchor: "## Overview",
				find: "This is the overview",
				replace: "DANGER replaced",
			},
		];
		const { success, result } = applyPatches(SIMPLE_DOC, patches, {
			sanitizeContent: (c) => {
				sanitized = true;
				return c.replace(/DANGER/g, "safe");
			},
		});
		expect(success).toBe(true);
		expect(sanitized).toBe(true);
		expect(result).toContain("safe replaced");
	});
});

// =============================================================================
// validatePatches
// =============================================================================

describe("validatePatches", () => {
	it("returns valid=true for a well-formed patch list", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "## Overview",
				content: "ok",
			},
		];
		expect(validatePatches(SIMPLE_DOC, patches)).toEqual({
			valid: true,
			errors: [],
		});
	});

	it("collects every error without mutating", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "## Missing",
				content: "nope",
			},
			{
				op: "replace_text",
				anchor: "## Overview",
				find: "nonexistent string",
				replace: "whatever",
			},
		];
		const { valid, errors } = validatePatches(SIMPLE_DOC, patches);
		expect(valid).toBe(false);
		expect(errors.length).toBeGreaterThanOrEqual(2);
	});
});

// =============================================================================
// Empty and edge cases
// =============================================================================

describe("applyPatches — edge cases", () => {
	it("empty patches list is a no-op success", () => {
		const { success, result, appliedCount } = applyPatches(SIMPLE_DOC, []);
		expect(success).toBe(true);
		expect(result).toBe(SIMPLE_DOC);
		expect(appliedCount).toBe(0);
	});

	it("handles deep nesting (H2 > H3 > H4)", () => {
		const doc = `## Top

### Middle

#### Leaf

Leaf content.
`;
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "## Top > ### Middle > #### Leaf",
				content: "Replaced leaf content.",
			},
		];
		const { success, result } = applyPatches(doc, patches);
		expect(success).toBe(true);
		expect(result).toContain("Replaced leaf content.");
		expect(result).not.toContain("Leaf content.");
	});
});

// =============================================================================
// Fenced code block immunity
// =============================================================================

describe("applyPatches — fenced code blocks", () => {
	const DOC_WITH_FENCE = [
		"## Overview",
		"",
		"This section shows a shell example:",
		"",
		"```bash",
		"# Install the package",
		"npm install foo",
		"## This is not a heading",
		"```",
		"",
		"And a markdown example:",
		"",
		"~~~markdown",
		"# Fake H1",
		"## Fake H2",
		"### Fake H3",
		"~~~",
		"",
		"End of overview.",
		"",
		"## Requirements",
		"",
		"- First requirement",
		"",
	].join("\n");

	it("listAnchorPaths ignores # lines inside fenced blocks", () => {
		const paths = listAnchorPaths(DOC_WITH_FENCE);
		expect(paths).toEqual(["## Overview", "## Requirements"]);
	});

	it("replace_section replaces the whole Overview including the fences", () => {
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "## Overview",
				content: "New overview without code samples.\n",
			},
		];
		const { success, result } = applyPatches(DOC_WITH_FENCE, patches);
		expect(success).toBe(true);
		expect(result).toContain("## Overview");
		expect(result).toContain("New overview without code samples.");
		// The fake headings inside the fence were part of Overview and must be gone.
		expect(result).not.toContain("# Install the package");
		expect(result).not.toContain("# Fake H1");
		// Requirements is untouched.
		expect(result).toContain("## Requirements");
		expect(result).toContain("- First requirement");
	});

	it("append_to_section on Overview lands after the fences, before Requirements", () => {
		const patches: DocumentPatch[] = [
			{
				op: "append_to_section",
				anchor: "## Overview",
				content: "APPENDED LINE\n",
			},
		];
		const { success, result } = applyPatches(DOC_WITH_FENCE, patches);
		expect(success).toBe(true);
		const appendedIdx = result.indexOf("APPENDED LINE");
		const requirementsIdx = result.indexOf("## Requirements");
		const fenceBashIdx = result.indexOf("# Install the package");
		expect(appendedIdx).toBeGreaterThan(-1);
		expect(requirementsIdx).toBeGreaterThan(-1);
		expect(fenceBashIdx).toBeGreaterThan(-1);
		// The append must land after the fenced content and before Requirements.
		expect(appendedIdx).toBeGreaterThan(fenceBashIdx);
		expect(appendedIdx).toBeLessThan(requirementsIdx);
	});

	it("tilde fence is recognized", () => {
		const doc = [
			"## Alpha",
			"",
			"~~~",
			"## Not a heading",
			"~~~",
			"",
			"## Beta",
			"",
		].join("\n");
		expect(listAnchorPaths(doc)).toEqual(["## Alpha", "## Beta"]);
	});
});

// =============================================================================
// Replacement-content validation
//
// Catches token-level damage emitted by models that the shape/anchor passes
// don't see: half a `**...**` pair dropped, an unclosed code fence, an
// orphan list marker, a stray closing bracket on its own line. All are
// reported as "invalid_replacement_content" with a non-empty message and
// the patch unchanged in the document.
// =============================================================================

describe("replacement content validation", () => {
	const CONTENT_DOC =
		"## Overview\n\nBaseline overview.\n\n## Notes\n\n- one\n- two\n";

	const expectContentRejection = (
		patch: DocumentPatch,
		fragment?: string,
	) => {
		const result = applyPatches(CONTENT_DOC, [patch]);
		expect(result.success).toBe(false);
		expect(result.result).toBe(CONTENT_DOC);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].code).toBe("invalid_replacement_content");
		expect(result.errors[0].patchIndex).toBe(0);
		if (fragment) {
			expect(result.errors[0].message).toContain(fragment);
		}
		const validation = validatePatches(CONTENT_DOC, [patch]);
		expect(validation.valid).toBe(false);
		expect(validation.errors[0].code).toBe("invalid_replacement_content");
	};

	it("rejects replace_section content with an unmatched ** marker", () => {
		expectContentRejection(
			{
				op: "replace_section",
				anchor: "## Overview",
				content: "## Overview\n\n**Important note about overview.\n",
			},
			'literal "**"',
		);
	});

	it("rejects replace_section content with an unclosed code fence", () => {
		expectContentRejection(
			{
				op: "replace_section",
				anchor: "## Overview",
				content: "## Overview\n\nSome prose.\n\n```ts\nconst x = 1;\n",
			},
			"unclosed ``` fenced code block",
		);
	});

	it("rejects replace_section content with an orphan list marker line", () => {
		expectContentRejection(
			{
				op: "replace_section",
				anchor: "## Notes",
				content: "## Notes\n\n- real item\n- \n- another item\n",
			},
			"orphan list marker",
		);
	});

	it("rejects replace_section content with a stray closing bracket line", () => {
		expectContentRejection(
			{
				op: "replace_section",
				anchor: "## Notes",
				content:
					"## Notes\n\n- step one (with note about thing\n)\n- step two\n",
			},
			'contains only ")"',
		);
	});

	it("rejects insert_after content with unbalanced inline backticks", () => {
		expectContentRejection(
			{
				op: "insert_after",
				anchor: "## Overview",
				content: "Calling `foo() to do the thing.\n",
			},
			"literal backtick",
		);
	});

	it("accepts replace_text that preserves ** parity even with one marker per side", () => {
		// Both find and replace have exactly one ** marker — parity preserved.
		// The other half lives in surrounding (unchanged) text. This is
		// legitimate and must not be rejected.
		const doc = "## Overview\n\n**Important** note here.\n";
		const patch: DocumentPatch = {
			op: "replace_text",
			anchor: "## Overview",
			find: "Important** note",
			replace: "Critical** observation",
		};
		const result = applyPatches(doc, [patch]);
		expect(result.success).toBe(true);
		expect(result.result).toContain("**Critical** observation");
	});

	it("accepts balanced bold markers in replace_section content", () => {
		// Body-only replace (no leading heading in content — that's what
		// keepHeading: true expects). Verifies the bold-parity check accepts
		// well-formed content.
		const patch: DocumentPatch = {
			op: "replace_section",
			anchor: "## Overview",
			content: "**Bold one** then **bold two** here.\n",
		};
		const result = applyPatches(CONTENT_DOC, [patch]);
		expect(result.success).toBe(true);
	});

	it("ignores ** that appears inside a fenced code block", () => {
		// **markdown** inside a code block must not count toward the bold parity
		// — it's literal source, not a real bold marker.
		const patch: DocumentPatch = {
			op: "replace_section",
			anchor: "## Overview",
			content:
				"Here's a snippet:\n\n```ts\nconst s = '**not bold**';\n```\n",
		};
		const result = applyPatches(CONTENT_DOC, [patch]);
		expect(result.success).toBe(true);
	});

	it("ignores stray closing bracket inside an inline-code span", () => {
		// `foo)` is inline code; the `)` must not trigger the stray-closer check.
		const patch: DocumentPatch = {
			op: "insert_after",
			anchor: "## Overview",
			content: "Call `process()` to run.\n",
		};
		const result = applyPatches(CONTENT_DOC, [patch]);
		expect(result.success).toBe(true);
	});

	it("delete_section bypasses content validation", () => {
		// delete_section carries no content — must always pass the content check.
		const patch: DocumentPatch = {
			op: "delete_section",
			anchor: "## Notes",
		};
		const result = applyPatches(CONTENT_DOC, [patch]);
		expect(result.success).toBe(true);
	});

	it("content validation runs before anchor resolution", () => {
		// A patch with bad content AND a bad anchor surfaces the content error
		// first — model gets the more actionable feedback.
		const patch: DocumentPatch = {
			op: "replace_section",
			anchor: "## Does Not Exist",
			content: "## Does Not Exist\n\n**unbalanced",
		};
		const result = applyPatches(CONTENT_DOC, [patch]);
		expect(result.success).toBe(false);
		expect(result.errors[0].code).toBe("invalid_replacement_content");
	});

	it("rejects content with a line led by ';' (split prose)", () => {
		expectContentRejection(
			{
				op: "replace_section",
				anchor: "## Notes",
				content:
					"## Notes\n\n- Successful execution: step status shows all steps completed\n; output reflects the requested task\n",
			},
			'starts with ";"',
		);
	});

	it("rejects content with a line led by ',' (split prose)", () => {
		expectContentRejection(
			{
				op: "replace_section",
				anchor: "## Notes",
				content:
					"## Notes\n\nThe agent runs the tools\n, then reports\n",
			},
			'starts with ","',
		);
	});
});

// =============================================================================
// validateMarkdownStructure — exercised directly so write_document_local can
// re-use the same rule set as apply_document_patches.
// =============================================================================

describe("validateMarkdownStructure", () => {
	it("returns null on well-formed content", () => {
		const content =
			"## Heading\n\nA paragraph with **bold** text and `code`.\n\n- bullet one\n- bullet two\n";
		expect(validateMarkdownStructure(content)).toBeNull();
	});

	it("flags unbalanced bold", () => {
		const defect = validateMarkdownStructure(
			"## Title\n\n**Important note about scope.\n",
		);
		expect(defect?.code).toBe("unrendered_bold");
	});

	it("flags an unclosed code fence", () => {
		const defect = validateMarkdownStructure(
			"## Title\n\n```ts\nconst x = 1;\n",
		);
		expect(defect?.code).toBe("unclosed_code_fence");
	});

	it("flags unbalanced inline backticks", () => {
		const defect = validateMarkdownStructure("Run `foo() to do X.\n");
		expect(defect?.code).toBe("unbalanced_inline_code");
	});

	it("flags an orphan list marker", () => {
		const defect = validateMarkdownStructure(
			"## Notes\n\n- real item\n- \n",
		);
		expect(defect?.code).toBe("orphan_list_marker");
	});

	it("flags a stray closing bracket on its own line", () => {
		const defect = validateMarkdownStructure(
			"- step (with note about thing\n)\n",
		);
		expect(defect?.code).toBe("stray_closing_bracket");
	});

	it("flags a line led by ';'", () => {
		const defect = validateMarkdownStructure(
			"- step one: does the thing\n; then continues\n",
		);
		expect(defect?.code).toBe("leading_mid_sentence_punct");
	});

	it("flags a line led by ',' even with leading whitespace", () => {
		const defect = validateMarkdownStructure(
			"The agent runs\n  , then exits.\n",
		);
		expect(defect?.code).toBe("leading_mid_sentence_punct");
	});

	it("flags a line led by ':' (split prose pattern)", () => {
		// Pattern observed in production: model emits "Evidence A" as one
		// line and ": Acceptance criteria state..." as the next, which
		// renders as a fragmented bullet structure.
		const defect = validateMarkdownStructure(
			"Evidence A\n: Acceptance criteria state agent provides fallback.\n",
		);
		expect(defect?.code).toBe("leading_mid_sentence_punct");
	});

	it("flags a list item whose content begins with ':' (split sentence across bullets)", () => {
		// Same defect class but the leading punct is INSIDE a bullet:
		// "- : Acceptance criteria..." — the bullet's content starts with ":"
		// because the model put "Evidence A" in one bullet and the colon-
		// continuation in the next.
		const defect = validateMarkdownStructure(
			"- Evidence A\n- : Acceptance criteria state agent provides fallback.\n",
		);
		expect(defect?.code).toBe("leading_mid_sentence_punct");
	});

	it("flags a numbered list item whose content begins with ';'", () => {
		const defect = validateMarkdownStructure(
			"1. Step one runs\n2. ; then it exits\n",
		);
		expect(defect?.code).toBe("leading_mid_sentence_punct");
	});

	it("flags a line led by '?' (severed question continuation)", () => {
		// Production pattern: model emitted a bullet ending with one
		// question, then started a new paragraph with "? Are there
		// predefined rules…?" — a question fragment torn from the previous
		// sentence.
		const defect = validateMarkdownStructure(
			"- Classification Logic: How will AI determine whether an item is a bug or feature\n\n? Are there predefined rules, keywords, or ML models involved?\n",
		);
		expect(defect?.code).toBe("leading_mid_sentence_punct");
	});

	it("flags a line led by '!' (severed exclamation continuation)", () => {
		const defect = validateMarkdownStructure(
			"The build succeeded\n! And all tests passed.\n",
		);
		expect(defect?.code).toBe("leading_mid_sentence_punct");
	});

	it("flags a list item whose content begins with '?'", () => {
		// "- ? Why does this happen?" — the bullet body starts with "?",
		// which means it's a fragment severed from the previous bullet.
		const defect = validateMarkdownStructure(
			"- The system fails on input X\n- ? Why does this happen?\n",
		);
		expect(defect?.code).toBe("leading_mid_sentence_punct");
	});

	it("does not flag legitimate uses of ':' inside line content", () => {
		// "Time: 12:30 PM" is fine — line doesn't start with ":".
		expect(
			validateMarkdownStructure("Meeting at Time: 12:30 PM\n"),
		).toBeNull();
		// "Evidence A: Acceptance criteria..." as one line is the canonical
		// pattern the broken version is trying to express. Must not be flagged.
		expect(
			validateMarkdownStructure(
				"- Evidence A: Acceptance criteria state agent provides fallback.\n",
			),
		).toBeNull();
	});

	it("ignores ';' inside an inline code span", () => {
		expect(
			validateMarkdownStructure(
				"Use `for (i=0; i<n; i++)` to iterate.\n",
			),
		).toBeNull();
	});

	it("ignores ';' inside a fenced code block", () => {
		expect(
			validateMarkdownStructure(
				"## Snippet\n\n```ts\nconst x = 1;\nconst y = 2;\n```\n",
			),
		).toBeNull();
	});

	it("returns the first defect when multiple are present (deterministic order)", () => {
		// Fence parity is checked before AST parsing (the parser would
		// silently extend an open fence), so the unclosed fence wins over
		// the unbalanced bold here.
		const defect = validateMarkdownStructure(
			"## Title\n\n**unbalanced bold\n\n```ts\nconst x = 1;\n",
		);
		expect(defect?.code).toBe("unclosed_code_fence");
	});

	it("flags a bold span that crosses a blank line", () => {
		// Pattern observed in production: model emits **A and B** with a blank
		// line between, intending a single bold phrase but rendering as
		// literal `**` on each side. Total `**` count is even (2), but each
		// `**` ends up in a separate paragraph's text node — both contain
		// literal `**`, which the unrendered_bold rule catches.
		const defect = validateMarkdownStructure(
			"## Section\n\n**Gap: Error Message Scope and\n\nTone**\n",
		);
		expect(defect?.code).toBe("unrendered_bold");
	});

	it("accepts bold spans confined to a single paragraph", () => {
		// Same number of `**` markers, but kept inside one paragraph.
		expect(
			validateMarkdownStructure(
				"## Section\n\n**Gap: Error Message Scope and Tone**\n\nMore prose.\n",
			),
		).toBeNull();
	});

	it("accepts multiple separate bold spans across paragraphs", () => {
		// Each `**...**` self-contained on a single paragraph — fine even
		// though there are blank lines BETWEEN spans.
		expect(
			validateMarkdownStructure(
				"**First** intro paragraph.\n\n**Second** new paragraph.\n",
			),
		).toBeNull();
	});

	it("flags a bullet whose text starts with a stray ordered marker", () => {
		// Pattern observed in production: model writes the first item as
		// `1.` then switches to `- 2.` / `- 3.`. Renderer shows item 1 as a
		// proper ordered item, items 2/3 as bullets with literal "2." / "3."
		// in front. Confirmed by adjacent line also matching.
		const defect = validateMarkdownStructure(
			"## Execution & Status\n\n1. What defines a step?\n- 2. How should the system handle partial success?\n- 3. What constitutes a fallback output?\n",
		);
		expect(defect?.code).toBe("mixed_list_markers");
	});

	it("does not flag isolated `- 1980. event` style bullets (year/number is genuine prose)", () => {
		// No corroborating ordered-list neighbor and no other `- N.` line
		// nearby — single occurrence treated as legitimate content.
		expect(
			validateMarkdownStructure(
				"## Timeline\n\n- 1980. Some historical event.\n- A different bullet about something else entirely.\n",
			),
		).toBeNull();
	});

	it("accepts a clean ordered list", () => {
		expect(
			validateMarkdownStructure(
				"## Steps\n\n1. First step\n2. Second step\n3. Third step\n",
			),
		).toBeNull();
	});

	it("accepts a clean unordered list", () => {
		expect(
			validateMarkdownStructure(
				"## Notes\n\n- First note\n- Second note\n- Third note\n",
			),
		).toBeNull();
	});

	it("flags `**-**` wrapping only a hyphen (no word chars between markers)", () => {
		// Production pattern: `User**-**facing` renders as literal `**-**`
		// because the bold span has no word characters inside the markers.
		const defect = validateMarkdownStructure(
			"## Audience\n\nUser**-**facing observability for engineering teams.\n",
		);
		expect(defect?.code).toBe("unrendered_bold");
	});

	it("flags `**,**` wrapping only a comma", () => {
		const defect = validateMarkdownStructure(
			"## Status\n\nexecution status**,** showing which steps completed.\n",
		);
		expect(defect?.code).toBe("unrendered_bold");
	});

	it("flags an empty `****` span", () => {
		const defect = validateMarkdownStructure(
			"## Section\n\nThe value is**** missing here.\n",
		);
		expect(defect?.code).toBe("unrendered_bold");
	});

	it("flags `** **` wrapping only whitespace", () => {
		const defect = validateMarkdownStructure(
			"## Section\n\nA word** **followed by another.\n",
		);
		expect(defect?.code).toBe("unrendered_bold");
	});

	it("accepts proper bold spans with word content", () => {
		expect(
			validateMarkdownStructure(
				"## Section\n\n**Important:** read carefully. The **system** is **ready**.\n",
			),
		).toBeNull();
	});

	it("accepts bold spans with mixed word + punctuation content", () => {
		// `**Bold-text!**` has word chars, even though it includes punctuation.
		expect(
			validateMarkdownStructure(
				"## Section\n\nReady: **All checks passed!** Continue.\n",
			),
		).toBeNull();
	});

	it("accepts bold spans wrapping numerals", () => {
		// Digits count as word chars; `**42**` is legitimate.
		expect(
			validateMarkdownStructure(
				"## Stats\n\nFailures dropped to **0** in the last run.\n",
			),
		).toBeNull();
	});

	it("flags `** Bold**` (leading whitespace inside markers)", () => {
		// Per CommonMark, `**` followed by whitespace cannot open emphasis.
		const defect = validateMarkdownStructure(
			"## Section\n\n** User Scope & Permissions**\n\nMore content.\n",
		);
		expect(defect?.code).toBe("unrendered_bold");
	});

	it("flags `**Bold **` (trailing whitespace inside markers)", () => {
		const defect = validateMarkdownStructure(
			"## Section\n\nThe **Status ** indicator shows progress.\n",
		);
		expect(defect?.code).toBe("unrendered_bold");
	});

	it("flags `** Bold **` (whitespace on both sides inside markers)", () => {
		const defect = validateMarkdownStructure(
			"## Section\n\nA ** wrapped phrase ** breaks the bold.\n",
		);
		expect(defect?.code).toBe("unrendered_bold");
	});

	it("accepts a tight `**Bold**` with no internal whitespace", () => {
		expect(
			validateMarkdownStructure(
				"## Section\n\nA proper **bold phrase** in the middle.\n",
			),
		).toBeNull();
	});

	it("flags `**Heading**Body` smushing (closed bold immediately followed by uppercase word)", () => {
		// Production pattern: model emitted **Edge Case: Passkey
		// Authentication**Users with no separator. Bold renders correctly
		// but fuses visually with the next word.
		const defect = validateMarkdownStructure(
			"## Notes\n\n**Edge Case: Passkey Authentication**Users with configured passkeys can authenticate.\n",
		);
		expect(defect?.code).toBe("bold_followed_by_word");
	});

	it("accepts `**Heading**` followed by a space then text", () => {
		expect(
			validateMarkdownStructure(
				"## Notes\n\n**Edge Case** Users with configured passkeys can authenticate.\n",
			),
		).toBeNull();
	});

	it("accepts `**Heading**` followed by punctuation (`.`, `:`, `!`)", () => {
		expect(
			validateMarkdownStructure(
				"## Notes\n\n**Done.** **Note:** Important. **Stop!**\n",
			),
		).toBeNull();
	});

	it("flags an unpaired `**` at end of line followed by content with `**` on the next line", () => {
		// Production pattern: `User **\nStory**` — neither `**` participates
		// in emphasis because the opener is followed by a newline.
		const defect = validateMarkdownStructure(
			"## Heading\n\nUser **\nStory**\n\nMore content.\n",
		);
		expect(defect?.code).toBe("unrendered_bold");
	});

	it("accepts a bold span that opens mid-line and closes on the next line (legitimate multi-line bold)", () => {
		// `**This is the start\nand this is the end**` — opener is followed
		// by 'T' (non-whitespace), closer is preceded by 'd' (non-whitespace).
		// CommonMark treats the soft break inside the span as a space.
		expect(
			validateMarkdownStructure(
				"## Quote\n\n**This is the start\nand this is the end**\n",
			),
		).toBeNull();
	});

	it("accepts a line that ends with bold (paired markers on the same line)", () => {
		// `Some text **with bold at the end**` — line ends with `**`, but
		// markers count is even (2), so the trailing `**` is paired and the
		// detector skips this line.
		expect(
			validateMarkdownStructure(
				"## Section\n\nSome text **with bold at the end**\n",
			),
		).toBeNull();
	});
});

// =============================================================================
// Content-preservation guard
//
// Catches the case where the model emits a patch (or set of patches) whose
// scope is so broad that applying them would destroy most of the document.
// Observed in production: a single replace_section anchored on a top-level
// heading that wiped 99% of an 8.8 KB feature analysis. The shape and content
// validators accept the patch as well-formed; only the post-apply length
// comparison can catch this class of damage.
// =============================================================================

describe("content-preservation guard", () => {
	const buildLargeDoc = () => {
		// ~1500 chars, comfortably over the 500-char minimum for the check.
		const sections: string[] = ["# Feature Analysis"];
		for (let i = 1; i <= 5; i++) {
			sections.push(
				`\n## Section ${i}\n\n${"Substantive paragraph content. ".repeat(20)}\n`,
			);
		}
		return sections.join("\n");
	};

	it("rejects a patch that wipes almost the entire document", () => {
		const doc = buildLargeDoc();
		// replace_section on the document root with a tiny replacement —
		// mimics the "Active Analysis" failure mode.
		const patch: DocumentPatch = {
			op: "replace_section",
			anchor: "# Feature Analysis",
			content: "TL;DR\n",
			keepHeading: false,
		};
		const result = applyPatches(doc, [patch]);
		expect(result.success).toBe(false);
		expect(result.result).toBe(doc); // original returned unchanged
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].code).toBe("excessive_content_loss");
		expect(result.errors[0].message).toContain("retained");
		expect(result.errors[0].message).toContain("lost");
		expect(result.errors[0].message).toContain("write_document_local");
	});

	it("accepts a patch that legitimately rewrites a small portion", () => {
		const doc = buildLargeDoc();
		// Replace one section out of five — well within the 80% retention floor.
		const patch: DocumentPatch = {
			op: "replace_section",
			anchor: "## Section 3",
			content: "Updated section content with similar density of prose.\n",
		};
		const result = applyPatches(doc, [patch]);
		expect(result.success).toBe(true);
		expect(result.result).not.toBe(doc);
		expect(result.result.length).toBeGreaterThan(doc.length * 0.7);
	});

	it("skips the preservation check for documents under the size floor", () => {
		// A short doc (< 500 chars) is allowed to be transformed dramatically —
		// the percentage floor isn't meaningful at that scale and small docs
		// can legitimately be replaced wholesale.
		const shortDoc = "## Notes\n\nFirst draft, will be replaced.\n";
		const patch: DocumentPatch = {
			op: "replace_section",
			anchor: "## Notes",
			content: "A.\n",
		};
		const result = applyPatches(shortDoc, [patch]);
		expect(result.success).toBe(true);
	});

	it("attributes the error to the first patch and includes available anchors", () => {
		const doc = buildLargeDoc();
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "# Feature Analysis",
				content: "wiped\n",
				keepHeading: false,
			},
		];
		const result = applyPatches(doc, patches);
		expect(result.success).toBe(false);
		expect(result.errors[0].patchIndex).toBe(0);
		expect(result.errors[0].anchor).toBe("# Feature Analysis");
		expect(result.availableAnchorPaths).toBeDefined();
		expect(result.availableAnchorPaths!.length).toBeGreaterThan(0);
	});
});

// =============================================================================
// Post-apply structural validation — `validatePatchContent` skips per-patch
// shape checks for `replace_text` and relies on a whole-document validator
// pass after all patches apply. These tests pin that pass in place.
// =============================================================================

describe("post-apply structural validation", () => {
	it("rejects a replace_text that strands a ** marker mid-bold", () => {
		// Reviewer's exact example: replacing `Important** note` with
		// `Critical observation` inside `**Important** note here.` produces
		// `**Critical observation here.` — unbalanced **.
		const doc =
			"**Important** note here. This is a paragraph in the document with enough content to satisfy the various length thresholds the applier checks against.";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "Important** note",
				replace: "Critical observation",
			},
		];
		const result = applyPatches(doc, patches);
		expect(result.success).toBe(false);
		expect(result.result).toBe(doc);
		expect(result.errors).toHaveLength(1);
		// Either layer may catch this: the per-patch parity check fires
		// at validatePatchContent (replace_text find/replace marker counts
		// disagree in odd/even parity) → invalid_replacement_content; or
		// the post-apply structural check fires after assembly →
		// invalid_document_structure. Both are correct rejections.
		expect(
			[
				"invalid_replacement_content",
				"invalid_document_structure",
			].includes(result.errors[0].code),
		).toBe(true);
		expect(result.errors[0].patchIndex).toBe(0);
		expect(result.errors[0].message).toMatch(/parity|balanced/);
	});

	it("accepts a replace_text whose substitution preserves marker parity", () => {
		const doc =
			"**Important** note here. This is a paragraph in the document with enough content to satisfy the various length thresholds the applier checks against.";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "**Important** note",
				replace: "**Critical** observation",
			},
		];
		const result = applyPatches(doc, patches);
		expect(result.success).toBe(true);
		expect(result.result).toContain("**Critical** observation");
	});

	it("allows unrelated edits on an already-malformed baseline (same defect code persists)", () => {
		// Baseline already has an unmatched `**` in the Intro section. A
		// replace_text patch against a *different* section ("Target") must
		// not be rejected just because the post-apply doc still has the
		// pre-existing damage in Intro. Both baseline and result report
		// the same defect code (unrendered_bold) → tolerate.
		const doc = [
			"## Intro",
			"",
			"**Old broken paragraph with an unmatched marker that was written before the validators existed and has been sitting in the doc untouched for ages.",
			"",
			"## Target",
			"",
			"This section is the one we want to edit. It has plain prose and no markers at all so the replace_text below cannot introduce a new defect.",
			"",
		].join("\n");
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "we want to edit",
				replace: "we are editing",
			},
		];
		const result = applyPatches(doc, patches);
		expect(result.success).toBe(true);
		expect(result.result).toContain("we are editing");
		// Baseline damage carries through unchanged.
		expect(result.result).toContain("**Old broken paragraph");
	});

	it("rejects a patch that introduces a new defect of a different code on a damaged baseline", () => {
		// Baseline already has an unmatched `**` (unrendered_bold). The
		// patch against a different section introduces an unclosed code
		// fence (unclosed_code_fence). Codes differ → reject. This is the
		// reviewer's exact scenario for catching `replace_text` patches
		// that introduce new malformed markdown even on already-damaged docs.
		const doc = [
			"## Intro",
			"",
			"**Old broken paragraph with an unmatched marker that has been sitting in this doc for ages and ages without anyone editing it.",
			"",
			"## Target",
			"",
			"This section is the one being edited and contains plain prose with enough length to satisfy the various length thresholds the applier checks against.",
			"",
		].join("\n");
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "plain prose",
				// Replacement opens a fence but never closes it.
				replace: "code:\n```ts\nconst x = 1;",
			},
		];
		const result = applyPatches(doc, patches);
		expect(result.success).toBe(false);
		expect(result.result).toBe(doc);
		expect(result.errors).toHaveLength(1);
		// Per-patch parity catches this early (find has 0 fence boundaries,
		// replace has 1) → invalid_replacement_content. Post-apply structure
		// would also catch it. Either is a correct rejection.
		expect(
			[
				"invalid_replacement_content",
				"invalid_document_structure",
			].includes(result.errors[0].code),
		).toBe(true);
		expect(result.errors[0].message).toMatch(
			/code fence|fence|parity|balanced/,
		);
	});

	it("rejects a patch that introduces new damage on a baseline with a pre-existing unclosed fence", () => {
		// Baseline has an unclosed code fence in a deferred section AND a
		// `## Target` section in pre-fence prose. A replace_text patch
		// against `## Target` introduces a new unmatched `**` in the
		// edited line. Without the AST-visit pass running on documents
		// with an open fence, the baseline+result comparison would see
		// only the pre-existing unclosed_code_fence in both and tolerate
		// the new bold damage. The fix continues AST visits for pre-fence
		// content even when the source-level fence count is odd.
		const doc = [
			"## Target",
			"",
			"This section is the one being edited and contains plain prose with enough length to satisfy the various length thresholds the applier checks against.",
			"",
			"## Code Block",
			"",
			"```ts",
			"const x = 1;",
			"// fence is intentionally never closed — pre-existing damage",
			"const y = 2;",
		].join("\n");
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "plain prose",
				// Replacement adds a NEW unmatched `**` in pre-fence content.
				replace: "new **broken marker",
			},
		];
		const result = applyPatches(doc, patches);
		expect(result.success).toBe(false);
		expect(result.result).toBe(doc);
		expect(result.errors).toHaveLength(1);
		// Per-patch parity catches new ** at substring level →
		// invalid_replacement_content. Post-apply structural also catches.
		expect(
			[
				"invalid_replacement_content",
				"invalid_document_structure",
			].includes(result.errors[0].code),
		).toBe(true);
	});

	it("rejects a patch that introduces a new same-code defect in the edited section", () => {
		// Baseline has an unmatched `**` in Intro. The patch against Target
		// introduces a SECOND unmatched `**` in the edited content. Both
		// defects share the same code (unrendered_bold), but the new one
		// falls inside the patch's edit range — line-range comparison
		// catches it where pure code comparison would not.
		const doc = [
			"## Intro",
			"",
			"**Old broken paragraph with an unmatched marker that has been sitting in this doc for ages and ages without anyone editing it.",
			"",
			"## Target",
			"",
			"This section is the one being edited and contains plain prose with enough length to satisfy the various length thresholds the applier checks against.",
			"",
		].join("\n");
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "plain prose",
				// Replacement adds a NEW unmatched `**` inside the edited section.
				replace: "new **broken marker",
			},
		];
		const result = applyPatches(doc, patches);
		expect(result.success).toBe(false);
		expect(result.result).toBe(doc);
		expect(result.errors).toHaveLength(1);
		// Per-patch parity catches the new ** before assembly →
		// invalid_replacement_content. Post-apply structural would also
		// catch it via line-range comparison. Either is correct.
		expect(
			[
				"invalid_replacement_content",
				"invalid_document_structure",
			].includes(result.errors[0].code),
		).toBe(true);
	});

	it("rejects a replace_text that strands a single backtick across an unclosed fence", () => {
		// Reviewer's exact scenario: baseline has an old unclosed ``` fence
		// that masks the parser past it. A replace_text against text after
		// the fence introduces a stranded inline backtick. The parser
		// consumes the edited line as code text so the post-apply AST
		// check is blind. The substring-level inline-backtick parity
		// counter catches this.
		const doc = [
			"## Intro",
			"",
			"Some prose to start the document.",
			"",
			"```ts",
			"const x = 1;",
			"// fence is intentionally never closed — pre-existing damage",
			"## Target",
			"old text that we want to edit",
		].join("\n");
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "old text",
				// Replacement adds a stranded single backtick (no closing).
				replace: "new `broken inline marker",
			},
		];
		const result = applyPatches(doc, patches);
		expect(result.success).toBe(false);
		expect(result.result).toBe(doc);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].code).toBe("invalid_replacement_content");
		expect(result.errors[0].message).toMatch(/parity/);
	});

	it("rejects a replace_text that mismatches inline-code delimiter lengths", () => {
		// Reviewer's exact scenario: replace introduces one 2-backtick run
		// and one 1-backtick run. Total run count is 2 (even, would pass a
		// naive aggregate parity check), but CommonMark requires opening
		// and closing inline-code delimiters to match in length, so the
		// 1-run can't close the 2-run. The by-length parity counter
		// catches this independently of document parser state — necessary
		// because a baseline with an unclosed ``` fence would otherwise
		// blind the post-apply AST check to the new damage.
		const doc = [
			"## Intro",
			"",
			"Some prose to start the document.",
			"",
			"```ts",
			"const x = 1;",
			"// fence is intentionally never closed — pre-existing damage",
			"## Target",
			"old text that we want to edit",
		].join("\n");
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "old text",
				// One 2-run opener, one 1-run closer — won't pair.
				replace: "``broken`",
			},
		];
		const result = applyPatches(doc, patches);
		expect(result.success).toBe(false);
		expect(result.result).toBe(doc);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].code).toBe("invalid_replacement_content");
		expect(result.errors[0].message).toMatch(/parity/);
	});

	it("accepts a replace_text that adds a complete inline-code pair", () => {
		// Adding a full `code` pair (2 backticks, even count) is legitimate
		// and must not be flagged just because backticks appeared in replace
		// where there were none in find.
		const doc =
			"## Section\n\nThis section has plain prose without any code references in it at all so the replacement adds new code references.\n";
		const patches: DocumentPatch[] = [
			{
				op: "replace_text",
				find: "any code references",
				replace: "any `code` references",
			},
		];
		const result = applyPatches(doc, patches);
		expect(result.success).toBe(true);
		expect(result.result).toContain("any `code` references");
	});
});

describe("findAllMarkdownStructureDefects", () => {
	it("returns all defects with their lines, not just the first", () => {
		// Document has two distinct unrendered_bold defects on different lines.
		const doc = [
			"## Intro",
			"",
			"**unmatched marker line 1",
			"",
			"## Body",
			"",
			"**another unmatched marker on a later line",
			"",
		].join("\n");
		const defects = findAllMarkdownStructureDefects(doc);
		expect(defects.length).toBeGreaterThanOrEqual(2);
		const unrenderedBoldLines = defects
			.filter((d) => d.code === "unrendered_bold")
			.map((d) => d.line);
		expect(unrenderedBoldLines).toContain(3);
		expect(unrenderedBoldLines).toContain(7);
	});

	// A table that stops parsing renders as literal pipe/dash text. remark
	// reports no table node for exactly these shapes, so without a dedicated
	// rule a broken table sails through validation and reaches the document.
	describe("broken_table", () => {
		const codes = (doc: string) =>
			findAllMarkdownStructureDefects(doc).map((d) => d.code);

		it("accepts a well-formed table", () => {
			const doc = [
				"## Owners",
				"",
				"| Role | Owner |",
				"| --- | --- |",
				"| PM | Alice |",
				"",
			].join("\n");
			expect(codes(doc)).not.toContain("broken_table");
		});

		it("accepts a table with alignment markers and empty cells", () => {
			const doc = [
				"| Role | Owner | Notes |",
				"|:--- | :---: | ---:|",
				"| PM | Alice |  |",
				"",
			].join("\n");
			expect(codes(doc)).not.toContain("broken_table");
		});

		it("flags pipe rows with no separator row", () => {
			const doc = [
				"## Owners",
				"",
				"| Role | Owner |",
				"| PM | Alice |",
				"",
			].join("\n");
			expect(codes(doc)).toContain("broken_table");
		});

		it("flags a table collapsed onto a single line", () => {
			const doc = [
				"## Owners",
				"",
				"| Role | Owner | | --- | --- | | PM | Alice |",
				"",
			].join("\n");
			expect(codes(doc)).toContain("broken_table");
		});

		it("accepts a header row directly after prose — GFM tables interrupt paragraphs", () => {
			// Verified against both remark-gfm and markdown-it: a table glued
			// to a prose line above still parses as a table, so flagging it
			// would hard-fail legitimate whole-document rewrites.
			const doc = [
				"## Owners",
				"",
				"The register is below.",
				"| Role | Owner |",
				"| --- | --- |",
				"| PM | Alice |",
				"",
			].join("\n");
			expect(codes(doc)).not.toContain("broken_table");
		});

		it("flags a table glued to a list item above it", () => {
			// A list item absorbs the rows as continuation text in both
			// parsers — this is the glued shape that genuinely breaks.
			const doc = [
				"## Owners",
				"",
				"- the register:",
				"| Role | Owner |",
				"| --- | --- |",
				"| PM | Alice |",
				"",
			].join("\n");
			expect(codes(doc)).toContain("broken_table");
		});

		it("flags a table glued to a blockquote above it", () => {
			const doc = [
				"> quoted note",
				"| Role | Owner |",
				"| --- | --- |",
				"| PM | Alice |",
				"",
			].join("\n");
			expect(codes(doc)).toContain("broken_table");
		});

		it("ignores pipes inside a fenced code block", () => {
			const doc = [
				"```text",
				"| Role | Owner |",
				"| PM | Alice |",
				"```",
				"",
			].join("\n");
			expect(codes(doc)).not.toContain("broken_table");
		});

		it("ignores a single prose line containing a pipe", () => {
			const doc = ["Use `a | b` to combine them.", ""].join("\n");
			expect(codes(doc)).not.toContain("broken_table");
		});
	});
});

// =============================================================================
// detectRenameIntent — recognizes the "model anchored to the rename target
// instead of the existing heading" pattern that tanked Active Analysis runs.
// =============================================================================

describe("detectRenameIntent", () => {
	const buildErr = (anchor: string): PatchError => ({
		patchIndex: 0,
		op: "replace_section",
		anchor,
		code: "anchor_not_found",
		message: `No heading matches "${anchor}".`,
	});

	const PASSIVE_DOC =
		"# Passive Analysis: Nexus AI Agent Step Status\n\n## Context Summary\n\nFoo.\n\n## Key Points\n\nBar.\n";

	it("detects a clean Passive→Active rename across multiple failing patches", () => {
		const errors = [
			buildErr(
				"# Active Analysis: Nexus AI Agent Step Status > ## Context Summary",
			),
			buildErr(
				"# Active Analysis: Nexus AI Agent Step Status > ## Key Points",
			),
			buildErr(
				"# Active Analysis: Nexus AI Agent Step Status > ## Risks",
			),
		];
		const intent = detectRenameIntent(PASSIVE_DOC, errors);
		expect(intent).not.toBeNull();
		expect(intent!.currentAnchor).toBe(
			"# Passive Analysis: Nexus AI Agent Step Status",
		);
		expect(intent!.proposedAnchor).toBe(
			"# Active Analysis: Nexus AI Agent Step Status",
		);
		expect(intent!.level).toBe(1);
	});

	it("returns null when patches use different first segments", () => {
		// Mixed first segments — model isn't doing a coherent rename, just
		// confused. Don't auto-suggest a single rename.
		const errors = [
			buildErr("# Active Analysis: Foo > ## Context"),
			buildErr("# Different Title Entirely > ## Context"),
		];
		expect(detectRenameIntent(PASSIVE_DOC, errors)).toBeNull();
	});

	it("returns null when there are no anchor_not_found errors", () => {
		const errors: PatchError[] = [
			{
				patchIndex: 0,
				op: "replace_text",
				anchor: "# Passive Analysis: Nexus AI Agent Step Status",
				code: "find_not_in_section",
				message: "find string not present.",
			},
		];
		expect(detectRenameIntent(PASSIVE_DOC, errors)).toBeNull();
	});

	it("returns null when the proposed anchor matches an existing heading", () => {
		// The proposed anchor exists — failure must be at a deeper segment,
		// so it's not a top-level rename. Don't fire.
		const docWithBoth =
			"# Active Analysis: Foo\n\n## Sub\n\n# Passive Analysis: Foo\n\n## Sub\n";
		const errors = [buildErr("# Active Analysis: Foo > ## Nonexistent")];
		expect(detectRenameIntent(docWithBoth, errors)).toBeNull();
	});

	it("returns null when there are multiple same-level candidates (ambiguous)", () => {
		const ambiguousDoc =
			"# Heading One\n\n## Sub\n\n# Heading Two\n\n## Sub\n";
		const errors = [buildErr("# Heading Three > ## Sub")];
		expect(detectRenameIntent(ambiguousDoc, errors)).toBeNull();
	});

	it("returns null when proposed and existing headings are too dissimilar", () => {
		// Trigram overlap below 0.4 — almost no shared content. Don't guess.
		const doc = "# Authentication & Authorization\n\n## Sub\n";
		const errors = [buildErr("# Pricing Page > ## Sub")];
		expect(detectRenameIntent(doc, errors)).toBeNull();
	});

	it("detects a rename even when only one patch failed", () => {
		// Single-patch case is still valid — the rename pattern is unanimous
		// by trivial vacuity.
		const errors = [
			buildErr(
				"# Active Analysis: Nexus AI Agent Step Status > ## Context Summary",
			),
		];
		const intent = detectRenameIntent(PASSIVE_DOC, errors);
		expect(intent).not.toBeNull();
		expect(intent!.currentAnchor).toBe(
			"# Passive Analysis: Nexus AI Agent Step Status",
		);
	});

	it("ignores non-anchor errors when determining unanimity", () => {
		// One real anchor_not_found + one missing_content — only the
		// anchor_not_found is considered for the rename pattern.
		const errors: PatchError[] = [
			buildErr(
				"# Active Analysis: Nexus AI Agent Step Status > ## Context Summary",
			),
			{
				patchIndex: 1,
				op: "replace_section",
				anchor: "## Whatever",
				code: "missing_content",
				message: "Missing content field.",
			},
		];
		const intent = detectRenameIntent(PASSIVE_DOC, errors);
		expect(intent).not.toBeNull();
		expect(intent!.currentAnchor).toBe(
			"# Passive Analysis: Nexus AI Agent Step Status",
		);
	});
});

describe("diagnoseOverlap", () => {
	it("returns null when there are no overlap errors", () => {
		const intent = diagnoseOverlap(SIMPLE_DOC, [
			{
				patchIndex: 0,
				op: "replace_section",
				anchor: "## Whatever",
				code: "anchor_not_found",
				message: "Anchor not found.",
			},
		]);
		expect(intent).toBeNull();
	});

	it("returns null when overlap errors lack structured ranges (legacy callers)", () => {
		const intent = diagnoseOverlap(SIMPLE_DOC, [
			{
				patchIndex: 1,
				op: "replace_section",
				anchor: "## Foo",
				code: "overlapping_ranges",
				message: "Patch overlaps with patch at index 0.",
			},
		]);
		expect(intent).toBeNull();
	});

	it("identifies the wide H1 root patch as dominant over a nested H2 patch", () => {
		// patch[0] replaces the H1 root with keepHeading: false; patch[1]
		// replaces an H2 under it. Patch 1's range is a subset of patch 0's.
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "# Document Title",
				content: "# New Title\n\nFull new body.\n",
				keepHeading: false,
			},
			{
				op: "replace_section",
				anchor: "## Overview",
				content: "Replacement body.",
			},
		];
		const { success, errors } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(false);

		const intent = diagnoseOverlap(SIMPLE_DOC, errors);
		expect(intent).not.toBeNull();
		expect(intent!.dominantPatchIndex).toBe(0);
		expect(intent!.subsumedPatchIndexes).toContain(1);
		expect(intent!.kind).toBe("whole-document");
		// Dominant range starts at the H1 line (line 1) and covers (nearly)
		// the full doc.
		expect(intent!.dominantRange.startLine).toBe(1);
		expect(intent!.dominantCoveragePercent).toBeGreaterThanOrEqual(70);
	});

	it("classifies a narrow section-level overlap as 'partial'", () => {
		// Both patches target the same H2 subtree, but the H2 is small
		// relative to the document. Dominant covers the H2 section, not the
		// whole doc.
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "## Requirements",
				content: "Block replacement.",
			},
			{
				op: "replace_section",
				anchor: "## Requirements > ### Must Have",
				content: "Inner replacement.",
			},
		];
		const { success, errors } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(false);

		const intent = diagnoseOverlap(SIMPLE_DOC, errors);
		expect(intent).not.toBeNull();
		expect(intent!.kind).toBe("partial");
		expect(intent!.dominantCoveragePercent).toBeLessThan(70);
		// Dominant is the wider H2 patch, not the inner H3 one.
		expect(intent!.dominantPatchIndex).toBe(0);
		expect(intent!.subsumedPatchIndexes).toContain(1);
	});

	it("excludes patches from unrelated overlap pairs in the subsumed list", () => {
		// Two independent overlap conflicts in different sections of one
		// apply_document_patches call. The Requirements pair (patches 0+1)
		// and the Scope pair (patches 2+3) do not touch each other.
		// `subsumedPatchIndexes` for the dominant must NOT name patches from
		// the other component, or the retry hint would tell the model to
		// drop/fold unrelated edits.
		const patches: DocumentPatch[] = [
			{
				op: "replace_section",
				anchor: "## Requirements",
				content: "Wide requirements replacement.",
			},
			{
				op: "replace_section",
				anchor: "## Requirements > ### Must Have",
				content: "Inner must-have replacement.",
			},
			{
				op: "replace_section",
				anchor: "## Scope",
				content: "Wide scope replacement.",
			},
			{
				op: "replace_section",
				anchor: "## Scope > ### In Scope",
				content: "Inner in-scope replacement.",
			},
		];
		const { success, errors } = applyPatches(SIMPLE_DOC, patches);
		expect(success).toBe(false);

		const intent = diagnoseOverlap(SIMPLE_DOC, errors);
		expect(intent).not.toBeNull();
		// Whichever wide patch wins, its subsumed list should contain only
		// the inner patch from its own section.
		const dom = intent!.dominantPatchIndex;
		expect([0, 2]).toContain(dom);
		const expectedSubsumed = dom === 0 ? 1 : 3;
		const unrelatedComponent = dom === 0 ? [2, 3] : [0, 1];
		expect(intent!.subsumedPatchIndexes).toEqual([expectedSubsumed]);
		for (const unrelated of unrelatedComponent) {
			expect(intent!.subsumedPatchIndexes).not.toContain(unrelated);
		}
	});
});

// =============================================================================
// replace_section duplicate-heading guard — catches the "model wrote a rename
// as a keepHeading-true replace_section, ending up with both headings stacked"
// pattern observed in the Active Analysis run.
// =============================================================================

describe("replace_section duplicate-heading guard", () => {
	const DOC = "# Passive Analysis: Foo\n\n## Context\n\nBaseline text.\n";

	it("rejects replace_section whose content starts with a same-level heading when keepHeading is default", () => {
		// Default keepHeading is true → existing heading preserved + new
		// heading from content injected → two adjacent H1s in the result.
		const patch: DocumentPatch = {
			op: "replace_section",
			anchor: "# Passive Analysis: Foo",
			content: "# Active Analysis: Foo\n\nNew body.\n",
		};
		const result = applyPatches(DOC, [patch]);
		expect(result.success).toBe(false);
		expect(result.errors[0].code).toBe(
			"duplicate_heading_in_replace_section",
		);
		expect(result.errors[0].message).toContain('"keepHeading": false');
	});

	it("accepts the same patch when keepHeading is explicitly false (rename pattern)", () => {
		const patch: DocumentPatch = {
			op: "replace_section",
			anchor: "# Passive Analysis: Foo",
			content: "# Active Analysis: Foo\n\nNew body.\n",
			keepHeading: false,
		};
		const result = applyPatches(DOC, [patch]);
		expect(result.success).toBe(true);
		expect(result.result).toContain("# Active Analysis: Foo");
		expect(result.result).not.toContain("# Passive Analysis: Foo");
	});

	it("accepts replace_section content with a sub-heading (different level)", () => {
		// content starts with ## (sub) under # anchor — that's a normal
		// nested heading, not a duplicate.
		const patch: DocumentPatch = {
			op: "replace_section",
			anchor: "# Passive Analysis: Foo",
			content:
				"## Reorganized Sub\n\nThis is fine — sub-heading inside the section.\n",
		};
		const result = applyPatches(DOC, [patch]);
		expect(result.success).toBe(true);
	});

	it("accepts replace_section content with no leading heading", () => {
		// No heading at the top of content — body update only, no duplication risk.
		const patch: DocumentPatch = {
			op: "replace_section",
			anchor: "# Passive Analysis: Foo",
			content: "Just plain prose, no heading at the top.\n",
		};
		const result = applyPatches(DOC, [patch]);
		expect(result.success).toBe(true);
	});

	it("rejects nested replace_section with same-level duplicate (## inside ## anchor)", () => {
		const nestedDoc =
			"# Outer\n\n## Section A\n\nA text.\n\n## Section B\n\nB text.\n";
		const patch: DocumentPatch = {
			op: "replace_section",
			anchor: "## Section A",
			content: "## Renamed Section\n\nNew text.\n",
		};
		const result = applyPatches(nestedDoc, [patch]);
		expect(result.success).toBe(false);
		expect(result.errors[0].code).toBe(
			"duplicate_heading_in_replace_section",
		);
	});

	it("does not flag insert_after with a heading in content", () => {
		// insert_after legitimately inserts a new section — having a heading
		// in content is the normal usage. Don't apply this check to insert_*.
		const patch: DocumentPatch = {
			op: "insert_after",
			anchor: "# Passive Analysis: Foo",
			content: "# New Standalone Section\n\nContent.\n",
		};
		const result = applyPatches(DOC, [patch]);
		expect(result.success).toBe(true);
	});
});

// =============================================================================
// replace_text without anchor — model-agnostic find/replace primitive
//
// When `anchor` is omitted on a `replace_text` patch, the find string is
// searched against the whole document. This is the simplest, most reliable
// edit shape for LLMs: it matches the find/replace primitive every popular
// model (Claude, GPT, Gemini, Llama) has seen in pretraining via Aider
// SEARCH/REPLACE blocks, Anthropic's str_replace_based_edit_tool, and the
// OpenAI V4A diff format.
// =============================================================================

describe("replace_text without anchor (whole-document find/replace)", () => {
	const DOC =
		"# Passive Analysis: Foo\n\n## Context\n\nBaseline body text.\n\n## Notes\n\n- bullet one\n- bullet two\n";

	it("renames a heading with a single anchor-less replace_text", () => {
		// The exact rename pattern that previously needed multi-step
		// retries (rename intent detector + targeted hint) collapses to one
		// surgical find/replace when anchor is omitted.
		const result = applyPatches(DOC, [
			{
				op: "replace_text",
				find: "# Passive Analysis: Foo",
				replace: "# Active Analysis: Foo",
			},
		]);
		expect(result.success).toBe(true);
		expect(result.result).toContain("# Active Analysis: Foo");
		expect(result.result).not.toContain("# Passive Analysis: Foo");
	});

	it("edits body content without specifying an anchor", () => {
		const result = applyPatches(DOC, [
			{
				op: "replace_text",
				find: "Baseline body text.",
				replace: "Updated body text.",
			},
		]);
		expect(result.success).toBe(true);
		expect(result.result).toContain("Updated body text.");
		expect(result.result).not.toContain("Baseline body text.");
	});

	it("rejects find strings that match zero times", () => {
		const result = applyPatches(DOC, [
			{
				op: "replace_text",
				find: "this string does not exist anywhere",
				replace: "x",
			},
		]);
		expect(result.success).toBe(false);
		expect(result.errors[0].code).toBe("find_not_in_section");
	});

	it("rejects find strings that match multiple times", () => {
		// Both bullets share the prefix "- bullet" — ambiguous match.
		const result = applyPatches(DOC, [
			{
				op: "replace_text",
				find: "- bullet",
				replace: "- numbered",
			},
		]);
		expect(result.success).toBe(false);
		expect(result.errors[0].code).toBe("find_ambiguous_in_section");
	});

	it("composes multiple anchor-less edits in a single batch", () => {
		// The model can do a rename + targeted body change in one call,
		// each resolving against the baseline independently.
		const result = applyPatches(DOC, [
			{
				op: "replace_text",
				find: "# Passive Analysis: Foo",
				replace: "# Active Analysis: Foo",
			},
			{
				op: "replace_text",
				find: "Baseline body text.",
				replace: "Updated body text with more detail.",
			},
		]);
		expect(result.success).toBe(true);
		expect(result.result).toContain("# Active Analysis: Foo");
		expect(result.result).toContain("Updated body text with more detail.");
	});

	it("mixes anchor-less and anchored replace_text in one batch", () => {
		// Anchor-less for the rename (whole-doc unique), anchored for a
		// term that appears in multiple sections to disambiguate.
		const docWithRepeats =
			"# A\n\n## One\n\nfoo here.\n\n## Two\n\nfoo there.\n";
		const result = applyPatches(docWithRepeats, [
			{
				op: "replace_text",
				find: "# A",
				replace: "# B",
			},
			{
				op: "replace_text",
				anchor: "## One",
				find: "foo",
				replace: "bar",
			},
		]);
		expect(result.success).toBe(true);
		expect(result.result).toContain("# B");
		expect(result.result).toContain("bar here.");
		expect(result.result).toContain("foo there."); // unchanged
	});

	it("still requires anchor for non-replace_text ops", () => {
		const result = applyPatches(DOC, [
			{
				op: "replace_section",
				content: "rewritten\n",
			} as DocumentPatch,
		]);
		expect(result.success).toBe(false);
		expect(result.errors[0].code).toBe("malformed_anchor");
		expect(result.errors[0].message).toContain("Only replace_text");
	});

	it("anchor-less rejects a destructive whole-document wipe via the preservation guard", () => {
		// A long doc + a find that matches the entire doc + empty replace
		// should still be caught by the content-preservation guard, not
		// silently wipe the document.
		const longDoc = `${DOC}\n${"more content. ".repeat(100)}`;
		const result = applyPatches(longDoc, [
			{
				op: "replace_text",
				find: longDoc,
				replace: "",
			},
		]);
		expect(result.success).toBe(false);
		expect(result.errors[0].code).toBe("excessive_content_loss");
	});
});
