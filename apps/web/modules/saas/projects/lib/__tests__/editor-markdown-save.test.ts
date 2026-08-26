/**
 * Regression tests for the shared editor → markdown serializer.
 *
 * Ticket: "Extraneous Markdown Characters Not Cleaned Up in Document Output".
 * Root cause: the Feature editor (StoryWorkspace) used a drifted copy of the
 * Turndown serializer that was missing the `tiptapTable` rule, so tables were
 * saved as a raw `<table>` HTML blob instead of a GFM pipe table; the table rule
 * that DID exist flattened cells via `cell.textContent`, stripping in-cell bold.
 *
 * All editors now share `editor-markdown-save.ts`, so these tests drive that
 * single module — the same code path every editor saves through.
 */

import { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import { fromMarkdown, repairMarkdownDocument } from "../diff-utils";
import {
	createTurndownService,
	getEditorMarkdownForSave,
} from "../editor-markdown-save";
import { advancedExtensions } from "../tiptap-extensions-advanced";

function pipeRowCount(markdown: string): number {
	return (markdown.match(/^\s*\|/gm) || []).length;
}

describe("editor-markdown-save: table serialization", () => {
	it("saves a table as a GFM pipe table, not a raw HTML <table> blob", () => {
		// This is the exact regression: before the fix, the Feature editor's
		// serializer had no table rule and emitted the whole <table> as HTML.
		const markdown = `## Overview

| Channel | Latency | Cost |
|---------|---------|------|
| Email | 5 min | low |
| SMS | 30 sec | high |
| Push | < 1 sec | free |`;

		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(markdown),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		// No raw HTML table leaked into the saved markdown.
		expect(saved).not.toMatch(/<table/i);
		expect(saved).not.toContain("tiptap-table");
		expect(saved).not.toContain("colspan");
		// Header + separator + 3 data rows = 5 pipe-prefixed lines.
		expect(pipeRowCount(saved)).toBeGreaterThanOrEqual(5);
		expect(saved).toMatch(/\|\s*Channel\s*\|/);
		expect(saved).toContain("< 1 sec");
	});

	it("preserves in-cell bold instead of flattening it to plain text", () => {
		// TipTap emits the cell content as <strong>…</strong>; the old
		// cell.textContent approach dropped it. The shared serializer routes each
		// cell through an inline Turndown pass built from the same overrides.
		const html = `<table><tbody>
<tr><th><p>Channel</p></th><th><p>Latency</p></th></tr>
<tr><td><p><strong>Push</strong></p></td><td><p><strong>&lt; 1 sec</strong></p></td></tr>
<tr><td><p>Email</p></td><td><p>5 min</p></td></tr>
</tbody></table>`;

		const saved = createTurndownService().turndown(html);

		expect(saved).not.toMatch(/<table/i);
		expect(saved).toContain("**Push**");
		expect(saved).toContain("**< 1 sec**");
	});

	it("preserves links and inline code (with escaped pipes) inside cells", () => {
		const html = `<table><tbody>
<tr><th><p>Note</p></th><th><p>Ref</p></th></tr>
<tr><td><p><code>a | b</code></p></td><td><p><a href="https://x.test">docs</a></p></td></tr>
</tbody></table>`;

		const saved = createTurndownService().turndown(html);

		expect(saved).not.toMatch(/<table/i);
		// Inline code survives and its literal pipe is escaped so it can't split
		// the row.
		expect(saved).toContain("`a \\| b`");
		// Link survives.
		expect(saved).toContain("[docs](https://x.test)");
	});

	// Table cells are serialized by a SEPARATE inline Turndown service. It was
	// built from the same overrides as the main service but carried none of its
	// custom rules, so `<mark>` fell through to the default rule (keep the text,
	// drop the tag) and every highlight inside a table was destroyed on the
	// first save.
	it("preserves a highlighted cell's <mark> instead of flattening it to text", () => {
		const html = `<table><tbody>
<tr><th><p>Risk</p></th></tr>
<tr><td><p><mark>blocked on infra</mark></p></td></tr>
</tbody></table>`;

		const saved = createTurndownService().turndown(html);

		expect(saved).not.toMatch(/<table/i);
		expect(saved).toContain("<mark>blocked on infra</mark>");
	});

	it("preserves a highlighted cell's data-color", () => {
		// `Highlight.configure({ multicolor: true })` — the colour rides on
		// data-color plus an inline style; the rule normalizes onto data-color.
		const html = `<table><tbody>
<tr><th><p>Risk</p></th></tr>
<tr><td><p><mark data-color="#ffd54f" style="background-color: #ffd54f; color: inherit">blocked</mark></p></td></tr>
</tbody></table>`;

		const saved = createTurndownService().turndown(html);

		expect(saved).toContain('<mark data-color="#ffd54f">blocked</mark>');
	});

	it("escapes a pipe inside a highlighted cell so it cannot split the row", () => {
		const html = `<table><tbody>
<tr><th><p>Note</p></th><th><p>Owner</p></th></tr>
<tr><td><p><mark>a | b</mark></p></td><td><p>ops</p></td></tr>
</tbody></table>`;

		const saved = createTurndownService().turndown(html);
		const dataRow = saved
			.split("\n")
			.find((line) => line.includes("<mark"));

		expect(dataRow).toBeDefined();
		expect(dataRow).toContain("<mark>a \\| b</mark>");
		// Header + separator + one data row — the literal pipe did not add one.
		expect(pipeRowCount(saved)).toBe(3);
	});

	it("round-trips a highlighted table cell through the editor save path", () => {
		const markdown = `| Risk |
| --- |
| <mark data-color="#ffd54f">blocked on infra</mark> |`;

		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(markdown),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(saved).toContain(
			'<mark data-color="#ffd54f">blocked on infra</mark>',
		);
	});

	it("collapses a multi-paragraph cell to a single row-safe line", () => {
		const html = `<table><tbody>
<tr><th><p>Detail</p></th></tr>
<tr><td><p>first line</p><p>second line</p></td></tr>
</tbody></table>`;

		const saved = createTurndownService().turndown(html);
		const dataRow = saved
			.split("\n")
			.find((line) => line.includes("first line"));

		expect(dataRow).toBeDefined();
		// The two paragraphs must end up on ONE pipe row (no embedded newline
		// that would break the table).
		expect(dataRow).toContain("first line second line");
	});
});

describe("editor-markdown-save: highlight survives outside tables", () => {
	// The highlightMark rule is registered on BOTH the main service and the
	// inline table-cell service. The table tests above cover the cell service;
	// these cover the main one, so a future edit that drops either registration
	// fails a test rather than silently destroying highlights on one path.
	it("keeps a coloured <mark> in a plain paragraph", () => {
		const saved = createTurndownService().turndown(
			'<p><mark data-color="#fef08a">A</mark></p>',
		);
		expect(saved).toContain('<mark data-color="#fef08a">A</mark>');
	});

	it("keeps a colourless <mark> in a plain paragraph", () => {
		const saved = createTurndownService().turndown("<p><mark>A</mark></p>");
		expect(saved).toContain("<mark>A</mark>");
	});
});

describe("editor-markdown-save: emphasis is not re-escaped", () => {
	it("keeps bold as ** and does not emit \\* in saved markdown", () => {
		const markdown = "A paragraph with **bold label:** and more text.";
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(markdown),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(saved).toContain("**bold label:**");
		expect(saved).not.toMatch(/\\\*/);
	});
});

function bulletCount(markdown: string): number {
	return (markdown.match(/^\s*-\s+/gm) || []).length;
}

function orderedCount(markdown: string): number {
	return (markdown.match(/^\s*\d+\.\s+/gm) || []).length;
}

describe("editor-markdown-save: list fidelity (#1987)", () => {
	// The reported symptom. `mergeOrphanBulletContinuations` merges a bullet into
	// its predecessor when the previous bullet lacks terminal punctuation and the
	// next starts lowercase (diff-utils.ts:1000-1110). That shape is extremely
	// common in hand-written lists, and Effect 4 laundered the rewrite into the
	// save baseline, so the user's bullets were permanently merged.
	const HAND_WRITTEN = `## Notes

- must handle retries
- and log failures
- then alert the on-call engineer`;

	it("preserves every bullet through a load → save round trip", () => {
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(HAND_WRITTEN, {
				repairLegacyBullets: false,
			}),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(saved).not.toBeNull();
		expect(bulletCount(saved as string)).toBe(3);
		expect(saved).toContain("and log failures");
		expect(saved).toContain("then alert the on-call engineer");
	});

	// Answers the card's open Supporting Question and covers AC4.
	it("preserves numbered lists through a load → save round trip", () => {
		const numbered = `1. must handle retries
2. and log failures
3. then alert the on-call engineer`;

		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(numbered, { repairLegacyBullets: false }),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(saved).not.toBeNull();
		expect(orderedCount(saved as string)).toBe(3);
	});

	// mergeBulletFragments (editor-save-utils.ts:146) merged any bullet whose
	// body began with ';', ',' or ':' into the previous line. Removed from the
	// write path in Task 4 — this locks that in.
	it("preserves a bullet that legitimately starts with punctuation", () => {
		const punctuated = `- see the appendix
- : reference table
- ; and the glossary`;

		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(punctuated, { repairLegacyBullets: false }),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(saved).not.toBeNull();
		expect(bulletCount(saved as string)).toBe(3);
	});

	// The repair must stay ON by default — AI-emitted markdown genuinely wraps
	// long bullets to column 0 (issue #737) and relies on it.
	it("still repairs orphan continuations when not opted out", () => {
		const aiWrapped = `- a bullet whose text wraps onto
the following line at column zero`;

		const html = fromMarkdown(aiWrapped);

		// CommonMark lazy continuation already folds a column-0 line into the
		// preceding list item regardless of the repair flag, so a plain
		// substring/`<li>`-count check passes even with the repair disabled.
		// The repair's only observable effect is *how* the two source lines
		// join: it collapses the line break into a single space, whereas lazy
		// continuation alone leaves the literal newline in place.
		expect(html).toContain("wraps onto the following line at column zero");
		expect((html.match(/<li>/g) || []).length).toBe(1);
	});

	// CRITICAL (#1987): the raw→rich toggle in StoryWorkspace runs
	// `repairMarkdownDocument` then `fromMarkdown(repaired, USER_CONTENT_MD_OPTIONS)`
	// before handing the result to the editor. `repairMarkdownDocument` alone
	// leaves these bullets alone, but without the opt-out on the `fromMarkdown`
	// call, `mergeOrphanBulletContinuations` still collapses them — and that
	// setContent isn't guarded by `isSyncingFromPropRef`, so the collapse
	// autosaves 10s later with no further user action.
	//
	// `StoryWorkspace.tsx` (where `USER_CONTENT_MD_OPTIONS` and the real
	// toggle handler live) cannot be imported into vitest — it side-effect
	// imports CopilotKit's stylesheet plus a transitive katex `.css` pulled
	// in by a markdown-render dependency, which fails to load under
	// jsdom/vite ("Unknown file extension \".css\"", confirmed empirically).
	// Existing component tests for this surface only ever mock
	// `StoryWorkspace` out entirely (see `StoryWorkspacePage.*.test.tsx`),
	// so this can't drive the component's actual call site either. To still
	// catch a reverted opt-out rather than re-testing `fromMarkdown`'s option
	// in the abstract, this proves the opt-out is load-bearing for *this*
	// fixture: a negative control shows the same `repaired` text, run
	// without the opt-out (the shape a reverted call site would produce),
	// collapses below 3 bullets — so the main assertion below isn't
	// vacuously true regardless of what the option does.
	it("preserves every bullet through the raw→rich toggle's repair → fromMarkdown → editor → save chain", () => {
		const repaired = repairMarkdownDocument(HAND_WRITTEN);

		const unpatchedEditor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(repaired),
		});
		const unpatchedSaved = getEditorMarkdownForSave(unpatchedEditor);
		unpatchedEditor.destroy();
		expect(bulletCount(unpatchedSaved as string)).toBeLessThan(3);

		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(repaired, { repairLegacyBullets: false }),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(saved).not.toBeNull();
		expect(bulletCount(saved as string)).toBe(3);
		expect(saved).toContain("and log failures");
		expect(saved).toContain("then alert the on-call engineer");
	});

	// CRITICAL (#1987): both `handleReject`/`handleAccept` in
	// `StoryWorkspace.tsx` (using module-scoped `USER_CONTENT_MD_OPTIONS`)
	// and `useUpdateWithContext.ts`'s `reject()`/`confirm()` (using the
	// `fromMarkdown` prop `StoryWorkspace` injects — the prop's type used to
	// be `(markdown: string) => string`, no options parameter, so the hook
	// silently got the repair ON regardless of what StoryWorkspace opted out
	// of elsewhere) load serializer output of *user* content
	// (`baselineRef.current` / `finalContent`) back through `fromMarkdown`
	// to restore/settle the editor. Without the `{ repairLegacyBullets:
	// false }` opt-out on that call, the repair collapses a hand-written
	// list — and the merged text then gets laundered into the save baseline
	// by Effect 4, so the next save persists it. Both call sites exercise
	// the identical chain shape, so one test covers both (previously two
	// near-duplicate tests here, one per call site).
	//
	// Neither `StoryWorkspace.tsx` nor `useUpdateWithContext.ts` can be
	// driven directly here (see the raw→rich test above for why), so this
	// drives the same chain shape instead: editor -> save (produces a
	// realistic baseline) -> fromMarkdown with the opt-out -> editor ->
	// save. A negative control (baseline round-tripped WITHOUT the
	// opt-out — the shape a reverted call site would produce) proves the
	// opt-out is load-bearing for this fixture, so the main assertion isn't
	// vacuously true.
	it("preserves every bullet through the reject chain (editor -> save -> fromMarkdown(opt-out) -> editor -> save)", () => {
		const firstEditor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(HAND_WRITTEN, { repairLegacyBullets: false }),
		});
		const baseline = getEditorMarkdownForSave(firstEditor);
		firstEditor.destroy();

		expect(baseline).not.toBeNull();

		const unpatchedEditor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(baseline as string),
		});
		const unpatchedSaved = getEditorMarkdownForSave(unpatchedEditor);
		unpatchedEditor.destroy();
		expect(bulletCount(unpatchedSaved as string)).toBeLessThan(3);

		const rejectedEditor = new Editor({
			extensions: advancedExtensions,
			// Mirrors the `USER_CONTENT_MD_OPTIONS` opt-out at the
			// `handleReject` call site in StoryWorkspace.tsx, and the
			// equivalent literal at `useUpdateWithContext.ts`'s `reject()`.
			content: fromMarkdown(baseline as string, {
				repairLegacyBullets: false,
			}),
		});
		const saved = getEditorMarkdownForSave(rejectedEditor);
		rejectedEditor.destroy();

		expect(saved).not.toBeNull();
		expect(bulletCount(saved as string)).toBe(3);
	});
});

