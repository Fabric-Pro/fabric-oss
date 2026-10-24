/**
 * The diagram menu on a client-document Proposal's page (Fizzy #2946): one
 * "Diagram actions" trigger per diagram, reachable by keyboard, holding the
 * diagram's actions, with the diagram's origin above it. Every other
 * document keeps the header bar.
 *
 * The editor is the document editor's own extension set, rendered with the
 * real node view, Radix menu and renderer; only the translations (the real
 * message files) and the oRPC client are stubbed.
 */

import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DiagramHarness,
	FLOWCHART_BODY,
	fence,
	GANTT_BODY,
	MARKER,
	VISUAL_ID,
} from "./tiptap-mermaid-visual-harness";

// The real renderer, except for a source marked BROKEN, which neither
// renderer draws. mermaid.js needs layout jsdom lacks, so its fallback
// (gantt and the like) draws a stand-in SVG.
const drawn = vi.hoisted(() => ({ sources: [] as string[] }));

vi.mock("beautiful-mermaid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("beautiful-mermaid")>();
	return {
		...actual,
		renderMermaidSVG: (
			code: string,
			options: Parameters<typeof actual.renderMermaidSVG>[1],
		) => {
			drawn.sources.push(code);
			if (code.includes("BROKEN")) {
				throw new Error("Parse error on line 2");
			}
			return actual.renderMermaidSVG(code, options);
		},
	};
});

vi.mock("mermaid", () => {
	const api = {
		initialize: () => {},
		mermaidAPI: { getSiteConfig: () => ({}) },
		render: async (_id: string, code: string) => {
			if (code.includes("BROKEN")) {
				throw new Error("Parse error on line 2");
			}
			return {
				svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 200 100"><text>Fallback</text></svg>',
			};
		},
	};
	return { default: api };
});

const intl = vi.hoisted(() => ({ locale: "en" as "en" | "de" }));

vi.mock("next-intl", async () => {
	const actual =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	const en = (await import("@repo/i18n/translations/en.json")).default;
	const de = (await import("@repo/i18n/translations/de.json")).default;
	return {
		useTranslations: (namespace: string) =>
			actual.createTranslator({
				locale: intl.locale,
				messages: (intl.locale === "de" ? de : en) as never,
				namespace: namespace as never,
				onError: () => {},
			}),
		useLocale: () => intl.locale,
	};
});

const rpc = vi.hoisted(() => ({
	listVisualSpecs: vi.fn(),
	editVisual: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				listVisualSpecs: rpc.listVisualSpecs,
				editVisual: rpc.editVisual,
			},
		},
	},
}));

const { visualSourceHash } = await import(
	"@repo/utils/proposal-artifact/visual-identity"
);

const FLOWCHART = fence(FLOWCHART_BODY);
const FLOWCHART_HASH = visualSourceHash(FLOWCHART_BODY.join("\n"));
const DOCUMENT = `## Delivery\n\nWe start with discovery.\n\n${FLOWCHART}\n\nNext steps follow.`;

function specsResolving(
	specs: Array<{ origin: "STEP" | "INSTRUCTION"; sourceHash?: string }>,
) {
	rpc.listVisualSpecs.mockResolvedValue({
		specs: specs.map((spec) => ({
			visualId: VISUAL_ID,
			sourceHash: spec.sourceHash ?? FLOWCHART_HASH,
			kind: "timeline",
			origin: spec.origin,
		})),
	});
}

async function renderDiagram(
	markdown = DOCUMENT,
	options: Partial<Parameters<typeof DiagramHarness>[0]> = {},
) {
	let editor: Editor | null = null;
	const utils = render(
		<DiagramHarness
			markdown={markdown}
			visual={{ isMember: true }}
			onEditor={(created) => {
				editor = created;
			}}
			{...options}
		/>,
	);
	await waitFor(() => {
		if (!utils.container.querySelector(".mermaid-diagram-area svg")) {
			throw new Error("no diagram yet");
		}
	});
	return {
		...utils,
		editor: () => {
			if (!editor) {
				throw new Error("no editor");
			}
			return editor as Editor;
		},
	};
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
	const trigger = screen.getByRole("button", { name: "Diagram actions" });
	act(() => trigger.focus());
	await user.keyboard("{Enter}");
	return { trigger, menu: await screen.findByRole("menu") };
}

async function chooseItem(
	user: ReturnType<typeof userEvent.setup>,
	name: RegExp,
) {
	await openMenu(user);
	await user.click(screen.getByRole("menuitem", { name }));
}

