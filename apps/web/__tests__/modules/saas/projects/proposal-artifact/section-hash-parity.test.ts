/**
 * Proposal section keys and prose hashes in the browser runtime, and through
 * the editor (Fizzy #2946).
 *
 * The worker and the API compute section keys and prose hashes in Node; the
 * editor bundle computes them in the browser. The golden fixture pins that
 * both agree. The round trip pins why the hash covers text, not bytes: a
 * model-written body loaded through the editor's real load path
 * (`repairMarkdownDocument`, `fromMarkdown`, a TipTap editor with the
 * document editor's own extensions) and saved through its real save path
 * (`getEditorMarkdownForSave`) comes back re-serialised, and must keep every
 * section key and every hash.
 */

import {
	buildSectionMap,
	documentProseHash,
	type SectionMap,
} from "@repo/utils/proposal-artifact/section-hash";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import golden from "../../../../../../../packages/utils/__tests__/fixtures/proposal-section-hash.golden.json";

// The mention suggestion popover imports the RPC client; nothing here calls it.
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));
// Node views need a mounted `EditorContent`; the schema-level round trip
// below does not, as in save-load-flow.test.ts.
vi.mock("@tiptap/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tiptap/react")>()),
	ReactNodeViewRenderer: () => () => null,
}));

const { fromMarkdown, repairMarkdownDocument } = await import(
	"@saas/projects/lib/diff-utils"
);
const { getEditorMarkdownForSave } = await import(
	"@saas/projects/lib/editor-markdown-save"
);
const { createAdvancedExtensions } = await import(
	"@saas/projects/lib/tiptap-extensions-advanced"
);

const lines = (...parts: string[]) => parts.join("\n");

/**
 * A synthetic body in the shape a model writes: soft-wrapped lines, bold
 * across a wrap, indented and lazy bullet continuations, `1.`-only ordered
 * lists, a mixed-marker list, escapes, entities, autolinks, a hard break,
 * emoji, a GFM table with an escaped pipe, task items, a quote with a lazy
 * line, visuals, setext and indented headings.
 */
const MODEL_WRITTEN = lines(
	"# Proposal: Example Org Data Platform",
	"",
	"Prepared for Example Org by the delivery team. This proposal outlines",
	"the approach, scope and timeline for a modern data platform.",
	"",
	"## 1. Executive Summary",
	"",
	"Example Org wants to **consolidate its reporting",
	"stack** into one platform. The current setup relies on *manual exports*",
	"and spreadsheets, which slows decisions &mdash; and costs time.",
	"",
	"We recommend a phased approach:",
	"",
	"1. Discovery and audit",
	"1. Platform build",
	"1. Rollout &amp; training",
	"",
	"## 2. Scope",
	"",
	"### In Scope",
	"",
	"- **Data ingestion:** nightly loads from the CRM and",
	"  the billing system",
	"- Dashboards for finance,",
	"operations and sales",
	"    - Executive overview",
	"    - Team drill-downs",
	"- Escaped characters such as \\*literal asterisks\\*, snake\\_case, 50\\% and \\#hashtag.",
	"* A second list with another marker.",
	"+ [x] Kickoff checklist agreed.",
	"+ [ ] Access requests raised.",
	"",
	"### Out of Scope",
	"",
	"> Hardware procurement is out of scope.",
	"Licensing remains with Example Org.",
	">",
	"> - Third-party support contracts",
	"",
	"## 3. Timeline",
	"",
	"| Phase | Duration | Owner |",
	"|:------|---------:|:-----:|",
	"| Discovery | 2 weeks | Example Org &amp; delivery team |",
	"| Build | 8 weeks | Delivery team \\| QA |",
	"| Rollout | 2 weeks | **Joint** `ops` |",
	"",
	"```mermaid",
	"gantt",
	"  title Plan",
	"  Discovery :a1, 2026-01-05, 14d",
	"```",
	"",
	"```",
	"graph TD",
	"  A[Discovery] --> B[Build]",
	"```",
	"",
	"```stat-tiles",
	"%% fabric-visual: a1b2c3d4e5f6",
	"Weeks: 12",
	"Teams: 3",
	"```",
	"",
	'<visual-slot data-slot-id="slot-a" data-kind="timeline"></visual-slot>',
	"",
	"## 4. Pricing &amp; Terms",
	"",
	"Fees are quoted in USD&nbsp;and exclude VAT. See <https://example.com/terms> or",
	"www.example.com for details, or write to dev@example.com. \u{1F680} Ready to start ✅  ",
	"Payment is due within thirty days.",
	"",
	"![Architecture overview](https://example.com/diagram.png)",
	"",
	"```json",
	'{ "budget": 120000, "currency": "USD" }',
	"```",
	"",
	"---",
	"",
	"Appendix",
	"--------",
	"",
	"   ## Contacts",
	"",
	'Reach the [delivery team](https://example.com/team "Team page") for questions.',
	"",
);

