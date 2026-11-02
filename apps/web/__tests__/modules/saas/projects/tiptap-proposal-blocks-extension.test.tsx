/**
 * Card grids and two columns in a Proposal's Main body (Fizzy #2946).
 *
 * A ```` ```cards ```` or ```` ```columns ```` fence loads into the client
 * Proposal's document editor as its own node, draws as its form when its
 * body follows the rule and as its source otherwise, and saves back byte for
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
import {
	CARDS_RULE,
	COLUMNS_RULE,
} from "@repo/utils/proposal-artifact/proposal-blocks";
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
	CARDS_NODE_NAME,
	CardsBlock,
	COLUMNS_NODE_NAME,
	ColumnsBlock,
} from "@saas/projects/lib/tiptap-proposal-blocks-extension";
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
const EDIT_SOURCE = en.tooltips.editor.editBlockSource;

const lines = (...parts: string[]) => parts.join("\n");

const cardsFence = (...body: string[]) => lines("```cards", ...body, "```");

const columnsFence = (...body: string[]) => lines("```columns", ...body, "```");

const CARDS_FENCE = cardsFence(
	"%% fabric-visual: a1b2c3d4e5f6",
	"01",
	"**Route planning**",
	"Plans each day's stops before the first truck leaves.",
	"",
	"Pilot",
	"**Example Harbor Co**",
	"Three depots, *twelve* weeks.",
);

const THREE_CARDS_FENCE = cardsFence(
	"Discovery",
	"**Two weeks**",
	"",
	"Build",
	"**Eight weeks**",
	"",
	"Rollout",
	"Every depot in one release.",
);

const FOUR_CARDS_FENCE = cardsFence(
	"North",
	"**Depot one**",
	"",
	"South",
	"**Depot two**",
	"",
	"East",
	"**Depot three**",
	"",
	"West",
	"**Depot four**",
);

const COLUMNS_FENCE = columnsFence(
	"### Today",
	"- Paper route sheets",
	"- Calls to **every** depot",
	"---",
	"#### With the platform",
	"One schedule every depot reads.",
);

/** Cards with a label and nothing else, which the rule refuses. */
const REFUSED_CARDS_FENCE = cardsFence("Pilot", "", "Rollout");

/** Two sides without the `---` line, which the rule refuses. */
const REFUSED_COLUMNS_FENCE = columnsFence("### Today", "- Paper route sheets");

/** Valid blocks whose first line opens with a diagram keyword. */
const DIAGRAM_KEYWORD_FENCES = [
	{
		name: CARDS_NODE_NAME,
		language: "cards",
		block: cardsFence(
			"Timeline risks",
			"**Vendor delays**",
			"Two suppliers share one port.",
		),
	},
	{
		name: CARDS_NODE_NAME,
		language: "cards",
		block: cardsFence("Block release", "Waits for the security review."),
	},
	{
		name: COLUMNS_NODE_NAME,
		language: "columns",
		block: columnsFence("graph notes", "---", "### Right", "Text"),
	},
	{
		name: COLUMNS_NODE_NAME,
		language: "columns",
		block: columnsFence("Pie in the sky", "---", "- Grounded plan"),
	},
] as const;

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

/** The document editor's extensions: the shared set with the forms on. */
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

const VALID_FENCES = [
	{ form: "cards", name: CARDS_NODE_NAME, block: CARDS_FENCE },
	{ form: "columns", name: COLUMNS_NODE_NAME, block: COLUMNS_FENCE },
] as const;

const REFUSED_FENCES = [
	{
		form: "cards",
		name: CARDS_NODE_NAME,
		block: REFUSED_CARDS_FENCE,
		rule: CARDS_RULE,
		sourceLine: "Rollout",
	},
	{
		form: "columns",
		name: COLUMNS_NODE_NAME,
		block: REFUSED_COLUMNS_FENCE,
		rule: COLUMNS_RULE,
		sourceLine: "- Paper route sheets",
	},
] as const;