beforeEach(() => {
	intl.locale = "en";
	rpc.listVisualSpecs.mockReset();
	rpc.editVisual.mockReset();
	specsResolving([]);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the diagram menu, by keyboard", () => {
	it("is reached by Tab without hovering, opens on Enter, moves with the arrows, and Escape returns focus to the trigger", async () => {
		const user = userEvent.setup();
		await renderDiagram();
		const trigger = screen.getByRole("button", { name: "Diagram actions" });

		// The editor's content is first in the tab order; the trigger next.
		await user.tab();
		await user.tab();
		expect(trigger).toHaveFocus();

		await user.keyboard("{Enter}");
		const menu = await screen.findByRole("menu");
		const items = within(menu).getAllByRole("menuitem");
		expect(items).toHaveLength(5);

		await waitFor(() => expect(items[0]).toHaveFocus());
		await user.keyboard("{ArrowDown}");
		expect(items[1]).toHaveFocus();
		await user.keyboard("{ArrowDown}");
		expect(items[2]).toHaveFocus();

		await user.keyboard("{Escape}");
		await waitFor(() =>
			expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
		);
		await waitFor(() => expect(trigger).toHaveFocus());
	});

	it("names the trigger and exposes menu and menuitem roles, the AI items with a description", async () => {
		const user = userEvent.setup();
		await renderDiagram();

		const { trigger, menu } = await openMenu(user);

		expect(trigger).toHaveAccessibleName("Diagram actions");
		expect(trigger).toHaveAttribute("aria-haspopup", "menu");
		const items = within(menu).getAllByRole("menuitem");
		expect(items.map((item) => item.textContent)).toEqual([
			expect.stringContaining("Edit with instructions"),
			expect.stringContaining("Build with AI"),
			"Edit source",
			"Caption",
			"Delete",
		]);
		expect(items[0]).toHaveAccessibleName("Edit with instructions");
		expect(items[0]).toHaveAccessibleDescription(
			"Describe a change and review it before it applies.",
		);
		expect(items[1]).toHaveAccessibleName("Build with AI");
		expect(items[1]).toHaveAccessibleDescription(
			"Rewrite the diagram from a description.",
		);
		expect(within(menu).getAllByRole("separator")).toHaveLength(2);
	});
});

describe("focus after each item", () => {
	it("Edit with instructions focuses its instruction field", async () => {
		const user = userEvent.setup();
		await renderDiagram();

		await chooseItem(user, /^Edit with instructions/);

		await waitFor(() =>
			expect(
				screen.getByRole("textbox", {
					name: "What should change in this diagram?",
				}),
			).toHaveFocus(),
		);
	});

	it("Build with AI opens its panel and focuses its field, closing Edit with instructions", async () => {
		const user = userEvent.setup();
		await renderDiagram();

		await chooseItem(user, /^Edit with instructions/);
		await waitFor(() =>
			expect(
				screen.getByRole("textbox", {
					name: "What should change in this diagram?",
				}),
			).toBeInTheDocument(),
		);
		await chooseItem(user, /^Build with AI/);

		await waitFor(() =>
			expect(
				screen.getByRole("textbox", {
					name: "Describe the diagram for AI to generate",
				}),
			).toHaveFocus(),
		);
		expect(
			screen.queryByRole("textbox", {
				name: "What should change in this diagram?",
			}),
		).not.toBeInTheDocument();
	});

	it("Edit source opens the source view and focuses its code field", async () => {
		const user = userEvent.setup();
		await renderDiagram();

		await chooseItem(user, /^Edit source/);

		const code = await screen.findByRole("textbox", {
			name: "Mermaid diagram code",
		});
		await waitFor(() => expect(code).toHaveFocus());
		expect((code as HTMLTextAreaElement).value.split("\n")[0]).toBe(MARKER);
	});

	it("Caption focuses the caption field, and Enter writes the caption line after the marker", async () => {
		const user = userEvent.setup();
		const { editor } = await renderDiagram();

		await chooseItem(user, /^Caption/);

		const caption = await screen.findByRole("textbox", {
			name: "Diagram caption",
		});
		await waitFor(() => expect(caption).toHaveFocus());
		await user.type(caption, "Delivery plan{Enter}");

		const node = diagramNode(editor());
		expect(node.text.split("\n").slice(0, 3)).toEqual([
			MARKER,
			"%% caption: Delivery plan",
			"flowchart LR",
		]);
		expect(node.attrs.caption).toBeNull();
		expect(
			screen.getByRole("button", { name: "Delivery plan" }),
		).toBeInTheDocument();
	});

	it("Delete removes the node and puts the caret where it was", async () => {
		const user = userEvent.setup();
		const { editor, container } = await renderDiagram();
		let diagramPos = -1;
		editor().state.doc.descendants((node, pos) => {
			if (node.type.name === "mermaidBlock") {
				diagramPos = pos;
			}
		});
		const before = getEditorMarkdownForSave(editor());

		await chooseItem(user, /^Delete/);

		await waitFor(() =>
			expect(container.querySelector(".mermaid-wrapper")).toBeNull(),
		);
		const types: string[] = [];
		editor().state.doc.forEach((node) => {
			types.push(node.type.name);
		});
		expect(types).not.toContain("mermaidBlock");
		expect(editor().state.selection.from).toBeGreaterThanOrEqual(
			diagramPos - 1,
		);
		expect(editor().state.selection.from).toBeLessThanOrEqual(
			diagramPos + 1,
		);
		await waitFor(() => expect(editor().view.hasFocus()).toBe(true));
		expect(getEditorMarkdownForSave(editor())).toBe(
			before?.replace(`${FLOWCHART}\n\n`, ""),
		);
	});
});