let editors: Editor[] = [];
afterEach(() => {
	for (const editor of editors) {
		editor.destroy();
	}
	editors = [];
});

/** Load `markdown` the way the document editor does, then save it. */
function editorRoundTrip(markdown: string): string {
	const editor = new Editor({
		extensions: createAdvancedExtensions({
			projectId: null,
			documentId: null,
		}),
		content: fromMarkdown(repairMarkdownDocument(markdown)),
	});
	editors.push(editor);
	const saved = getEditorMarkdownForSave(editor);
	if (saved === null) {
		throw new Error("the editor's save path refused to serialise");
	}
	return saved;
}

const keyed = (map: SectionMap) =>
	map.sections.map((section) => [section.key, section.proseHash]);

describe("golden fixture in the browser runtime", () => {
	it("runs under jsdom", () => {
		expect(typeof document).toBe("object");
	});

	it.each(golden.cases.map((entry) => [entry.name, entry] as const))(
		"%s",
		(_name, entry) => {
			expect(buildSectionMap(entry.markdown)).toEqual(entry.expected);
			expect(documentProseHash(entry.markdown)).toBe(
				entry.expected.documentProseHash,
			);
		},
	);
});

describe("editor round trip", () => {
	it("keeps every section key and hash through a load and save", () => {
		const saved = editorRoundTrip(MODEL_WRITTEN);
		const before = buildSectionMap(MODEL_WRITTEN);
		const after = buildSectionMap(saved);

		// The save really re-serialised the body.
		expect(saved).not.toBe(MODEL_WRITTEN);
		expect(saved).toContain("## 1\\. Executive Summary");
		expect(saved).toContain("```mermaid\ngraph TD");
		expect(saved).toContain("## Appendix");

		expect(after.sections.map((section) => section.key)).toEqual([
			"p1:@preamble",
			"p1:executive summary#0",
			"p1:scope#0",
			"p1:scope/in scope#0",
			"p1:scope/out of scope#0",
			"p1:timeline#0",
			"p1:pricing & terms#0",
			"p1:appendix#0",
			"p1:contacts#0",
		]);
		expect(keyed(after)).toEqual(keyed(before));
		expect(after.documentProseHash).toBe(before.documentProseHash);
	});

	it("is stable over a second load and save", () => {
		const once = editorRoundTrip(MODEL_WRITTEN);
		const twice = editorRoundTrip(once);

		expect(keyed(buildSectionMap(twice))).toEqual(
			keyed(buildSectionMap(MODEL_WRITTEN)),
		);
	});

	it("changes the hash of a section the load path repairs, once, and no other", () => {
		// `repairMarkdownDocument` rejoins a bold marker split across two
		// bullets, and `fromMarkdown` merges a lowercase continuation bullet
		// into the one above. Both turn two list items into one, which is a
		// change of the section's text, so its hash changes on the first save.
		const degraded = lines(
			"# Proposal",
			"",
			"## Risks",
			"",
			"- **Dependency*",
			"- *: the billing export may change format.",
			"- Integration testing covers the main",
			"- flows and the reporting views.",
			"",
			"## Next Steps",
			"",
			"Agree the plan.",
			"",
		);
		const once = editorRoundTrip(degraded);
		const before = buildSectionMap(degraded);
		const after = buildSectionMap(once);

		expect(once).toContain("**Dependency**: the billing export");
		expect(after.sections.map((section) => section.key)).toEqual(
			before.sections.map((section) => section.key),
		);
		expect(after.sections[0].proseHash).not.toBe(
			before.sections[0].proseHash,
		);
		expect(after.sections[1].proseHash).toBe(before.sections[1].proseHash);
		expect(keyed(buildSectionMap(editorRoundTrip(once)))).toEqual(
			keyed(after),
		);
	});
});
