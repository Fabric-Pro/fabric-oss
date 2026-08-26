/**
 * Tests for the document-context extraction helpers used by the Mermaid
 * "Build with AI" feature to ground diagram generation in the surrounding
 * document (title, outline, nearest section, and optionally full text).
 */

import { describe, expect, it } from "vitest";
import {
	buildContextBlock,
	extractDocContext,
	type MermaidDocContext,
} from "../tiptap-mermaid-extension";

type FakeNode = {
	type: { name: string };
	attrs: Record<string, unknown>;
	textContent: string;
};

/**
 * Minimal stand-in for a Tiptap/ProseMirror editor. We only need the bits
 * `extractDocContext` actually touches: `descendants`, `textBetween`, and
 * `content.size`.
 */
function makeFakeEditor(
	nodes: Array<{
		type: string;
		level?: number;
		text: string;
	}>,
	cursor?: { afterNodeIndex: number },
) {
	// Each node occupies `text.length + 2` positions (tiptap leaves paragraph
	// boundaries, but for these tests we just need stable, monotonic positions
	// so `extractDocContext` can find the nearest heading before the block).
	const positioned: Array<FakeNode & { pos: number; end: number }> = [];
	let pos = 1;
	for (const n of nodes) {
		const fake: FakeNode = {
			type: { name: n.type },
			attrs: n.level ? { level: n.level } : {},
			textContent: n.text,
		};
		const end = pos + n.text.length + 2;
		positioned.push({ ...fake, pos, end });
		pos = end;
	}
	const totalSize = pos;

	const blockPos =
		cursor !== undefined
			? positioned[cursor.afterNodeIndex]?.end
			: undefined;

	const doc = {
		content: { size: totalSize },
		descendants(cb: (node: FakeNode, pos: number) => boolean | undefined) {
			for (const n of positioned) {
				const res = cb(n, n.pos);
				if (res === false) {
					return;
				}
			}
		},
		textBetween(
			start: number,
			end: number,
			_blockSep: string,
			_inlineSep: string,
		) {
			return positioned
				.filter((n) => n.pos >= start && n.end <= end)
				.map((n) => n.textContent)
				.join("\n\n");
		},
	};

	return {
		editor: { state: { doc } },
		blockPos,
	};
}

describe("extractDocContext", () => {
	it("returns empty context when editor is null", () => {
		const ctx = extractDocContext(null, undefined);
		expect(ctx).toEqual({
			title: null,
			outline: [],
			section: "",
			fullText: "",
			estimatedTokens: 0,
		});
	});

	it("extracts title, outline, section, and full text", () => {
		const { editor, blockPos } = makeFakeEditor(
			[
				{ type: "heading", level: 1, text: "Auth Spec" },
				{ type: "paragraph", text: "Intro paragraph." },
				{ type: "heading", level: 2, text: "MFA Flow" },
				{
					type: "paragraph",
					text: "Users enrol a TOTP authenticator during signup.",
				},
				{
					type: "paragraph",
					text: "Backup codes are generated on enrol.",
				},
				{ type: "mermaid", text: "" },
			],
			{ afterNodeIndex: 4 }, // cursor is after the last paragraph, where mermaid sits
		);

		const ctx = extractDocContext(editor, blockPos);

		expect(ctx.title).toBe("Auth Spec");
		expect(ctx.outline.map((h) => h.text)).toEqual([
			"Auth Spec",
			"MFA Flow",
		]);
		expect(ctx.section).toContain("MFA Flow");
		expect(ctx.section).toContain("TOTP");
		expect(ctx.section).toContain("Backup codes");
		// Section should NOT leak in the unrelated intro paragraph (that paragraph
		// sits before the nearest heading)
		expect(ctx.section).not.toContain("Intro paragraph");
		expect(ctx.fullText).toContain("Auth Spec");
		expect(ctx.fullText).toContain("Intro paragraph");
		expect(ctx.estimatedTokens).toBeGreaterThan(0);
	});

	it("uses the first heading as title when no h1 exists but level-2 does", () => {
		const { editor, blockPos } = makeFakeEditor(
			[
				{ type: "heading", level: 2, text: "Section A" },
				{ type: "paragraph", text: "body" },
			],
			{ afterNodeIndex: 1 },
		);
		const ctx = extractDocContext(editor, blockPos);
		expect(ctx.title).toBe("Section A");
	});

	it("skips heading-based title when only h3+ headings exist", () => {
		const { editor, blockPos } = makeFakeEditor(
			[
				{ type: "heading", level: 3, text: "Deep section" },
				{ type: "paragraph", text: "body" },
			],
			{ afterNodeIndex: 1 },
		);
		const ctx = extractDocContext(editor, blockPos);
		expect(ctx.title).toBeNull();
		expect(ctx.outline).toHaveLength(1);
	});

	it("returns empty context on errors without crashing", () => {
		const brokenEditor = {
			state: {
				doc: {
					content: { size: 0 },
					descendants() {
						throw new Error("boom");
					},
					textBetween() {
						return "";
					},
				},
			},
		};
		const ctx = extractDocContext(brokenEditor, 0);
		expect(ctx.section).toBe("");
		expect(ctx.fullText).toBe("");
	});
});

describe("buildContextBlock", () => {
	const baseCtx: MermaidDocContext = {
		title: "Auth Spec",
		outline: [
			{ level: 1, text: "Auth Spec" },
			{ level: 2, text: "MFA Flow" },
		],
		section: "Users enrol a TOTP authenticator.",
		fullText: "Auth Spec\n\nMFA Flow\n\nUsers enrol a TOTP authenticator.",
		estimatedTokens: 20,
	};

	it("returns empty string when context is completely empty", () => {
		const result = buildContextBlock(
			{
				title: null,
				outline: [],
				section: "",
				fullText: "",
				estimatedTokens: 0,
			},
			"auto",
		);
		expect(result).toBe("");
	});

	it("auto mode includes full document for small docs", () => {
		const result = buildContextBlock(baseCtx, "auto");
		expect(result).toContain("Document title: Auth Spec");
		expect(result).toContain("Document outline:");
		expect(result).toContain("- Auth Spec");
		expect(result).toContain("  - MFA Flow"); // level-2 indent
		expect(result).toContain("Full document content:");
		expect(result).toContain("TOTP");
	});

	it("auto mode falls back to section-only for large docs; full mode forces it", () => {
		const large: MermaidDocContext = {
			...baseCtx,
			// Force over the 4000-token auto budget
			estimatedTokens: 5000,
		};

		const auto = buildContextBlock(large, "auto");
		expect(auto).toContain("Current section");
		expect(auto).not.toContain("Full document content:");

		const forced = buildContextBlock(large, "full");
		expect(forced).toContain("Full document content:");
	});

	it("section mode never includes full document even when small", () => {
		const result = buildContextBlock(baseCtx, "section");
		expect(result).toContain("Document title: Auth Spec");
		expect(result).toContain("Document outline:");
		expect(result).toContain("Current section");
		expect(result).not.toContain("Full document content:");
	});

	it("includes outline only when section and full text are empty", () => {
		const outlineOnly: MermaidDocContext = {
			title: "Overview",
			outline: [{ level: 1, text: "Overview" }],
			section: "",
			fullText: "",
			estimatedTokens: 0,
		};
		const result = buildContextBlock(outlineOnly, "auto");
		expect(result).toContain("Document outline:");
		expect(result).not.toContain("Full document content:");
		expect(result).not.toContain("Current section");
	});
});
