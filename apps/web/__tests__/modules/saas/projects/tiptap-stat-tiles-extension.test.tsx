/**
 * Stat tiles in a Proposal's Main body (Fizzy #2946).
 *
 * A ```` ```stat-tiles ```` fence loads into the document editor as its own
 * node, draws as tiles (a description list) when its body follows the
 * `label: value` rule and as its source otherwise, and saves back byte for
 * byte. Every other reader keeps the fence: the markdown converter, the
 * editors that do not opt in (as a plain code block), and the client-side
 * PDF and DOCX downloads.
 *
 * The editor tests drive the real load path (`fromMarkdown` into Tiptap with
 * the document editor's extensions) and the real save path
 * (`getEditorMarkdownForSave`), because the round trip lives in the parse
 * step between them.
 */

import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import { STAT_TILES_RULE } from "@repo/utils/proposal-artifact/stat-tiles";
import {
	ProposalLiveSections,
	type ProposalLiveSectionsProps,
} from "@saas/projects/components/proposal-artifact/ProposalLiveSections";
import { fromMarkdown } from "@saas/projects/lib/diff-utils";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import {
	renderMarkdownToDocx,
	renderMarkdownToPdf,
} from "@saas/projects/lib/markdown-to-document";
import { createCollaborativeExtensions } from "@saas/projects/lib/tiptap-extensions";
import {
	advancedExtensions,
	createAdvancedExtensions,
} from "@saas/projects/lib/tiptap-extensions-advanced";
import {
	STAT_TILES_NODE_NAME,
	StatTilesBlock,
} from "@saas/projects/lib/tiptap-stat-tiles-extension";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor } from "@tiptap/core";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import {
	EditorContent,
	type Editor as ReactEditor,
	useEditor,
} from "@tiptap/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";
import * as Y from "yjs";

expect.extend(axeMatchers);

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
						onError: (error) => {
							throw error;
						},
					}),
				);
			}
			return translators.get(namespace);
		},
		useLocale: () => "en",
	};
});

const docxText = vi.hoisted(() => ({ runs: [] as string[] }));

vi.mock("docx", async (importOriginal) => {
	const actual = await importOriginal<typeof import("docx")>();
	class TextRun extends actual.TextRun {
		constructor(options: ConstructorParameters<typeof actual.TextRun>[0]) {
			super(options);
			docxText.runs.push(
				typeof options === "string"
					? options
					: String(options.text ?? ""),
			);
		}
	}
	return { ...actual, TextRun };
});

/** The toggle's visible text, read from the real catalogue. */
const EDIT_SOURCE = en.tooltips.editor.editStatTilesSource;

const lines = (...parts: string[]) => parts.join("\n");

const fence = (...body: string[]) => lines("```stat-tiles", ...body, "```");

const MARKED_FENCE = fence(
	"%% fabric-visual: a1b2c3d4e5f6",
	"Faster onboarding: 40%",
	"Pilot sites: 3",
	"Annual savings: $1.2M",
);

const FIVE_ITEM_FENCE = fence(
	"Faster onboarding: 40%",
	"Pilot sites: 3",
	"Annual savings: $1.2M",
	"Teams trained: 12",
	"Regions: 2",
);

const withProse = (block: string) =>
	lines(
		"## Results",
		"",
		"The pilot went well.",
		"",
		block,
		"",
		"Next steps follow.",
	);

/** The document editor's extensions: the shared set with stat tiles on. */
const documentEditorExtensions = () =>
	createAdvancedExtensions({
		projectId: null,
		documentId: null,
		statTiles: true,
	});

function loadInto(
	extensions: ReturnType<typeof createAdvancedExtensions>,
	markdown: string,
): Editor {
	return new Editor({ extensions, content: fromMarkdown(markdown) });
}

function topLevelTypes(editor: Editor): string[] {
	const types: string[] = [];
	editor.state.doc.forEach((node) => {
		types.push(node.type.name);
	});
	return types;
}