describe("editor-markdown-save: failure signalling (#1987)", () => {
	it("returns null when serialization throws, so callers can refuse to save", () => {
		// Previously this returned "", and StoryWorkspace's handleSave wrote
		// `description: null` — a single Turndown throw silently wiped the whole
		// feature description.
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown("# Real content\n\n- one\n- two"),
		});
		// Force the serializer to throw at the getHTML boundary.
		editor.getHTML = () => {
			throw new Error("boom");
		};

		expect(getEditorMarkdownForSave(editor)).toBeNull();

		editor.destroy();
	});

	it("still returns an empty string for a genuinely empty document", () => {
		// "" and null must stay distinguishable: "" is a legitimate save.
		const editor = new Editor({
			extensions: advancedExtensions,
			content: "",
		});

		expect(getEditorMarkdownForSave(editor)).toBe("");

		editor.destroy();
	});

	it("returns null for a null editor", () => {
		expect(getEditorMarkdownForSave(null)).toBeNull();
	});
});

describe("editor-markdown-save: onUpdate ref-indirection (#1987)", () => {
	// StoryWorkspace's autosave never fired: `useEditor(..., [])` (an empty
	// dep array) means TipTap's `Editor` — including the `onUpdate` callback
	// — is constructed once, at first render, and `Editor#setOptions` does
	// NOT re-bind `onUpdate`. So the `onUpdate` that actually runs on every
	// keystroke is forever render-1's closure, whose captured
	// `hasUnsavedChanges`/`triggerAutoSave` are stale. This locks in that
	// mechanism directly against `@tiptap/core`'s `Editor`, independent of
	// React state — `StoryWorkspace.tsx` cannot be imported into vitest (it
	// side-effect imports CopilotKit's stylesheet plus a transitive katex
	// `.css` from a markdown-render dependency; importing it fails with
	// "Unknown file extension \".css\"" under jsdom/vite, confirmed
	// empirically), and existing component tests for this surface only ever
	// mock `StoryWorkspace` out rather than render it (see
	// `StoryWorkspacePage.*.test.tsx`). So the fix itself — the wiring from
	// `onUpdate`'s setTimeout through `triggerAutoSaveRef.current?.()` to
	// the real `triggerAutoSave` closure — is exercised here at the
	// `Editor` level; it is NOT covered by rendering the actual
	// `StoryWorkspace` component. Full end-to-end coverage of the wiring is
	// staging E2E only.
	it("setOptions({ onUpdate }) does not re-register onUpdate — a doc change after it still fires the constructor's closure", () => {
		const calls: string[] = [];
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown("first"),
			onUpdate: () => calls.push("constructor"),
		});

		editor.setOptions({ onUpdate: () => calls.push("setOptions") });
		editor.commands.setContent(fromMarkdown("second"));

		expect(calls).toEqual(["constructor"]);
		editor.destroy();
	});

	// The fix (mirrors `triggerAutoSaveRef` in StoryWorkspace.tsx /
	// DocumentEditor.tsx): the sealed `onUpdate` never calls the save
	// trigger directly — it calls through a ref, and a later render's
	// direct-assignment (`triggerAutoSaveRef.current = triggerAutoSave;`)
	// keeps that ref pointed at the freshest closure. So even though
	// `onUpdate` itself is sealed, what it invokes is not.
	it("indirecting onUpdate through a ref picks up the latest callback despite the seal", () => {
		const calls: string[] = [];
		const latestRef: { current: (() => void) | null } = { current: null };
		latestRef.current = () => calls.push("render-1");

		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown("first"),
			onUpdate: () => latestRef.current?.(),
		});

		// A later render reassigning the ref — the render-body-assignment
		// pattern this fix uses.
		latestRef.current = () => calls.push("latest-render");

		editor.commands.setContent(fromMarkdown("second"));

		expect(calls).toEqual(["latest-render"]);
		editor.destroy();
	});

	// End-to-end shape of the actual fix: a doc change schedules the same
	// 10s `setTimeout` StoryWorkspace's `onUpdate` does, whose body calls
	// through the ref rather than a captured variable. Advancing past the
	// debounce invokes whatever the ref points to at fire time — proving a
	// doc change really does result in a (simulated) save call once the
	// debounce elapses, not just that the ref reassignment itself works.
	it("a doc change followed by the 10s debounce elapsing invokes the latest ref target — the autosave fires", () => {
		vi.useFakeTimers();
		try {
			const saveCalls: string[] = [];
			const triggerAutoSaveRef: { current: (() => void) | null } = {
				current: null,
			};
			// Render 1's stale closure — must NOT be the one that fires.
			triggerAutoSaveRef.current = () => saveCalls.push("stale-render-1");

			const editor = new Editor({
				extensions: advancedExtensions,
				content: fromMarkdown("first"),
				onUpdate: () => {
					setTimeout(() => {
						triggerAutoSaveRef.current?.();
					}, 10000);
				},
			});

			// A later render's direct-assignment, closing over the current
			// `hasUnsavedChanges` — the fix under test.
			triggerAutoSaveRef.current = () => saveCalls.push("save");

			editor.commands.setContent(fromMarkdown("second"));
			vi.advanceTimersByTime(10000);

			expect(saveCalls).toEqual(["save"]);
			editor.destroy();
		} finally {
			vi.useRealTimers();
		}
	});
});