describe("which items show", () => {
	it("a member sees Build with AI and Edit with instructions", async () => {
		const user = userEvent.setup();
		await renderDiagram();
		const { menu } = await openMenu(user);
		expect(
			within(menu).getByRole("menuitem", { name: "Build with AI" }),
		).toBeInTheDocument();
		expect(
			within(menu).getByRole("menuitem", {
				name: "Edit with instructions",
			}),
		).toBeInTheDocument();
	});

	it("a project guest sees Edit with instructions and no Build with AI", async () => {
		const user = userEvent.setup();
		await renderDiagram(DOCUMENT, { visual: { isMember: false } });
		const { menu } = await openMenu(user);
		expect(
			within(menu).queryByRole("menuitem", { name: "Build with AI" }),
		).not.toBeInTheDocument();
		expect(
			within(menu).getByRole("menuitem", {
				name: "Edit with instructions",
			}),
		).toBeInTheDocument();
	});

	it("a gantt diagram offers no Edit with instructions", async () => {
		const user = userEvent.setup();
		await renderDiagram(`## Plan\n\n${fence(GANTT_BODY)}`);
		const { menu } = await openMenu(user);
		expect(
			within(menu).queryByRole("menuitem", {
				name: "Edit with instructions",
			}),
		).not.toBeInTheDocument();
		expect(
			within(menu).getByRole("menuitem", { name: "Edit source" }),
		).toBeInTheDocument();
	});

	it("a header that only starts with graph is no flowchart, as the server reads it", async () => {
		const user = userEvent.setup();
		await renderDiagram(`## Plan\n\n${fence(["graph-x LR", "  a --> b"])}`);
		const { menu } = await openMenu(user);
		expect(
			within(menu).queryByRole("menuitem", {
				name: "Edit with instructions",
			}),
		).not.toBeInTheDocument();
	});

	it("a read-only page shows no menu", async () => {
		await renderDiagram(DOCUMENT, { editable: false });
		expect(
			screen.queryByRole("button", { name: "Diagram actions" }),
		).not.toBeInTheDocument();
	});
});

describe("the header bar", () => {
	it("on a client-document Proposal no header bar renders", async () => {
		const { container } = await renderDiagram();
		expect(container.querySelector("[data-visual-menu]")).not.toBeNull();
		expect(
			screen.queryByRole("button", { name: "Delete diagram" }),
		).not.toBeInTheDocument();
		expect(container.textContent).not.toContain("Mermaid");
	});

	it("without the Proposal context (any other document) the header bar renders as before", async () => {
		const { container } = await renderDiagram(DOCUMENT, {
			visual: undefined,
			themeRoot: false,
		});
		expect(
			screen.queryByRole("button", { name: "Diagram actions" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Delete diagram" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: "Open the Mermaid source in an editable panel. Ctrl+Enter saves.",
			}),
		).toBeInTheDocument();
		expect(container.textContent).toContain("Build with AI");
		expect(rpc.listVisualSpecs).not.toHaveBeenCalled();
	});

	it("the source view keeps its header buttons", async () => {
		const user = userEvent.setup();
		await renderDiagram();
		await chooseItem(user, /^Edit source/);

		await screen.findByRole("textbox", { name: "Mermaid diagram code" });
		expect(
			screen.getByRole("button", { name: "Delete diagram" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: "Return to the rendered diagram. Any unsaved edits to the source are discarded.",
			}),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Diagram actions" }),
		).not.toBeInTheDocument();
	});

	it("the error view keeps its header buttons and offers Edit with instructions for a flowchart", async () => {
		const broken = fence([MARKER, "flowchart LR", '  a["BROKEN']);
		render(
			<DiagramHarness markdown={`## Flow\n\n${broken}`} visual={{}} />,
		);

		await screen.findByText("Parse error on line 2");
		expect(
			screen.getByRole("button", { name: "Delete diagram" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Edit with instructions" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Diagram actions" }),
		).not.toBeInTheDocument();
	});
});