function saveOf(editor: Editor): string {
	const saved = getEditorMarkdownForSave(editor);
	editor.destroy();
	if (saved === null) {
		throw new Error("serialization failed");
	}
	return saved;
}

describe("the document editor loads and saves a stat tiles fence", () => {
	it("loads the fence as a stat tiles node", () => {
		const editor = loadInto(
			documentEditorExtensions(),
			withProse(MARKED_FENCE),
		);

		expect(topLevelTypes(editor)).toEqual([
			"heading",
			"paragraph",
			STAT_TILES_NODE_NAME,
			"paragraph",
		]);
		editor.destroy();
	});

	it("saves the document back byte for byte", () => {
		const markdown = withProse(MARKED_FENCE);

		const saved = saveOf(loadInto(documentEditorExtensions(), markdown));

		expect(saved).toContain(MARKED_FENCE);
		expect(saved).toBe(markdown);
	});

	it("saves a block that breaks the rule back byte for byte too", () => {
		const markdown = withProse(FIVE_ITEM_FENCE);
		const editor = loadInto(documentEditorExtensions(), markdown);

		expect(topLevelTypes(editor)).toContain(STAT_TILES_NODE_NAME);
		expect(saveOf(editor)).toBe(markdown);
	});

	it("survives a second load and save unchanged", () => {
		const markdown = withProse(MARKED_FENCE);
		const once = saveOf(loadInto(documentEditorExtensions(), markdown));

		expect(saveOf(loadInto(documentEditorExtensions(), once))).toBe(
			markdown,
		);
	});

	it.each([
		["Timeline savings: 12 weeks"],
		["Graph nodes: 40"],
		["Pie share: 30%"],
		["Flowchart steps: 6"],
		["Block count: 4"],
	])(
		"keeps a block whose first label is %j a stat tiles node, not a diagram or code",
		(firstLine) => {
			const block = fence(firstLine, "Pilot sites: 3");
			const editor = loadInto(documentEditorExtensions(), block);

			expect(topLevelTypes(editor)).toEqual([STAT_TILES_NODE_NAME]);
			expect(saveOf(editor)).toBe(block);
		},
	);

	it("orders its <pre> rule ahead of the mermaid sniff and the code block", () => {
		const editor = new Editor({ extensions: documentEditorExtensions() });
		const rules = ProseMirrorDOMParser.fromSchema(editor.schema).rules;
		const preRuleIndex = (node: string) =>
			rules.findIndex(
				(rule) =>
					"tag" in rule && rule.tag === "pre" && rule.node === node,
			);
		editor.destroy();

		const statTiles = preRuleIndex(STAT_TILES_NODE_NAME);
		expect(statTiles).toBeGreaterThanOrEqual(0);
		expect(statTiles).toBeLessThan(preRuleIndex("mermaidBlock"));
		expect(statTiles).toBeLessThan(preRuleIndex("codeBlock"));
	});

	it("wins on its rule priority alone, even registered after every other node", () => {
		// Extension priority 1 puts the node last in the schema, so on equal
		// rule priority the code block's stat tiles guard and the mermaid
		// sniff would be tried first. Only the rule's own priority can still
		// claim the fence.
		const extensions = [
			...createAdvancedExtensions({ projectId: null, documentId: null }),
			StatTilesBlock.extend({ priority: 1 }),
		];
		const block = fence("Timeline savings: 12 weeks", "Pie share: 30%");
		const editor = loadInto(extensions, block);

		const nodeNames = Object.keys(editor.schema.nodes);
		expect(nodeNames.indexOf(STAT_TILES_NODE_NAME)).toBeGreaterThan(
			nodeNames.indexOf("mermaidBlock"),
		);
		expect(topLevelTypes(editor)).toEqual([STAT_TILES_NODE_NAME]);
		expect(saveOf(editor)).toBe(block);
	});

	it("accepts an AI edit inside the block instead of concatenating it", () => {
		// The diff markers are marks; a node that forbade them would drop the
		// `<del>` on parse and save the old value glued to the new one.
		const editor = new Editor({
			extensions: documentEditorExtensions(),
			content: `<pre><code class="language-stat-tiles">Pilot sites: <del class="diff-del">3</del><ins class="diff-ins">7</ins></code></pre>`,
		});

		expect(topLevelTypes(editor)).toEqual([STAT_TILES_NODE_NAME]);
		const saved = saveOf(editor);
		expect(saved).toBe(fence("Pilot sites: 7"));
		expect(saved).not.toContain("37");
	});

	it("stays out of the schema unless the editor opts in", () => {
		const withTiles = new Editor({
			extensions: documentEditorExtensions(),
		});
		const without = new Editor({
			extensions: createAdvancedExtensions({
				projectId: null,
				documentId: null,
			}),
		});

		expect(withTiles.schema.nodes[STAT_TILES_NODE_NAME]).toBeDefined();
		expect(without.schema.nodes[STAT_TILES_NODE_NAME]).toBeUndefined();
		withTiles.destroy();
		without.destroy();
	});
});

