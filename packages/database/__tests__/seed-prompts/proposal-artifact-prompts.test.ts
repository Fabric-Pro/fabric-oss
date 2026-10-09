/**
 * Fizzy #2801 — the two seeded prompts of the coordinated Proposal job.
 *
 * What is worth pinning is what they say. The Main prompt is everything a
 * client reads, so it must not ask for any of the internal material the Draft
 * prompt asks for, and its sections must be H2 headings because the job saves
 * a section as finished when the next heading starts. The analysis prompt must
 * name the same severity and type taxonomy the job's output schema uses, and
 * leave the output contract to the caller.
 *
 * The seed file does NOT export its prompt array (it is a top-level script that
 * runs against the database), so this asserts against the source text, the
 * same way `context-update-instructions.test.ts` does.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Copied from `PROPOSAL_FINDING_SEVERITIES` and `PROPOSAL_FINDING_TYPES` in
 * `packages/temporal/src/lib/proposal-artifact/types.ts`. Copied rather than
 * imported on purpose: @repo/temporal depends on @repo/database, so importing
 * it here would invert the dependency edge. If that list changes, this fails
 * and the prompt text is what moves.
 */
const FINDING_SEVERITIES = ["Blocking", "Important", "Informational"];
const FINDING_TYPES = [
	"Scope",
	"Commercial",
	"Assumption",
	"Risk",
	"Gap",
	"Source Validation",
	"Architecture",
	"Branding",
	"Opportunity",
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

/** The template literal a SYSTEM_PROMPTS entry stores as its content. */
function extractContent(block: string): string {
	const match = block.match(/content: `([\s\S]*?)`,\n/);
	if (!match) {
		throw new Error("Could not find the prompt's content literal");
	}
	return match[1];
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
const mainBlock = extractPromptBlock(src, "proposal_client_main");
const mainContent = extractContent(mainBlock);
const analysisBlock = extractPromptBlock(src, "proposal_internal_analysis");
const analysisContent = extractContent(analysisBlock);

/** The numbered section list under the Main prompt's STRUCTURE heading. */
function mainSectionNames(): string[] {
	const structure = mainContent.slice(mainContent.indexOf("# STRUCTURE"));
	return [...structure.matchAll(/^\d+\.\s+([^:]+):/gm)].map((m) =>
		m[1].trim(),
	);
}

describe("proposal artifact prompts — catalog coordinates", () => {
	it.each(["proposal_client_main", "proposal_internal_analysis"])(
		"%s binds PROPOSAL, kind-null, under its own agent key",
		(key) => {
			const binding = extractBindingBlock(src, key);
			expect(binding).toMatch(/documentTypes:\s*\["PROPOSAL"\]/);
			expect(binding).toMatch(/storyKind:\s*null/);
			expect(binding).toContain(`targetKey: "${key}"`);
		},
	);

	it("leaves the Draft flow's PROPOSAL binding where it was", () => {
		// With the rollout gate off every Proposal still resolves this one.
		const binding = extractBindingBlock(src, "proposal_template");
		expect(binding).toMatch(/documentTypes:\s*\["PROPOSAL"\]/);
		expect(binding).not.toContain("targetKey");
	});

	it.each([
		["main", mainBlock],
		["analysis", analysisBlock],
	])(
		"the %s prompt is plain Markdown with no template variables",
		(_, block) => {
			expect(block).toContain('format: "MARKDOWN" as const');
			expect(extractContent(block)).not.toContain("{{");
		},
	);
});

describe("client-only Main prompt", () => {
	it("parses a plausible section list", () => {
		// Guards the guard: a parse that silently stopped matching would make
		// the section assertions below vacuous.
		expect(mainSectionNames().length).toBeGreaterThanOrEqual(6);
		expect(mainSectionNames()).toContain("Executive Summary");
	});

	it("asks for H2 sections, one finished before the next starts", () => {
		expect(mainContent).toMatch(/write these H2 sections in this order/);
		expect(mainContent).toMatch(/Use H3 only for subsections/);
		expect(mainContent).toMatch(
			/Finish each section before starting the next/,
		);
	});

	it("asks for no section meant for the delivery team", () => {
		for (const name of mainSectionNames()) {
			expect(name).not.toMatch(
				/internal|review|source|citation|reference|readiness|status/i,
			);
		}
	});

	it("carries none of the Draft prompt's internal material", () => {
		// The Draft prompt's own section names and citation form.
		expect(mainContent).not.toContain("Internal Review");
		expect(mainContent).not.toContain("Source Index");
		expect(mainContent).not.toMatch(/\[S\d+\]|\[S#\]/);
		for (const heading of mainContent.match(/^#{1,6}\s.*$/gm) ?? []) {
			expect(heading).not.toMatch(
				/internal review|source|citation|readiness/i,
			);
		}
	});

	it("forbids each kind of internal material explicitly", () => {
		const rules = mainContent.slice(
			mainContent.indexOf("# CLIENT-ONLY RULES"),
			mainContent.indexOf("# CONTENT RULES"),
		);
		expect(rules).toMatch(/No internal review material/);
		expect(rules).toMatch(/readiness or approval status/);
		expect(rules).toMatch(/No citations/);
		expect(rules).toMatch(/index of sources/);
		expect(rules).toMatch(/No internal commercial commentary/);
	});
});

describe("Proposal internal analysis prompt", () => {
	it.each(FINDING_SEVERITIES)("defines the %s severity", (severity) => {
		expect(analysisContent).toMatch(new RegExp(`^- ${severity}: `, "m"));
	});

	it.each(FINDING_TYPES)("defines the %s type", (type) => {
		expect(analysisContent).toMatch(new RegExp(`^- ${type}: `, "m"));
	});

	it("defines nothing beyond the taxonomy as a severity or type", () => {
		const defined = [
			...analysisContent.matchAll(/^- ([A-Z][\w ]+): /gm),
		].map((m) => m[1]);
		expect(defined.sort()).toEqual(
			[...FINDING_SEVERITIES, ...FINDING_TYPES].sort(),
		);
	});

	it("allows an empty result and leaves the output contract to the caller", () => {
		expect(analysisContent).toMatch(/return no findings/);
		expect(analysisContent).toMatch(
			/The output format is supplied separately by the caller/,
		);
	});
});
