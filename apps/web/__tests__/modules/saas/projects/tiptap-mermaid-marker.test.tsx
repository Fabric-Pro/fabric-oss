/**
 * A generated diagram in a Proposal's Main (Fizzy #2946) opens its mermaid
 * fence with a `%% fabric-visual: <id>` line. The editor must still load the
 * fence as a mermaid node, not a code block, and draw it: Mermaid reads the
 * line as a comment.
 *
 * The editor is the document editor's own extension set, loaded through the
 * real markdown path (`fromMarkdown`) and rendered with its React node view;
 * the diagram is drawn by the real renderer, and only the translations are
 * stubbed.
 */

import { fromMarkdown } from "@saas/projects/lib/diff-utils";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { createAdvancedExtensions } from "@saas/projects/lib/tiptap-extensions-advanced";
import { render, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const renderer = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("beautiful-mermaid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("beautiful-mermaid")>();
	return {
		...actual,
		renderMermaidSVG: (
			code: string,
			options: Parameters<typeof actual.renderMermaidSVG>[1],
		) => {
			renderer.calls.push(code);
			return actual.renderMermaidSVG(code, options);
		},
	};
});

vi.mock("next-intl", async () => {
	const { createTranslator } =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	const messages = (await import("@repo/i18n/translations/en.json")).default;
	const translators = new Map<string, unknown>();
	return {
		useTranslations: (namespace: string) => {
			if (!translators.has(namespace)) {
				translators.set(
					namespace,
					createTranslator({
						locale: "en",
						messages,
						namespace: namespace as never,
						onError: () => {},
					}),
				);
			}
			return translators.get(namespace);
		},
		useLocale: () => "en",
	};
});

const MARKER = "%% fabric-visual: k3v9q2m7x1a8c4d6";

const FENCE = [
	"```mermaid",
	MARKER,
	"flowchart LR",
	't0["Discovery"]',
	'  t1["Launch"]',
	"t0 --> t1",
	"```",
].join("\n");

const DOCUMENT = `## Delivery\n\nWe start with discovery.\n\n${FENCE}\n\nNext steps follow.`;

const extensions = () =>
	createAdvancedExtensions({
		projectId: null,
		documentId: null,
		statTiles: true,
	});

function TestEditor({ markdown }: { markdown: string }) {
	const editor = useEditor({
		extensions: extensions(),
		content: fromMarkdown(markdown),
		immediatelyRender: true,
	});
	return <EditorContent editor={editor} />;
}

beforeEach(() => {
	renderer.calls = [];
});

describe("a marker-first mermaid fence", () => {
	it("loads as a mermaid node with the marker as its first line, and saves back unchanged", () => {
		const editor = new Editor({
			extensions: extensions(),
			content: fromMarkdown(DOCUMENT),
		});
		const nodes: Array<{ type: string; text: string }> = [];
		editor.state.doc.forEach((node) => {
			nodes.push({ type: node.type.name, text: node.textContent });
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		const diagram = nodes.find((node) => node.type === "mermaidBlock");
		expect(diagram?.text.split("\n")[0]).toBe(MARKER);
		expect(nodes.map((node) => node.type)).not.toContain("codeBlock");
		expect(saved).toBe(DOCUMENT);
	});

	it("renders as a diagram, the marker passed to the renderer as a comment", async () => {
		const { container } = render(<TestEditor markdown={DOCUMENT} />);

		const svg = await waitFor(() => {
			const drawn = container.querySelector(".mermaid-diagram-area svg");
			if (!drawn) {
				throw new Error("no diagram yet");
			}
			return drawn;
		});

		expect(renderer.calls[0]?.split("\n")[0]).toBe(MARKER);
		expect(svg.textContent).toContain("Discovery");
		expect(svg.textContent).toContain("Launch");
		expect(svg.textContent).not.toContain("fabric-visual");
		expect(container.textContent).not.toMatch(/Failed to render/i);
	});
});

describe("a diagram's source text", () => {
	it("stays out of sight while the diagram is shown", async () => {
		const { container } = render(<TestEditor markdown={DOCUMENT} />);
		await waitFor(() => {
			if (!container.querySelector(".mermaid-diagram-area svg")) {
				throw new Error("no diagram yet");
			}
		});

		const node = container.querySelector(".node-mermaidBlock");
		const source = node?.querySelector("[data-node-view-content-react]");
		expect(source?.textContent).toContain("flowchart LR");
		// The content element sits inside a hidden, aria-hidden holder, never
		// as a visible block beside the drawn diagram.
		const holder = source?.parentElement;
		expect(holder).not.toBe(node);
		expect(holder?.classList.contains("hidden")).toBe(true);
		expect(holder?.getAttribute("aria-hidden")).toBe("true");
	});
});