describe("the collaborative document editor", () => {
	it("registers the node when asked, and leaves it out otherwise", () => {
		const build = (statTiles?: boolean) =>
			(
				createCollaborativeExtensions({
					ydoc: new Y.Doc(),
					provider: null,
					user: { name: "Dev Example", color: "#336699" },
					projectId: null,
					documentId: null,
					statTiles,
				}) ?? []
			).map((extension) => extension.name);

		expect(build(true)).toContain(STAT_TILES_NODE_NAME);
		expect(build()).not.toContain(STAT_TILES_NODE_NAME);
	});
});

describe("editors that do not opt in keep the fence as a code block", () => {
	it("parses the block as a plain stat-tiles code block in the feature editor's set", () => {
		const markdown = withProse(MARKED_FENCE);
		const editor = loadInto(advancedExtensions, markdown);

		expect(topLevelTypes(editor)).toEqual([
			"heading",
			"paragraph",
			"codeBlock",
			"paragraph",
		]);
		expect(editor.state.doc.child(2).attrs.language).toBe("stat-tiles");
		expect(saveOf(editor)).toBe(markdown);
	});

	it.each([
		["Timeline savings: 12 weeks"],
		["Pie share: 30%"],
		["Graph nodes: 40"],
	])(
		"keeps a block whose first label is %j a stat-tiles code block, never a diagram",
		(firstLine) => {
			// MermaidBlock sniffs a <pre>'s first line for a diagram keyword. Had
			// it claimed this block, the save would write it back as ```mermaid.
			const block = fence(firstLine, "Pilot sites: 3");
			const editor = loadInto(advancedExtensions, block);

			expect(topLevelTypes(editor)).toEqual(["codeBlock"]);
			expect(editor.state.doc.child(0).attrs.language).toBe("stat-tiles");
			expect(saveOf(editor)).toBe(block);
		},
	);

	it.each([
		{
			set: "the feature editor's set",
			extensions: advancedExtensions,
			expected: "codeBlock",
		},
		{
			set: "the document editor's set",
			extensions: documentEditorExtensions(),
			expected: STAT_TILES_NODE_NAME,
		},
	])(
		"$set gives a stat tiles <pre> to $expected first, the way ProseMirror matches rules",
		({ extensions, expected }) => {
			const editor = new Editor({ extensions });
			const rules = ProseMirrorDOMParser.fromSchema(editor.schema).rules;
			editor.destroy();
			const pre = document.createElement("pre");
			pre.innerHTML =
				'<code class="language-stat-tiles">Timeline savings: 12 weeks</code>';

			// Rules are tried in order; the first whose tag matches and whose
			// getAttrs does not refuse the element claims it.
			const claimant = rules.find(
				(rule) =>
					"tag" in rule &&
					rule.tag === "pre" &&
					(!rule.getAttrs || rule.getAttrs(pre) !== false),
			);

			expect(claimant && "node" in claimant ? claimant.node : null).toBe(
				expected,
			);
		},
	);
});

