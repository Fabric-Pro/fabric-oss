/**
 * The cover details of a Proposal in its Main body (Fizzy #2946).
 *
 * A ```` ```cover ```` fence in the preamble loads into the client
 * Proposal's document editor as its own node, shows its fields as a summary
 * card when its body follows the rule and as its source otherwise, and saves
 * back byte for byte. Editors that do not opt in keep the fence as a plain
 * code block of its language, never a diagram.
 *
 * The editor tests drive the real load path (`fromMarkdown` into Tiptap with
 * the document editor's extensions) and the real save path
 * (`getEditorMarkdownForSave`), because the round trip lives in the parse
 * step between them.
 */

import en from "@repo/i18n/translations/en.json";
import { COVER_RULE } from "@repo/utils/proposal-artifact/cover-fence";
import { fromMarkdown } from "@saas/projects/lib/diff-utils";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import {
	COVER_NODE_NAME,
	CoverBlock,
} from "@saas/projects/lib/tiptap-cover-extension";
import { createCollaborativeExtensions } from "@saas/projects/lib/tiptap-extensions";
import {
	advancedExtensions,
	createAdvancedExtensions,
} from "@saas/projects/lib/tiptap-extensions-advanced";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor } from "@tiptap/core";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import {
	EditorContent,
	type Editor as ReactEditor,
	useEditor,
} from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
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

/** The toggle's visible text, read from the real catalogue. */
const EDIT_SOURCE = en.tooltips.editor.editBlockSource;

const lines = (...parts: string[]) => parts.join("\n");

const coverFence = (...body: string[]) => lines("```cover", ...body, "```");

const COVER_FENCE = coverFence(
	"%% fabric-visual: a1b2c3d4e5f6",
	"eyebrow: Proposal · Operations board",
	"organization: Example Harbor Co · Logistics division",
	"for: Example Harbor Co",
	"for: 1 Example Quay, Example City",
	"by: Example Delivery Team",
	"version: 12",
);

/** An unknown key, which the rule refuses. */
const REFUSED_COVER_FENCE = coverFence(
	"title: Example proposal",
	"for: Example Harbor Co",
);

/** A body opening with a diagram keyword: refused, but never a diagram. */
const KEYWORD_COVER_FENCE = coverFence(
	"block partners: Example Harbor Co",
	"version: 2",
);

