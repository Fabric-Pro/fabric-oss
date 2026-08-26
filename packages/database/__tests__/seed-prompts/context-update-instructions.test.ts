/**
 * Fizzy #2048 — the two kind-scoped "Update using context" catalog records.
 *
 * These records ARE the fix for the work item path: the shared context-update
 * engine keeps one system prompt, and what stops a bug being edited into feature
 * shape is the addendum resolved from the item's stored kind. So the guarantee
 * worth pinning is not that the records exist, but what they say — a bug record
 * that forgot to name the diagnostic sections would resolve, log, and change
 * nothing.
 *
 * The seed file does NOT export its prompt array (it is a top-level script that
 * runs against the database and self-invokes on import), so this asserts against
 * the source text, the same way `feature-placeholder.test.ts` does.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The canonical bug sections, copied from `BUG_SIGNATURE_SECTIONS` in
 * `packages/temporal/src/lib/structure-guards.ts`. Copied rather than imported
 * on purpose: @repo/temporal depends on @repo/database, so importing it here
 * would invert the dependency edge. The guards are the authority on what a bug
 * body looks like — if that list ever changes, this fails and the prompt text is
 * what moves.
 */
const BUG_SIGNATURE_SECTIONS = [
	"Steps to Reproduce",
	"Expected Result",
	"Actual Result",
	"Environment",
	"Impact",
	"Root Cause",
];

/** From `FEATURE_ONLY_SECTIONS` in the same guard module. */
const FEATURE_ONLY_SECTIONS = [
	"Feature Narrative",
	"User Story",
	"Benefit Hypothesis",
];

function loadSeedSource(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return readFileSync(
		join(here, "..", "..", "prisma", "seed-prompts-only.ts"),
		"utf8",
	);
}

/** The source block of one SYSTEM_PROMPTS entry, key line to next key line. */
function extractPromptBlock(src: string, key: string): string {
	const start = src.indexOf(`key: "${key}"`);
	if (start === -1) {
		throw new Error(
			`Could not find prompt with key "${key}" in seed source`,
		);
	}
	const end = src.indexOf('\n\t\tkey: "', start + 1);
	return src.slice(start, end === -1 ? src.length : end);
}

/** The source block of one PROMPT_DOCUMENT_TYPE_BINDINGS entry. */
function extractBindingBlock(src: string, key: string): string {
	const start = src.indexOf(`\n\t${key}: {`);
	if (start === -1) {
		throw new Error(`Could not find binding for "${key}" in seed source`);
	}
	const end = src.indexOf("\n\t},", start);
	return src.slice(start, end === -1 ? src.length : end);
}

const src = loadSeedSource();

describe("context-update instruction records — catalog coordinates", () => {
	it.each([
		["feature_context_update_instructions", "FEATURE"],
		["bug_context_update_instructions", "BUG"],
	])("%s binds at CONTEXT_UPDATE for %s", (key, kind) => {
		const binding = extractBindingBlock(src, key);

		expect(binding).toContain('documentTypes: ["CONTEXT_UPDATE"]');
		expect(binding).toContain(`storyKind: "${kind}"`);
		// One agent key for both kinds — `storyKind` is exact-match, so the kind
		// alone picks the record. These coordinates are duplicated in the resolver
		// at `packages/api/modules/projects/procedures/stories/update-with-context.ts`;
		// the two must agree or the lookup silently resolves nothing.
		expect(binding).toContain('targetKey: "context_update_instructions"');
	});

	it("both records exist with their own prompt entry", () => {
		for (const key of [
			"feature_context_update_instructions",
			"bug_context_update_instructions",
		]) {
			expect(() => extractPromptBlock(src, key)).not.toThrow();
		}
	});
});

describe("bug_context_update_instructions — content (R8)", () => {
	const block = extractPromptBlock(src, "bug_context_update_instructions");

	it.each(BUG_SIGNATURE_SECTIONS)(
		"tells the model to keep the %s section",
		(section) => {
			expect(block).toContain(section);
		},
	);

	it("forbids the feature-narrative sections by name", () => {
		for (const section of FEATURE_ONLY_SECTIONS) {
			expect(block).toContain(section);
		}
		expect(block).toContain("Add NO feature-narrative sections");
	});

	it("instructs the model to return the acceptance-criteria heading it was given", () => {
		// The wipe guard: a reply without the `## Acceptance Criteria` anchor parses
		// as empty criteria, which is proposed as the new stored value.
		expect(block).toContain("## Acceptance Criteria");
		expect(block).toContain("discards the stored criteria");
	});
});

describe("feature_context_update_instructions — content (the mirror)", () => {
	const block = extractPromptBlock(
		src,
		"feature_context_update_instructions",
	);

	it("forbids the bug diagnostic sections by name", () => {
		expect(block).toContain("Add NO bug diagnostic sections");
		for (const section of BUG_SIGNATURE_SECTIONS) {
			expect(block).toContain(section);
		}
	});

	it("instructs the model to return the acceptance-criteria heading it was given", () => {
		expect(block).toContain("## Acceptance Criteria");
		expect(block).toContain("discards the stored criteria");
	});

	it("does not carry the bug record's text", () => {
		expect(block).not.toContain("BUG report");
	});
});