describe("both extension sets leave other fences alone", () => {
	it.each([
		{
			set: "the document editor's set",
			extensions: documentEditorExtensions(),
		},
		{ set: "the feature editor's set", extensions: advancedExtensions },
	])(
		"$set still hands a real mermaid fence to the diagram and a ts fence to the code block",
		({ extensions }) => {
			const markdown = lines(
				"```mermaid",
				"timeline",
				"  Kickoff : Week 1",
				"```",
				"",
				"```ts",
				"const pilotSites = 3;",
				"```",
			);
			const editor = loadInto(extensions, markdown);

			expect(topLevelTypes(editor)).toEqual([
				"mermaidBlock",
				"codeBlock",
			]);
			expect(editor.state.doc.child(1).attrs.language).toBe("ts");
			expect(saveOf(editor)).toBe(markdown);
		},
	);
});

describe("readers outside the editor keep the block", () => {
	it("fromMarkdown keeps the block as a fence with its body as text", () => {
		const html = fromMarkdown(MARKED_FENCE);

		expect(html).toContain('<code class="language-stat-tiles">');
		expect(html).toContain("%% fabric-visual: a1b2c3d4e5f6");
		expect(html).toContain("Faster onboarding: 40%");
		expect(html).toContain("Annual savings: $1.2M");
	});

	it("fromMarkdown escapes markup in the body instead of rendering it", () => {
		const html = fromMarkdown(fence("<script>alert(1)</script>: 40%"));

		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;: 40%");
	});

	function readBlobText(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onloadend = () => resolve(reader.result as string);
			reader.onerror = reject;
			reader.readAsText(blob);
		});
	}

	beforeEach(() => {
		docxText.runs.length = 0;
	});

	it("the PDF download prints the tiles' lines", async () => {
		const pdf = await readBlobText(
			await renderMarkdownToPdf(withProse(MARKED_FENCE)),
		);

		expect(pdf).toContain("The pilot went well.");
		expect(pdf).toContain("Faster onboarding: 40%");
		expect(pdf).toContain("Annual savings: $1.2M");
		expect(pdf).toContain("Next steps follow.");
	});

	it("the DOCX download prints the tiles' lines", async () => {
		await renderMarkdownToDocx(withProse(MARKED_FENCE), "Results");

		expect(docxText.runs).toContain("Faster onboarding: 40%");
		expect(docxText.runs).toContain("Pilot sites: 3");
		expect(docxText.runs).toContain("Annual savings: $1.2M");
	});
});

function TestEditor({
	markdown,
	editable = true,
	onEditor,
}: {
	markdown: string;
	editable?: boolean;
	onEditor?: (editor: ReactEditor) => void;
}) {
	const editor = useEditor({
		extensions: documentEditorExtensions(),
		content: fromMarkdown(markdown),
		editable,
		immediatelyRender: true,
		editorProps: { attributes: { "aria-label": "Proposal body" } },
	});
	if (editor) {
		onEditor?.(editor);
	}
	return (
		<div className="tiptap-host">
			<EditorContent editor={editor} />
		</div>
	);
}

async function findTiles(container: HTMLElement): Promise<HTMLElement> {
	return waitFor(() => {
		const list = container.querySelector<HTMLElement>("dl.pa-stat-tiles");
		if (!list) {
			throw new Error("no tiles yet");
		}
		return list;
	});
}

function tilePairs(list: HTMLElement): Array<[string, string]> {
	return Array.from(list.querySelectorAll(".pa-stat-tile")).map((tile) => [
		tile.querySelector("dt")?.textContent ?? "",
		tile.querySelector("dd")?.textContent ?? "",
	]);
}

async function findSource(container: HTMLElement): Promise<HTMLElement> {
	return waitFor(() => {
		const source = container.querySelector<HTMLElement>(
			"[data-stat-tiles] pre[data-node-view-content]",
		);
		if (!source?.textContent) {
			throw new Error("no source yet");
		}
		return source;
	});
}