/** The fence where the cover reads it: in the preamble, before the first H2. */
const inPreamble = (block: string) =>
	lines(
		"# Proposal for Example Harbor Co",
		"",
		"A shared schedule for every depot.",
		"",
		block,
		"",
		"## Summary",
		"",
		"The pilot went well.",
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

const escapeHtml = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

describe("the document editor loads and saves a cover fence", () => {
	it("loads the fence as its node", () => {
		const editor = loadInto(
			documentEditorExtensions(),
			inPreamble(COVER_FENCE),
		);

		expect(topLevelTypes(editor)).toEqual([
			"heading",
			"paragraph",
			COVER_NODE_NAME,
			"heading",
			"paragraph",
		]);
		editor.destroy();
	});

	it.each([
		{ state: "a valid", block: COVER_FENCE },
		{ state: "a refused", block: REFUSED_COVER_FENCE },
		{ state: "a keyword-led", block: KEYWORD_COVER_FENCE },
	])("saves $state cover back byte for byte", ({ block }) => {
		const markdown = inPreamble(block);
		const editor = loadInto(documentEditorExtensions(), markdown);

		expect(topLevelTypes(editor)).toContain(COVER_NODE_NAME);
		expect(saveOf(editor)).toBe(markdown);
	});

	it("survives a second load and save unchanged", () => {
		const markdown = inPreamble(COVER_FENCE);
		const once = saveOf(loadInto(documentEditorExtensions(), markdown));

		expect(saveOf(loadInto(documentEditorExtensions(), once))).toBe(
			markdown,
		);
	});

	it("keeps a cover opening with a diagram keyword its node, not a diagram or code", () => {
		const editor = loadInto(
			documentEditorExtensions(),
			KEYWORD_COVER_FENCE,
		);

		expect(topLevelTypes(editor)).toEqual([COVER_NODE_NAME]);
		expect(saveOf(editor)).toBe(KEYWORD_COVER_FENCE);
	});

	it("orders its <pre> rule ahead of the mermaid sniff and the code block", () => {
		const editor = new Editor({ extensions: documentEditorExtensions() });
		const rules = ProseMirrorDOMParser.fromSchema(editor.schema).rules;
		const preRuleIndex = (node: string) =>
			rules.findIndex(
				(rule) =>
					"tag" in rule && rule.tag === "pre" && rule.node === node,
			);
		editor.destroy();

		const own = preRuleIndex(COVER_NODE_NAME);
		expect(own).toBeGreaterThanOrEqual(0);
		expect(own).toBeLessThan(preRuleIndex("mermaidBlock"));
		expect(own).toBeLessThan(preRuleIndex("codeBlock"));
	});

	it("wins a keyword-led fence on its rule priority alone, even registered after every other node", () => {
		// Extension priority 1 puts the node last in the schema, so on equal
		// rule priority the code block's guard and the mermaid sniff would be
		// tried first. Only the rule's own priority can still claim the fence.
		const extensions = [
			...createAdvancedExtensions({ projectId: null, documentId: null }),
			CoverBlock.extend({ priority: 1 }),
		];
		const editor = loadInto(extensions, KEYWORD_COVER_FENCE);

		const nodeNames = Object.keys(editor.schema.nodes);
		expect(nodeNames.indexOf(COVER_NODE_NAME)).toBeGreaterThan(
			nodeNames.indexOf("mermaidBlock"),
		);
		expect(topLevelTypes(editor)).toEqual([COVER_NODE_NAME]);
		expect(saveOf(editor)).toBe(KEYWORD_COVER_FENCE);
	});

	it("accepts an AI edit inside the block instead of concatenating it", () => {
		// The diff markers are marks; a node that forbade them would drop the
		// `<del>` on parse and save the old text glued to the new.
		const editor = new Editor({
			extensions: documentEditorExtensions(),
			content: `<pre><code class="language-cover">for: Example Harbor Co\nversion: <del class="diff-del">11</del><ins class="diff-ins">12</ins></code></pre>`,
		});

		expect(topLevelTypes(editor)).toEqual([COVER_NODE_NAME]);
		const saved = saveOf(editor);
		expect(saved).toBe(coverFence("for: Example Harbor Co", "version: 12"));
		expect(saved).not.toContain("1112");
	});

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

		expect(withForms.schema.nodes[COVER_NODE_NAME]).toBeDefined();
		expect(without.schema.nodes[COVER_NODE_NAME]).toBeUndefined();
		withForms.destroy();
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

		expect(build(true)).toContain(COVER_NODE_NAME);
		expect(build(false)).not.toContain(COVER_NODE_NAME);
		expect(build()).not.toContain(COVER_NODE_NAME);
	});
});