describe("the diagram's origin", () => {
	it.each([
		["en", "STEP", "Added automatically"],
		["en", "INSTRUCTION", "Updated with instructions"],
		["de", "STEP", "Automatisch hinzugefügt"],
		["de", "INSTRUCTION", "Mit Anweisungen aktualisiert"],
	] as const)(
		"%s: a generated diagram of origin %s reads “%s”",
		async (locale, origin, label) => {
			intl.locale = locale;
			specsResolving([{ origin }]);
			await renderDiagram();
			expect(await screen.findByText(label)).toBeInTheDocument();
			expect(rpc.listVisualSpecs).toHaveBeenCalledWith({
				projectId: "project-1",
				documentId: "document-1",
			});
		},
	);

	it("says nothing for an edited diagram (rows for its id, none with its source)", async () => {
		specsResolving([{ origin: "STEP", sourceHash: "v1:0000000000000000" }]);
		const { container } = await renderDiagram();
		await waitFor(() => expect(rpc.listVisualSpecs).toHaveBeenCalled());
		await act(async () => {});
		expect(container.textContent).not.toContain("Added automatically");
		expect(container.textContent).not.toContain(
			"Updated with instructions",
		);
	});

	it("says nothing for a hand-written diagram", async () => {
		specsResolving([{ origin: "STEP" }]);
		const handWritten = fence(FLOWCHART_BODY.slice(1));
		const { container } = await renderDiagram(`## Flow\n\n${handWritten}`);
		await waitFor(() => expect(rpc.listVisualSpecs).toHaveBeenCalled());
		await act(async () => {});
		expect(container.textContent).not.toContain("Added automatically");
	});

	it("says nothing while the summaries load, nor when their read fails", async () => {
		rpc.listVisualSpecs.mockReturnValue(new Promise(() => {}));
		const loading = await renderDiagram();
		expect(loading.container.textContent).not.toContain(
			"Added automatically",
		);
		loading.unmount();

		rpc.listVisualSpecs.mockRejectedValue(
			Object.assign(new Error("denied"), { code: "FORBIDDEN" }),
		);
		const failed = await renderDiagram();
		await waitFor(() =>
			expect(rpc.listVisualSpecs).toHaveBeenCalledTimes(2),
		);
		await act(async () => {});
		expect(failed.container.textContent).not.toContain(
			"Added automatically",
		);
	});

	it("a diagram with literal colours and no marker says its colours are fixed", async () => {
		const baked = fence([
			"flowchart LR",
			'  a["Discovery"] --> b["Launch"]',
			"  style a fill:#e7e8eb",
		]);
		await renderDiagram(`## Flow\n\n${baked}`);
		expect(
			screen.getByText(
				"Colours are fixed in this diagram. Use Edit with instructions to restyle it.",
			),
		).toBeInTheDocument();
	});
});

/** The document's one diagram node: its text and attributes. */
function diagramNode(editor: Editor) {
	let found: { text: string; attrs: Record<string, unknown> } | null = null;
	editor.state.doc.descendants((node) => {
		if (node.type.name === "mermaidBlock") {
			found = { text: node.textContent, attrs: node.attrs };
		}
	});
	if (!found) {
		throw new Error("no diagram node");
	}
	return found as { text: string; attrs: Record<string, unknown> };
}

async function setCaption(
	user: ReturnType<typeof userEvent.setup>,
	keys: string,
) {
	await chooseItem(user, /^Caption/);
	const caption = await screen.findByRole("textbox", {
		name: "Diagram caption",
	});
	await waitFor(() => expect(caption).toHaveFocus());
	await user.clear(caption);
	if (keys) {
		await user.type(caption, keys);
	}
	return caption;
}

const CAPTIONED_FLOWCHART = fence([
	MARKER,
	"%% caption: Delivery plan",
	...FLOWCHART_BODY.slice(1),
]);