describe("the stat tiles node view", () => {
	it("takes the toggle's text from tooltips.editor in both locales", () => {
		expect(EDIT_SOURCE).toBe("Edit source");
		expect(de.tooltips.editor.editStatTilesSource).toBe(
			"Quelltext bearbeiten",
		);
	});

	it("draws a valid block as a description list of label and value pairs", async () => {
		const { container } = render(<TestEditor markdown={MARKED_FENCE} />);

		const list = await findTiles(container);

		expect(list).toHaveAttribute("data-visual-id", "a1b2c3d4e5f6");
		expect(list).toHaveAttribute("data-count", "3");
		expect(tilePairs(list)).toEqual([
			["Faster onboarding", "40%"],
			["Pilot sites", "3"],
			["Annual savings", "$1.2M"],
		]);
		// Each tile is a dt/dd group, the shape screen readers announce.
		for (const tile of list.querySelectorAll(".pa-stat-tile")) {
			expect(tile.tagName).toBe("DIV");
			expect(tile.querySelector("dt.pa-stat-label")).not.toBeNull();
			expect(tile.querySelector("dd.pa-stat-value")).not.toBeNull();
		}
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("keeps the source mounted but clipped and hidden from assistive tech while the tiles show", async () => {
		const { container } = render(
			<TestEditor markdown={withProse(MARKED_FENCE)} />,
		);
		await findTiles(container);

		const source = await findSource(container);

		expect(source).toHaveClass("sr-only");
		expect(source).toHaveAttribute("aria-hidden", "true");
		expect(source.textContent).toContain("Faster onboarding: 40%");
	});

	it("opens and closes the editable source from an accessible toggle", async () => {
		const user = userEvent.setup();
		const { container } = render(
			<TestEditor markdown={withProse(MARKED_FENCE)} />,
		);
		await findTiles(container);

		const toggle = screen.getByRole("button", { name: EDIT_SOURCE });
		const source = await findSource(container);
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(toggle).toHaveAttribute("aria-controls", source.id);
		expect(toggle.className).toContain("focus-visible:ring-2");

		await user.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(source).not.toHaveClass("sr-only");
		expect(source).not.toHaveAttribute("aria-hidden");
		// The tiles still show above the open source, as a live preview.
		expect(container.querySelector("dl.pa-stat-tiles")).not.toBeNull();

		await user.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(source).toHaveClass("sr-only");
	});

	it("opens the source while the selection is inside the block", async () => {
		let editor: ReactEditor | null = null;
		const { container } = render(
			<TestEditor
				markdown={withProse(MARKED_FENCE)}
				onEditor={(instance) => {
					editor = instance;
				}}
			/>,
		);
		await findTiles(container);
		const source = await findSource(container);
		expect(source).toHaveClass("sr-only");

		let blockPos = -1;
		(editor as unknown as ReactEditor).state.doc.forEach((node, offset) => {
			if (node.type.name === STAT_TILES_NODE_NAME) {
				blockPos = offset;
			}
		});
		(editor as unknown as ReactEditor).commands.setTextSelection(
			blockPos + 3,
		);

		await waitFor(() => expect(source).not.toHaveClass("sr-only"));
		expect(
			screen.getByRole("button", { name: EDIT_SOURCE }),
		).toHaveAttribute("aria-expanded", "true");
	});

	it("shows a five-item block as its source with the rule, not as tiles", async () => {
		const { container } = render(<TestEditor markdown={FIVE_ITEM_FENCE} />);

		const source = await findSource(container);
		const status = await screen.findByRole("status");

		expect(status.textContent).toContain(STAT_TILES_RULE);
		expect(status.textContent).not.toMatch(/\n/);
		expect(source).not.toHaveClass("sr-only");
		expect(source).not.toHaveAttribute("aria-hidden");
		expect(source.textContent).toContain("Regions: 2");
		expect(container.querySelector("dl")).toBeNull();
		expect(
			screen.queryByRole("button", { name: EDIT_SOURCE }),
		).not.toBeInTheDocument();
	});

	it("renders markup in a label or value as text", async () => {
		const { container } = render(
			<TestEditor
				markdown={fence(
					"<script>alert(1)</script>: <b>40%</b>",
					"<img src=x onerror=alert(1)>: 3",
				)}
			/>,
		);

		const list = await findTiles(container);

		expect(tilePairs(list)).toEqual([
			["<script>alert(1)</script>", "<b>40%</b>"],
			["<img src=x onerror=alert(1)>", "3"],
		]);
		expect(container.querySelector("script")).toBeNull();
		expect(container.querySelector("img")).toBeNull();
		expect(list.querySelector("b")).toBeNull();
	});

	it("shows the source while a pending AI edit marks the block", async () => {
		function DiffEditor() {
			const editor = useEditor({
				extensions: documentEditorExtensions(),
				content: `<pre><code class="language-stat-tiles">Pilot sites: <del class="diff-del">3</del><ins class="diff-ins">7</ins></code></pre>`,
				immediatelyRender: true,
			});
			return <EditorContent editor={editor} />;
		}
		const { container } = render(<DiffEditor />);

		const source = await findSource(container);

		expect(source).not.toHaveClass("sr-only");
		expect(source.querySelector("del.diff-del")?.textContent).toBe("3");
		expect(source.querySelector("ins.diff-ins")?.textContent).toBe("7");
		expect(container.querySelector("dl")).toBeNull();
	});

	it("names no rule while a pending AI edit marks the block", async () => {
		// Either side of the edit is four tiles, which the rule accepts; the
		// deleted and inserted lines read together are five, which it refuses.
		const lines = [1, 2, 3].map((n) => `Pilot site ${n}: ${n}`).join("\n");
		function DiffEditor() {
			const editor = useEditor({
				extensions: documentEditorExtensions(),
				content: `<pre><code class="language-stat-tiles">${lines}\n<del class="diff-del">Annual savings: $1M\n</del><ins class="diff-ins">Annual savings: $2M</ins></code></pre>`,
				immediatelyRender: true,
			});
			return <EditorContent editor={editor} />;
		}
		const { container } = render(<DiffEditor />);

		await findSource(container);

		expect(container.querySelector("output")).toBeNull();
	});

	describe("read-only", () => {
		it("draws the tiles without the toggle", async () => {
			const { container } = render(
				<TestEditor markdown={MARKED_FENCE} editable={false} />,
			);

			const list = await findTiles(container);

			expect(tilePairs(list)).toHaveLength(3);
			expect(screen.queryByRole("button")).not.toBeInTheDocument();
			expect(await axe(container)).toHaveNoViolations();
		});

		it("draws a block that breaks the rule as a plain code block, without the editor's reason", async () => {
			const { container } = render(
				<TestEditor markdown={FIVE_ITEM_FENCE} editable={false} />,
			);

			const source = await findSource(container);

			expect(source).not.toHaveClass("sr-only");
			expect(source.textContent).toContain("Regions: 2");
			expect(screen.queryByRole("status")).not.toBeInTheDocument();
			expect(container.querySelector("dl")).toBeNull();
		});
	});
});

describe("the Proposal live pane", () => {
	function renderPane(liveContent: string) {
		const props: ProposalLiveSectionsProps = {
			liveContent,
			savedContent: null,
			status: "GENERATING",
			progress: 40,
			title: "Example proposal",
			generationStartedAt: new Date(),
			updatedAt: new Date(),
		};
		return render(<ProposalLiveSections {...props} />);
	}

	it("draws a stat tiles block as tiles", async () => {
		const { container } = renderPane(withProse(MARKED_FENCE));

		const list = await findTiles(container);

		expect(tilePairs(list)).toEqual([
			["Faster onboarding", "40%"],
			["Pilot sites", "3"],
			["Annual savings", "$1.2M"],
		]);
		expect(
			screen.queryByRole("button", { name: EDIT_SOURCE }),
		).not.toBeInTheDocument();
		expect(await axe(container)).toHaveNoViolations();
	});
});