describe("editors that do not opt in keep the fence as a code block", () => {
	it("parses a cover fence as a plain code block of its language in the feature editor's set", () => {
		const markdown = inPreamble(COVER_FENCE);
		const editor = loadInto(advancedExtensions, markdown);

		expect(topLevelTypes(editor)).toEqual([
			"heading",
			"paragraph",
			"codeBlock",
			"heading",
			"paragraph",
		]);
		expect(editor.state.doc.child(2).attrs.language).toBe("cover");
		expect(saveOf(editor)).toBe(markdown);
	});

	it("keeps a cover opening with a diagram keyword a code block, never a diagram", () => {
		// MermaidBlock sniffs a <pre>'s first line for a diagram keyword,
		// `block` among them. Had it claimed this block, the save would write
		// it back as ```mermaid.
		const editor = loadInto(advancedExtensions, KEYWORD_COVER_FENCE);

		expect(topLevelTypes(editor)).toEqual(["codeBlock"]);
		expect(editor.state.doc.child(0).attrs.language).toBe("cover");
		expect(saveOf(editor)).toBe(KEYWORD_COVER_FENCE);
	});

	it.each([
		{
			set: "the feature editor's set",
			extensions: () => advancedExtensions,
		},
		{
			set: "the document editor's set",
			extensions: documentEditorExtensions,
		},
	])(
		"$set keeps a Cover fence, its language not in lower case, a code block of that language",
		({ extensions }) => {
			// The guard matches the language in any case; the node claims only
			// the lower case, so a form is drawn only from ```cover.
			const body = lines(
				"block partners: Example Harbor Co",
				"version: 2",
			);
			const editor = new Editor({
				extensions: extensions(),
				content: `<pre><code class="language-Cover">${escapeHtml(body)}</code></pre>`,
			});

			expect(topLevelTypes(editor)).toEqual(["codeBlock"]);
			expect(editor.state.doc.child(0).attrs.language).toBe("Cover");
			expect(saveOf(editor)).toBe(lines("```Cover", body, "```"));
		},
	);
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

function findSummary(container: HTMLElement): Promise<HTMLElement> {
	return waitFor(() => {
		const summary = container.querySelector<HTMLElement>(
			'[data-proposal-block="cover"] dl',
		);
		if (!summary) {
			throw new Error("no summary yet");
		}
		return summary;
	});
}

function findSource(container: HTMLElement): Promise<HTMLElement> {
	return waitFor(() => {
		const source = container.querySelector<HTMLElement>(
			'[data-proposal-block="cover"] pre[data-node-view-content]',
		);
		if (!source?.textContent) {
			throw new Error("no source yet");
		}
		return source;
	});
}

/** Each field's key and its lines, in the order the summary shows them. */
function summaryFields(summary: HTMLElement) {
	return Array.from(summary.querySelectorAll(":scope > div")).map(
		(group) => ({
			key: group.querySelector("dt")?.textContent ?? null,
			values: Array.from(group.querySelectorAll("dd")).map(
				(value) => value.textContent,
			),
		}),
	);
}

describe("the cover node view", () => {
	it("shows a valid block as a summary of its fields, in the cover's order", async () => {
		const { container } = render(
			<TestEditor markdown={inPreamble(COVER_FENCE)} />,
		);

		const summary = await findSummary(container);

		expect(summary).toHaveAttribute("data-visual-id", "a1b2c3d4e5f6");
		expect(summary).toHaveAttribute("contenteditable", "false");
		expect(summaryFields(summary)).toEqual([
			{ key: "eyebrow", values: ["Proposal · Operations board"] },
			{
				key: "organization",
				values: ["Example Harbor Co · Logistics division"],
			},
			{
				key: "for",
				values: ["Example Harbor Co", "1 Example Quay, Example City"],
			},
			{ key: "by", values: ["Example Delivery Team"] },
			{ key: "version", values: ["12"] },
		]);
		// The card summarises the source; it never takes the print cover's
		// classes or joins the outline.
		expect(container.querySelector(".pa-cover")).toBeNull();
		expect(summary.querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("leaves out the fields a block does not set", async () => {
		const { container } = render(
			<TestEditor markdown={coverFence("version: 3")} />,
		);

		const summary = await findSummary(container);

		expect(summaryFields(summary)).toEqual([
			{ key: "version", values: ["3"] },
		]);
	});

	it("renders markup in a value as text", async () => {
		const { container } = render(
			<TestEditor
				markdown={coverFence(
					"for: <b>Example</b> <script>alert(1)</script>",
					"by: **Example Delivery Team**",
				)}
			/>,
		);

		const summary = await findSummary(container);

		expect(summaryFields(summary)).toEqual([
			{
				key: "for",
				values: ["<b>Example</b> <script>alert(1)</script>"],
			},
			{ key: "by", values: ["**Example Delivery Team**"] },
		]);
		expect(container.querySelector("script")).toBeNull();
		expect(summary.querySelector("b, strong")).toBeNull();
	});

	it("keeps the source mounted but clipped and hidden from assistive tech while the summary shows", async () => {
		const { container } = render(
			<TestEditor markdown={inPreamble(COVER_FENCE)} />,
		);
		await findSummary(container);

		const source = await findSource(container);

		expect(source).toHaveClass("sr-only");
		expect(source).toHaveAttribute("aria-hidden", "true");
	});

	it("opens and closes the editable source from an accessible toggle", async () => {
		const user = userEvent.setup();
		const { container } = render(
			<TestEditor markdown={inPreamble(COVER_FENCE)} />,
		);
		await findSummary(container);

		const toggle = screen.getByRole("button", { name: EDIT_SOURCE });
		const source = await findSource(container);
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(toggle).toHaveAttribute("aria-controls", source.id);

		await user.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(source).not.toHaveClass("sr-only");
		expect(source).not.toHaveAttribute("aria-hidden");

		await user.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(source).toHaveClass("sr-only");
	});

	it("shows a refused block as its source with the rule and the reason, not as a summary", async () => {
		const { container } = render(
			<TestEditor markdown={REFUSED_COVER_FENCE} />,
		);

		const source = await findSource(container);
		const status = await screen.findByRole("status");

		expect(status.textContent).toBe(
			`${COVER_RULE} Line 1 has the unknown key "title".`,
		);
		expect(source).not.toHaveClass("sr-only");
		expect(source).not.toHaveAttribute("aria-hidden");
		expect(source.textContent).toContain("title: Example proposal");
		expect(
			container.querySelector('[data-proposal-block="cover"] dl'),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: EDIT_SOURCE }),
		).not.toBeInTheDocument();
	});

	it("shows the source while a pending AI edit marks the block", async () => {
		const { container } = render(
			<HtmlEditor
				html={`<pre><code class="language-cover">for: Example Harbor Co\nversion: <del class="diff-del">11</del><ins class="diff-ins">12</ins></code></pre>`}
			/>,
		);

		const source = await findSource(container);

		expect(source).not.toHaveClass("sr-only");
		expect(source.querySelector("del.diff-del")).not.toBeNull();
		expect(source.querySelector("ins.diff-ins")).not.toBeNull();
		expect(
			container.querySelector('[data-proposal-block="cover"] dl'),
		).toBeNull();
	});

	describe("the node's text sits in its source holder in every state", () => {
		it.each([
			{ state: "shown as a summary", markdown: COVER_FENCE },
			{ state: "refused", markdown: REFUSED_COVER_FENCE },
			{
				state: "read-only, shown as a summary",
				markdown: COVER_FENCE,
				editable: false,
			},
			{
				state: "read-only, refused",
				markdown: REFUSED_COVER_FENCE,
				editable: false,
			},
		])("$state", async ({ markdown, ...rest }) => {
			const editable = "editable" in rest ? rest.editable : true;
			const { container } = render(
				<TestEditor markdown={markdown} editable={editable} />,
			);
			const source = await findSource(container);

			const node = container.querySelector(".node-coverBlock");
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
					html={`<pre><code class="language-cover">for: <del class="diff-del">Example Port</del><ins class="diff-ins">Example Harbor Co</ins></code></pre>`}
				/>,
			);
			const source = await findSource(container);

			const node = container.querySelector(".node-coverBlock");
			const contents = node?.querySelectorAll(
				"[data-node-view-content-react]",
			);
			expect(contents).toHaveLength(1);
			expect(contents?.[0]?.parentElement).toBe(source);
		});
	});

	describe("read-only", () => {
		it("shows the summary without the toggle", async () => {
			const { container } = render(
				<TestEditor
					markdown={inPreamble(COVER_FENCE)}
					editable={false}
				/>,
			);

			const summary = await findSummary(container);

			expect(summaryFields(summary)).toHaveLength(5);
			expect(screen.queryByRole("button")).not.toBeInTheDocument();
			expect(await axe(container)).toHaveNoViolations();
		});

		it("shows a refused block as a plain code block, without the editor's reason", async () => {
			const { container } = render(
				<TestEditor markdown={REFUSED_COVER_FENCE} editable={false} />,
			);

			const source = await findSource(container);

			expect(source).not.toHaveClass("sr-only");
			expect(source.textContent).toContain("title: Example proposal");
			expect(screen.queryByRole("status")).not.toBeInTheDocument();
			expect(
				container.querySelector('[data-proposal-block="cover"] dl'),
			).toBeNull();
		});
	});
});