describe("the document editor loads and saves card and column fences", () => {
	it.each(VALID_FENCES)(
		"loads a $form fence as its node",
		({ name, block }) => {
			const editor = loadInto(
				documentEditorExtensions(),
				withProse(block),
			);

			expect(topLevelTypes(editor)).toEqual([
				"heading",
				"paragraph",
				name,
				"paragraph",
			]);
			editor.destroy();
		},
	);

	it.each(VALID_FENCES)(
		"saves a document holding a $form fence back byte for byte",
		({ block }) => {
			const markdown = withProse(block);

			const saved = saveOf(
				loadInto(documentEditorExtensions(), markdown),
			);

			expect(saved).toContain(block);
			expect(saved).toBe(markdown);
		},
	);

	it.each(REFUSED_FENCES)(
		"saves a $form block that breaks the rule back byte for byte too",
		({ name, block }) => {
			const markdown = withProse(block);
			const editor = loadInto(documentEditorExtensions(), markdown);

			expect(topLevelTypes(editor)).toContain(name);
			expect(saveOf(editor)).toBe(markdown);
		},
	);

	it("survives a second load and save unchanged", () => {
		const markdown = withProse(lines(CARDS_FENCE, "", COLUMNS_FENCE));
		const once = saveOf(loadInto(documentEditorExtensions(), markdown));

		expect(saveOf(loadInto(documentEditorExtensions(), once))).toBe(
			markdown,
		);
	});

	it.each(DIAGRAM_KEYWORD_FENCES)(
		"keeps $language opening with a diagram keyword its node, not a diagram or code",
		({ name, block }) => {
			const editor = loadInto(documentEditorExtensions(), block);

			expect(topLevelTypes(editor)).toEqual([name]);
			expect(saveOf(editor)).toBe(block);
		},
	);

	it.each([CARDS_NODE_NAME, COLUMNS_NODE_NAME])(
		"orders the %s <pre> rule ahead of the mermaid sniff and the code block",
		(name) => {
			const editor = new Editor({
				extensions: documentEditorExtensions(),
			});
			const rules = ProseMirrorDOMParser.fromSchema(editor.schema).rules;
			const preRuleIndex = (node: string) =>
				rules.findIndex(
					(rule) =>
						"tag" in rule &&
						rule.tag === "pre" &&
						rule.node === node,
				);
			editor.destroy();

			const own = preRuleIndex(name);
			expect(own).toBeGreaterThanOrEqual(0);
			expect(own).toBeLessThan(preRuleIndex("mermaidBlock"));
			expect(own).toBeLessThan(preRuleIndex("codeBlock"));
		},
	);

	it.each([
		{ node: CardsBlock, entry: DIAGRAM_KEYWORD_FENCES[0] },
		{ node: ColumnsBlock, entry: DIAGRAM_KEYWORD_FENCES[2] },
	])(
		"wins $entry.language on its rule priority alone, even registered after every other node",
		({ node, entry }) => {
			// Extension priority 1 puts the node last in the schema, so on
			// equal rule priority the code block's guard and the mermaid sniff
			// would be tried first. Only the rule's own priority can still
			// claim the fence.
			const extensions = [
				...createAdvancedExtensions({
					projectId: null,
					documentId: null,
				}),
				node.extend({ priority: 1 }),
			];
			const editor = loadInto(extensions, entry.block);

			const nodeNames = Object.keys(editor.schema.nodes);
			expect(nodeNames.indexOf(entry.name)).toBeGreaterThan(
				nodeNames.indexOf("mermaidBlock"),
			);
			expect(topLevelTypes(editor)).toEqual([entry.name]);
			expect(saveOf(editor)).toBe(entry.block);
		},
	);

	it.each([
		{
			form: "cards",
			name: CARDS_NODE_NAME,
			html: `<pre><code class="language-cards">Pilot\nThree <del class="diff-del">depots</del><ins class="diff-ins">sites</ins>.</code></pre>`,
			saved: cardsFence("Pilot", "Three sites."),
			glued: "depotssites",
		},
		{
			form: "columns",
			name: COLUMNS_NODE_NAME,
			html: `<pre><code class="language-columns">### Today\n---\n- <del class="diff-del">Paper</del><ins class="diff-ins">Shared</ins> sheets</code></pre>`,
			saved: columnsFence("### Today", "---", "- Shared sheets"),
			glued: "PaperShared",
		},
	])(
		"accepts an AI edit inside a $form block instead of concatenating it",
		({ name, html, saved, glued }) => {
			// The diff markers are marks; a node that forbade them would drop
			// the `<del>` on parse and save the old text glued to the new.
			const editor = new Editor({
				extensions: documentEditorExtensions(),
				content: html,
			});

			expect(topLevelTypes(editor)).toEqual([name]);
			const result = saveOf(editor);
			expect(result).toBe(saved);
			expect(result).not.toContain(glued);
		},
	);

	it("stays out of the schema unless the editor opts in", () => {
		const withForms = new Editor({
			extensions: documentEditorExtensions(),
		});
		const without = new Editor({
			extensions: createAdvancedExtensions({
				projectId: null,
				documentId: null,
			}),
		});

		expect(withForms.schema.nodes[CARDS_NODE_NAME]).toBeDefined();
		expect(withForms.schema.nodes[COLUMNS_NODE_NAME]).toBeDefined();
		expect(without.schema.nodes[CARDS_NODE_NAME]).toBeUndefined();
		expect(without.schema.nodes[COLUMNS_NODE_NAME]).toBeUndefined();
		withForms.destroy();
		without.destroy();
	});
});

