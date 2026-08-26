/**
 * Spec: fabric/specs/2026-05-19-remove-passive-analysis/spec.md §12.2 test #6.
 *
 * Originally asserted that BOTH the feature_placeholder description and content
 * body carry the canonical pipeline language `Active Analysis → Sanity Check →
 * Draft` and contain no `PASSIVE_ANALYSIS` enum references.
 *
 * The content body was subsequently re-synced from the production SYSTEM prompt
 * (v5) during the prompt-seed backport. Production's body is a "single create +
 * passive enrichment" prompt and does not carry the pipeline phrasing, so the
 * pipeline-language guarantee is now asserted on the DESCRIPTION only; the body
 * assertion instead pins a stable marker of the production-synced content. The
 * no-`PASSIVE_ANALYSIS`-enum guarantee is retained for both fields.
 *
 * The seed file does NOT export its prompt array (it's a top-level script
 * that runs against the database). We assert by reading the source file
 * content and locating the `feature_placeholder` entry by key marker.
 * This is a content-shape assertion analogous to the migration-shape tests
 * in `__tests__/migrations/`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function loadSeedSource(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const seedPath = join(here, "..", "..", "prisma", "seed-prompts-only.ts");
	return readFileSync(seedPath, "utf8");
}

/**
 * Extract the source block for a SYSTEM_PROMPTS entry by key. The block is
 * everything from the `key: "..."` line through the next `bindingTargetKey: ...,`
 * (closing the entry object). Returns the substring so we can run focused
 * regex / `includes` assertions against just that prompt's content.
 */
function extractPromptBlock(src: string, key: string): string {
	const keyMarker = `key: "${key}"`;
	const start = src.indexOf(keyMarker);
	if (start === -1) {
		throw new Error(
			`Could not find prompt with key "${key}" in seed source`,
		);
	}
	// The entry closes at the next `bindingTargetKey:` line, which every
	// SYSTEM_PROMPTS entry has (it's the last field in the object literal).
	const end = src.indexOf("bindingTargetKey:", start);
	if (end === -1) {
		throw new Error(
			`Could not find end of prompt block for key "${key}" (missing bindingTargetKey)`,
		);
	}
	// Include the bindingTargetKey line itself for completeness.
	const blockEnd = src.indexOf("\n", end);
	return src.slice(start, blockEnd === -1 ? src.length : blockEnd);
}

describe("feature_placeholder prompt — post spec 2026-05-19 rewrite", () => {
	const src = loadSeedSource();
	const block = extractPromptBlock(src, "feature_placeholder");

	it("description does NOT contain PASSIVE_ANALYSIS", () => {
		// Locate the description line within the block.
		const descMatch = block.match(/description:\s*"([^"]*)"/);
		expect(descMatch).not.toBeNull();
		const description = descMatch?.[1] ?? "";
		expect(description.includes("PASSIVE_ANALYSIS")).toBe(false);
	});

	it("content (body) does NOT contain PASSIVE_ANALYSIS", () => {
		// The content is a backtick-delimited template literal. Capture it.
		const contentMatch = block.match(/content:\s*`([\s\S]*?)`/);
		expect(contentMatch).not.toBeNull();
		const content = contentMatch?.[1] ?? "";
		expect(content.includes("PASSIVE_ANALYSIS")).toBe(false);
	});

	it("description includes the new pipeline phrasing 'Active Analysis → Sanity Check → Draft'", () => {
		const descMatch = block.match(/description:\s*"([^"]*)"/);
		const description = descMatch?.[1] ?? "";
		// Per spec §6.1: the rewrite uses display labels in title-case.
		expect(description).toContain("Active Analysis → Sanity Check → Draft");
	});

	it("content body is the production-synced v5 content (pipeline phrasing lives in the description only)", () => {
		const contentMatch = block.match(/content:\s*`([\s\S]*?)`/);
		expect(contentMatch).not.toBeNull();
		const content = contentMatch?.[1] ?? "";
		// The body was re-synced from the production SYSTEM prompt (v5), which
		// does not carry the `Active Analysis → Sanity Check → Draft` phrasing
		// (that requirement is asserted on the description above, per spec
		// §6.1). Pin a stable marker from the production body so an accidental
		// reversion is still caught.
		expect(content).toContain("Create ONE feature stub");
	});
});

describe("feature_passive_analysis binding — removed from PROMPT_DOCUMENT_TYPE_BINDINGS", () => {
	const src = loadSeedSource();

	it("the seed file does NOT register a feature_passive_analysis binding in PROMPT_DOCUMENT_TYPE_BINDINGS", () => {
		// The binding entry would look like:
		//   feature_passive_analysis: {
		//     documentTypes: ["PASSIVE_ANALYSIS"],
		//     storyKind: "FEATURE",
		//   },
		// Per spec G6.1: this entry is deleted. The Prompt row itself
		// (`key: "feature_passive_analysis"`) is retained per OQ-5 default.
		// We verify the binding-line shape is absent.
		expect(src).not.toMatch(
			/feature_passive_analysis:\s*\{\s*documentTypes:\s*\["PASSIVE_ANALYSIS"\]/,
		);
	});

	it("the feature_passive_analysis Prompt row content is retained (per OQ-5 default)", () => {
		// The Prompt row itself stays as a deprecated SYSTEM prompt with no
		// active binding (F-171 precedent). Verify the row marker is still
		// present so a future implementer doesn't accidentally hard-delete it.
		expect(src).toContain('key: "feature_passive_analysis"');
	});
});