describe("the caption on save", () => {
	it("survives the round trip editor, Markdown, editor as the fence's caption line", async () => {
		const user = userEvent.setup();
		const first = await renderDiagram();
		await setCaption(user, "Delivery plan{Enter}");

		const saved = getEditorMarkdownForSave(first.editor());

		expect(saved).toContain(CAPTIONED_FLOWCHART);
		const body = CAPTIONED_FLOWCHART.split("\n").slice(1, -1).join("\n");
		// The caption is not part of the generated diagram's source.
		expect(visualSourceHash(body)).toBe(FLOWCHART_HASH);

		first.unmount();
		const second = await renderDiagram(saved ?? "");
		expect(
			screen.getByRole("button", { name: "Delivery plan" }),
		).toBeInTheDocument();
		expect(getEditorMarkdownForSave(second.editor())).toBe(saved);
	});

	it("is replaced, and removed when cleared", async () => {
		const user = userEvent.setup();
		const { editor } = await renderDiagram(
			`## Delivery\n\n${CAPTIONED_FLOWCHART}\n`,
		);
		expect(
			screen.getByRole("button", { name: "Delivery plan" }),
		).toBeInTheDocument();

		await setCaption(user, "Launch plan{Enter}");
		expect(diagramNode(editor()).text.split("\n")[1]).toBe(
			"%% caption: Launch plan",
		);

		await setCaption(user, "{Enter}");
		expect(diagramNode(editor()).text.trimEnd()).toBe(
			FLOWCHART_BODY.join("\n"),
		);
		expect(getEditorMarkdownForSave(editor())).toContain(FLOWCHART);
	});

	it("is left as it was when the field is closed with Escape", async () => {
		const user = userEvent.setup();
		const { editor } = await renderDiagram(
			`## Delivery\n\n${CAPTIONED_FLOWCHART}\n`,
		);

		await setCaption(user, "Something else{Escape}");

		expect(diagramNode(editor()).text.split("\n")[1]).toBe(
			"%% caption: Delivery plan",
		);
		expect(
			screen.getByRole("button", { name: "Delivery plan" }),
		).toBeInTheDocument();
	});

	it("folds a caption an older document kept as an attribute into the body on save", async () => {
		const { editor } = await renderDiagram();
		act(() => {
			const view = editor().view;
			let at = -1;
			view.state.doc.descendants((node, pos) => {
				if (node.type.name === "mermaidBlock") {
					at = pos;
				}
			});
			view.dispatch(
				view.state.tr.setNodeAttribute(at, "caption", "Delivery plan"),
			);
		});

		expect(
			await screen.findByRole("button", { name: "Delivery plan" }),
		).toBeInTheDocument();
		expect(getEditorMarkdownForSave(editor())).toContain(
			CAPTIONED_FLOWCHART,
		);
	});

	it("is never part of the source the diagram is drawn from", async () => {
		drawn.sources.length = 0;
		await renderDiagram(`## Delivery\n\n${CAPTIONED_FLOWCHART}\n`);

		expect(drawn.sources.length).toBeGreaterThan(0);
		for (const source of drawn.sources) {
			expect(source).not.toContain("caption");
		}
	});

	it("would not change the drawing even if the renderer saw it, being a comment", async () => {
		const actual =
			await vi.importActual<typeof import("beautiful-mermaid")>(
				"beautiful-mermaid",
			);
		const source = FLOWCHART_BODY.slice(1).join("\n");

		expect(
			actual.renderMermaidSVG(`%% caption: Delivery plan\n${source}`, {}),
		).toBe(actual.renderMermaidSVG(source, {}));
	});
});

describe("a diagram wider than its column", () => {
	function narrowColumn(width: number) {
		return vi
			.spyOn(HTMLElement.prototype, "clientWidth", "get")
			.mockImplementation(function (this: HTMLElement) {
				return this.classList.contains("mermaid-diagram-area")
					? width
					: 0;
			});
	}

	it("scrolls in a focusable region named for the diagram, inside the theme root", async () => {
		const spy = narrowColumn(200);
		try {
			const { container } = await renderDiagram();
			const region = await screen.findByRole("region", {
				name: "Diagram, scrolls sideways",
			});
			expect(region).toHaveAttribute("tabindex", "0");
			expect(region).toHaveAttribute("data-scroll-edge", "start");
			const width = Number.parseFloat(
				region.style.getPropertyValue("--pa-diagram-width"),
			);
			expect(width).toBeGreaterThan(200);
			expect(container.querySelector(".mermaid-diagram-area")).toBe(
				region,
			);
		} finally {
			spy.mockRestore();
		}
	});

	it("is left to the page's own sizing outside the theme root", async () => {
		const spy = narrowColumn(200);
		try {
			const { container } = await renderDiagram(DOCUMENT, {
				themeRoot: false,
			});
			await act(async () => {});
			expect(screen.queryByRole("region")).not.toBeInTheDocument();
			expect(
				container.querySelector(".mermaid-diagram-area"),
			).not.toHaveAttribute("tabindex");
		} finally {
			spy.mockRestore();
		}
	});
});