describe("the collaborative document editor", () => {
	it("registers both nodes when asked, and leaves them out otherwise", () => {
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

		expect(build(true)).toEqual(
			expect.arrayContaining([CARDS_NODE_NAME, COLUMNS_NODE_NAME]),
		);
		expect(build()).not.toContain(CARDS_NODE_NAME);
		expect(build()).not.toContain(COLUMNS_NODE_NAME);
	});
});

describe("editors that do not opt in keep the fence as a code block", () => {
	it.each(VALID_FENCES)(
		"parses a $form fence as a plain code block of its language in the feature editor's set",
		({ form, block }) => {
			const markdown = withProse(block);
			const editor = loadInto(advancedExtensions, markdown);

			expect(topLevelTypes(editor)).toEqual([
				"heading",
				"paragraph",
				"codeBlock",
				"paragraph",
			]);
			expect(editor.state.doc.child(2).attrs.language).toBe(form);
			expect(saveOf(editor)).toBe(markdown);
		},
	);

	it.each(DIAGRAM_KEYWORD_FENCES)(
		"keeps $language opening with a diagram keyword a code block of its language, never a diagram",
		({ language, block }) => {
			// MermaidBlock sniffs a <pre>'s first line for a diagram keyword.
			// Had it claimed this block, the save would write it back as
			// ```mermaid.
			const editor = loadInto(advancedExtensions, block);

			expect(topLevelTypes(editor)).toEqual(["codeBlock"]);
			expect(editor.state.doc.child(0).attrs.language).toBe(language);
			expect(saveOf(editor)).toBe(block);
		},
	);

	it.each([
		{
			set: "the feature editor's set",
			extensions: advancedExtensions,
			cards: "codeBlock",
			columns: "codeBlock",
		},
		{
			set: "the document editor's set",
			extensions: documentEditorExtensions(),
			cards: CARDS_NODE_NAME,
			columns: COLUMNS_NODE_NAME,
		},
	])(
		"$set gives a cards and a columns <pre> to the right node first, the way ProseMirror matches rules",
		({ extensions, cards, columns }) => {
			const editor = new Editor({ extensions });
			const rules = ProseMirrorDOMParser.fromSchema(editor.schema).rules;
			editor.destroy();
			const claimantOf = (language: string, body: string) => {
				const pre = document.createElement("pre");
				const code = document.createElement("code");
				code.className = `language-${language}`;
				code.textContent = body;
				pre.append(code);
				// Rules are tried in order; the first whose tag matches and
				// whose getAttrs does not refuse the element claims it.
				const claimant = rules.find(
					(rule) =>
						"tag" in rule &&
						rule.tag === "pre" &&
						(!rule.getAttrs || rule.getAttrs(pre) !== false),
				);
				return claimant && "node" in claimant ? claimant.node : null;
			};

			expect(
				claimantOf("cards", "Timeline risks\n**Vendor delays**"),
			).toBe(cards);
			expect(claimantOf("columns", "graph notes\n---\nText")).toBe(
				columns,
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
	it.each(VALID_FENCES)(
		"fromMarkdown keeps a $form fence as a code block of its language",
		({ form, block }) => {
			const html = fromMarkdown(block);

			expect(html).toContain(`<code class="language-${form}">`);
		},
	);

	it("fromMarkdown escapes markup in the body instead of rendering it", () => {
		const html = fromMarkdown(
			cardsFence("Risk", "<script>alert(1)</script> text."),
		);

		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; text.");
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

	it("the PDF download prints the fences' lines", async () => {
		const pdf = await readBlobText(
			await renderMarkdownToPdf(
				withProse(lines(CARDS_FENCE, "", COLUMNS_FENCE)),
			),
		);

		expect(pdf).toContain("The pilot went well.");
		expect(pdf).toContain("**Route planning**");
		expect(pdf).toContain("- Paper route sheets");
		expect(pdf).toContain("Next steps follow.");
	});

	it("the DOCX download prints the fences' lines", async () => {
		await renderMarkdownToDocx(
			withProse(lines(CARDS_FENCE, "", COLUMNS_FENCE)),
			"Results",
		);

		expect(docxText.runs).toContain("**Route planning**");
		expect(docxText.runs).toContain("### Today");
		expect(docxText.runs).toContain("One schedule every depot reads.");
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

/** An editor loaded from HTML, for a body that carries AI diff marks. */
function HtmlEditor({ html }: { html: string }) {
	const editor = useEditor({
		extensions: documentEditorExtensions(),
		content: html,
		immediatelyRender: true,
	});
	return <EditorContent editor={editor} />;
}

async function findElement(
	container: HTMLElement,
	selector: string,
): Promise<HTMLElement> {
	return waitFor(() => {
		const element = container.querySelector<HTMLElement>(selector);
		if (!element) {
			throw new Error(`no ${selector} yet`);
		}
		return element;
	});
}

const findCards = (container: HTMLElement) =>
	findElement(container, "div.pa-cards");

const findColumns = (container: HTMLElement) =>
	findElement(container, "div.pa-columns");

async function findSource(
	container: HTMLElement,
	form: "cards" | "columns",
): Promise<HTMLElement> {
	return waitFor(() => {
		const source = container.querySelector<HTMLElement>(
			`[data-proposal-block="${form}"] pre[data-node-view-content]`,
		);
		if (!source?.textContent) {
			throw new Error("no source yet");
		}
		return source;
	});
}

function cardParts(grid: HTMLElement) {
	return Array.from(grid.querySelectorAll(".pa-card")).map((card) => ({
		label: card.querySelector(".pa-card-label")?.textContent ?? null,
		title: card.querySelector(".pa-card-title")?.textContent ?? null,
		text: card.querySelector(".pa-card-text")?.textContent ?? null,
	}));
}

describe("the card and column node views", () => {
	it("take the toggle's text from tooltips.editor in both locales", () => {
		expect(EDIT_SOURCE).toBe("Edit source");
		expect(de.tooltips.editor.editBlockSource).toBe("Quelltext bearbeiten");
	});

	it("draw a valid cards block as bordered cards of label, title and text", async () => {
		const { container } = render(<TestEditor markdown={CARDS_FENCE} />);

		const grid = await findCards(container);

		expect(grid).toHaveAttribute("data-visual-id", "a1b2c3d4e5f6");
		expect(grid).toHaveAttribute("data-count", "2");
		expect(grid).not.toHaveClass("pa-cards-3");
		expect(cardParts(grid)).toEqual([
			{
				label: "01",
				title: "Route planning",
				text: "Plans each day's stops before the first truck leaves.",
			},
			{
				label: "Pilot",
				title: "Example Harbor Co",
				text: "Three depots, twelve weeks.",
			},
		]);
		for (const card of grid.querySelectorAll(".pa-card")) {
			expect(card.tagName).toBe("DIV");
			expect(card.querySelector("p.pa-card-label")).not.toBeNull();
		}
		expect(grid.querySelector(".pa-card-text em")?.textContent).toBe(
			"twelve",
		);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("leaves out a card's title or text when the card has none", async () => {
		const { container } = render(
			<TestEditor markdown={THREE_CARDS_FENCE} />,
		);

		const grid = await findCards(container);

		expect(cardParts(grid)).toEqual([
			{ label: "Discovery", title: "Two weeks", text: null },
			{ label: "Build", title: "Eight weeks", text: null },
			{
				label: "Rollout",
				title: null,
				text: "Every depot in one release.",
			},
		]);
	});

	it.each([
		{ count: 2, block: CARDS_FENCE, oneRow: false },
		{ count: 3, block: THREE_CARDS_FENCE, oneRow: true },
		{ count: 4, block: FOUR_CARDS_FENCE, oneRow: false },
	])(
		"puts $count cards in one row only when there are exactly three ($oneRow)",
		async ({ count, block, oneRow }) => {
			const { container } = render(<TestEditor markdown={block} />);

			const grid = await findCards(container);

			expect(grid.querySelectorAll(".pa-card")).toHaveLength(count);
			expect(grid.classList.contains("pa-cards-3")).toBe(oneRow);
		},
	);

	it("draws a valid columns block as two columns of headings, bullets and paragraphs", async () => {
		const { container } = render(<TestEditor markdown={COLUMNS_FENCE} />);

		const pair = await findColumns(container);

		const [left, right] = Array.from(pair.querySelectorAll(".pa-column"));
		expect(pair.querySelectorAll(".pa-column")).toHaveLength(2);
		expect(left?.querySelector("p.pa-column-heading")?.textContent).toBe(
			"Today",
		);
		expect(
			Array.from(left?.querySelectorAll("ul > li") ?? []).map(
				(item) => item.textContent,
			),
		).toEqual(["Paper route sheets", "Calls to every depot"]);
		expect(left?.querySelector("li strong")?.textContent).toBe("every");
		expect(right?.querySelector("p.pa-column-heading")?.textContent).toBe(
			"With the platform",
		);
		expect(
			right?.querySelector("p:not(.pa-column-heading)")?.textContent,
		).toBe("One schedule every depot reads.");
		// A column heading is a styled paragraph, never part of the outline.
		expect(pair.querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
	});

	it("renders inline marks as elements and markup as text", async () => {
		const { container } = render(
			<TestEditor
				markdown={cardsFence(
					"<b>Scope</b>",
					"**Phase *one* `api`**",
					"Covers ***both*** and <script>alert(1)</script> text.",
				)}
			/>,
		);

		const grid = await findCards(container);
		const title = grid.querySelector<HTMLElement>(".pa-card-title");
		const text = grid.querySelector<HTMLElement>(".pa-card-text");

		expect(cardParts(grid)).toEqual([
			{
				label: "<b>Scope</b>",
				title: "Phase one api",
				text: "Covers both and <script>alert(1)</script> text.",
			},
		]);
		expect(title?.querySelector("em")?.textContent).toBe("one");
		expect(title?.querySelector("code")?.textContent).toBe("api");
		expect(text?.querySelector("strong > em")?.textContent).toBe("both");
		expect(container.querySelector("script")).toBeNull();
		expect(grid.querySelector("b")).toBeNull();
	});

	it.each(VALID_FENCES)(
		"keeps the $form source mounted but clipped and hidden from assistive tech while the form shows",
		async ({ form, block }) => {
			const { container } = render(
				<TestEditor markdown={withProse(block)} />,
			);
			await findElement(container, `div.pa-${form}`);

			const source = await findSource(container, form);

			expect(source).toHaveClass("sr-only");
			expect(source).toHaveAttribute("aria-hidden", "true");
		},
	);

	it("opens and closes the editable source from an accessible toggle", async () => {
		const user = userEvent.setup();
		const { container } = render(
			<TestEditor markdown={withProse(COLUMNS_FENCE)} />,
		);
		await findColumns(container);

		const toggle = screen.getByRole("button", { name: EDIT_SOURCE });
		const source = await findSource(container, "columns");
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(toggle).toHaveAttribute("aria-controls", source.id);
		expect(toggle.className).toContain("focus-visible:ring-2");

		await user.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(source).not.toHaveClass("sr-only");
		expect(source).not.toHaveAttribute("aria-hidden");
		// The form still shows above the open source, as a live preview.
		expect(container.querySelector("div.pa-columns")).not.toBeNull();

		await user.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(source).toHaveClass("sr-only");
	});

	it("opens the source while the selection is inside the block", async () => {
		let editor: ReactEditor | null = null;
		const { container } = render(
			<TestEditor
				markdown={withProse(CARDS_FENCE)}
				onEditor={(instance) => {
					editor = instance;
				}}
			/>,
		);
		await findCards(container);
		const source = await findSource(container, "cards");
		expect(source).toHaveClass("sr-only");

		let blockPos = -1;
		(editor as unknown as ReactEditor).state.doc.forEach((node, offset) => {
			if (node.type.name === CARDS_NODE_NAME) {
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

	it.each(REFUSED_FENCES)(
		"shows a refused $form block as its source with the rule, not as its form",
		async ({ form, block, rule, sourceLine }) => {
			const { container } = render(<TestEditor markdown={block} />);

			const source = await findSource(container, form);
			const status = await screen.findByRole("status");

			expect(status.textContent?.startsWith(rule)).toBe(true);
			expect(source).not.toHaveClass("sr-only");
			expect(source).not.toHaveAttribute("aria-hidden");
			expect(source.textContent).toContain(sourceLine);
			expect(container.querySelector(`div.pa-${form}`)).toBeNull();
			expect(
				screen.queryByRole("button", { name: EDIT_SOURCE }),
			).not.toBeInTheDocument();
		},
	);

	it.each([
		{
			form: "cards",
			html: `<pre><code class="language-cards">Pilot\n**Example Harbor Co**\nThree <del class="diff-del">depots</del><ins class="diff-ins">sites</ins>.</code></pre>`,
		},
		{
			form: "columns",
			html: `<pre><code class="language-columns">### Today\n---\n- <del class="diff-del">Paper</del><ins class="diff-ins">Shared</ins> sheets</code></pre>`,
		},
	] as const)(
		"shows the $form source while a pending AI edit marks the block",
		async ({ form, html }) => {
			const { container } = render(<HtmlEditor html={html} />);

			const source = await findSource(container, form);

			expect(source).not.toHaveClass("sr-only");
			expect(source.querySelector("del.diff-del")).not.toBeNull();
			expect(source.querySelector("ins.diff-ins")).not.toBeNull();
			expect(container.querySelector(`div.pa-${form}`)).toBeNull();
		},
	);

	it("names no rule while a pending AI edit marks the block", async () => {
		// Either side of the edit has one --- line, which the rule accepts;
		// the deleted and inserted lines read together have two, which it
		// refuses.
		const { container } = render(
			<HtmlEditor
				html={`<pre><code class="language-columns">### Today\n- Paper\n<del class="diff-del">---\n</del><ins class="diff-ins">---\n</ins>### Platform\nOne schedule.</code></pre>`}
			/>,
		);

		await findSource(container, "columns");

		expect(container.querySelector("output")).toBeNull();
	});

	describe("the node's text sits in its source holder in every state", () => {
		it.each([
			{ state: "drawn cards", form: "cards", markdown: CARDS_FENCE },
			{
				state: "drawn columns",
				form: "columns",
				markdown: COLUMNS_FENCE,
			},
			{
				state: "refused cards",
				form: "cards",
				markdown: REFUSED_CARDS_FENCE,
			},
			{
				state: "refused columns",
				form: "columns",
				markdown: REFUSED_COLUMNS_FENCE,
			},
			{
				state: "read-only drawn cards",
				form: "cards",
				markdown: CARDS_FENCE,
				editable: false,
			},
			{
				state: "read-only refused columns",
				form: "columns",
				markdown: REFUSED_COLUMNS_FENCE,
				editable: false,
			},
		] as const)("$state", async ({ form, markdown, ...rest }) => {
			const editable = "editable" in rest ? rest.editable : true;
			const { container } = render(
				<TestEditor markdown={markdown} editable={editable} />,
			);
			const source = await findSource(container, form);

			const node = container.querySelector(
				form === "cards" ? ".node-cardsBlock" : ".node-columnsBlock",
			);
			const contents = node?.querySelectorAll(
				"[data-node-view-content-react]",
			);
			// TipTap appends the content element to the node itself when the
			// view renders no NodeViewContent, where it shows as stray text.
			expect(contents).toHaveLength(1);
			expect(contents?.[0]?.parentElement).toBe(source);
			expect(contents?.[0]?.parentElement).not.toBe(node);
		});

		it("under AI review", async () => {
			const { container } = render(
				<HtmlEditor
					html={`<pre><code class="language-cards">Pilot\n<del class="diff-del">Three</del><ins class="diff-ins">Four</ins> depots.</code></pre>`}
				/>,
			);
			const source = await findSource(container, "cards");

			const node = container.querySelector(".node-cardsBlock");
			const contents = node?.querySelectorAll(
				"[data-node-view-content-react]",
			);
			expect(contents).toHaveLength(1);
			expect(contents?.[0]?.parentElement).toBe(source);
		});
	});

	describe("read-only", () => {
		it("draws both forms without the toggle", async () => {
			const { container } = render(
				<TestEditor
					markdown={lines(CARDS_FENCE, "", COLUMNS_FENCE)}
					editable={false}
				/>,
			);

			const grid = await findCards(container);
			await findColumns(container);

			expect(cardParts(grid)).toHaveLength(2);
			expect(screen.queryByRole("button")).not.toBeInTheDocument();
			expect(await axe(container)).toHaveNoViolations();
		});

		it.each(REFUSED_FENCES)(
			"draws a refused $form block as a plain code block, without the editor's reason",
			async ({ form, block, sourceLine }) => {
				const { container } = render(
					<TestEditor markdown={block} editable={false} />,
				);

				const source = await findSource(container, form);

				expect(source).not.toHaveClass("sr-only");
				expect(source.textContent).toContain(sourceLine);
				expect(screen.queryByRole("status")).not.toBeInTheDocument();
				expect(container.querySelector(`div.pa-${form}`)).toBeNull();
			},
		);
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

	it("draws a cards block as cards and a columns block as columns", async () => {
		const { container } = renderPane(
			withProse(lines(CARDS_FENCE, "", COLUMNS_FENCE)),
		);

		const grid = await findCards(container);
		const pair = await findColumns(container);

		expect(cardParts(grid).map((card) => card.label)).toEqual([
			"01",
			"Pilot",
		]);
		expect(pair.querySelectorAll(".pa-column")).toHaveLength(2);
		expect(
			screen.queryByRole("button", { name: EDIT_SOURCE }),
		).not.toBeInTheDocument();
		expect(await axe(container)).toHaveNoViolations();
	});
});
