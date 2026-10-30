/**
 * A diagram that does not draw on a client-document Proposal's page (Fizzy
 * #2946): the exports leave it out, so the page shows an explicit failure
 * view in place of the generic source view. An editor gets Edit source,
 * Edit with instructions (where it is offered for the source) and Delete; a
 * reader the message and the caption only. The engine's message is never
 * shown there, and the view takes no figure number, unless it is a kind
 * only the live page draws, which the exports print as a numbered
 * placeholder. Such a kind (gantt and the like) draws, with a note to
 * editors that it is not included in the PDF. Figures are numbered as the
 * exports number them.
 *
 * The real renderer draws; it refuses a header it does not know, and a
 * source marked EngineThrowsHere. mermaid.js needs layout jsdom lacks, so
 * its fallback draws a stand-in SVG; like mermaid.js it refuses a header it
 * does not detect, and it refuses a source marked BROKEN.
 */

import {
	buildProposalThemeTokens,
	type ProposalThemePaint,
	resolveThemePaint,
} from "@repo/utils/proposal-artifact/theme-tokens";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DiagramHarness,
	FLOWCHART_BODY,
	fence,
	GANTT_BODY,
	MARKER,
} from "./tiptap-mermaid-visual-harness";

vi.mock("mermaid", () => ({
	default: {
		initialize: () => {},
		mermaidAPI: { getSiteConfig: () => ({}) },
		render: async (_id: string, code: string) => {
			// Detected as mermaid.js detects a diagram: past a frontmatter
			// block and `%%` lines, by its header's keyword.
			const header = code
				.replace(/^---\n[\s\S]*?\n---\n/, "")
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line !== "" && !line.startsWith("%%"));
			if (
				!/^(?:graph|flowchart|sequenceDiagram|gantt|pie|mindmap|timeline)/.test(
					header ?? "",
				)
			) {
				throw new Error("No diagram type detected");
			}
			if (code.includes("BROKEN")) {
				throw new Error("Parse error on line 2");
			}
			return {
				svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 200 100"><text>Fallback</text></svg>',
			};
		},
	},
}));

/**
 * beautiful-mermaid refuses a source carrying this; mermaid.js draws it.
 * The mock reaches only one of several diagrams that import the engine at
 * the same moment, so such a source is drawn on its own.
 */
const ENGINE_THROWS = "EngineThrowsHere";

vi.mock("beautiful-mermaid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("beautiful-mermaid")>();
	return {
		...actual,
		renderMermaidSVG: (
			text: string,
			options?: Parameters<typeof actual.renderMermaidSVG>[1],
		) => {
			if (text.includes("EngineThrowsHere")) {
				throw new Error("Layout failed");
			}
			return actual.renderMermaidSVG(text, options);
		},
	};
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

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				listVisualSpecs: vi.fn(async () => ({ specs: [] })),
				editVisual: vi.fn(),
			},
		},
	},
}));

const TITLE = "This diagram can't be drawn";
const EXPORTS = "It will be left out of PDF and Word exports.";
const PLACEHOLDER =
	"PDF and Word exports show a numbered placeholder in its place.";
const NOT_PRINTABLE = "Not included in PDF";
const CAPTION = "Delivery flow";

// A header neither renderer takes: the source draws nowhere.
const BROKEN_BODY = [
	MARKER,
	`%% caption: ${CAPTION}`,
	"flowchart LRt0TD",
	'  a["BROKEN"]',
];

function doc(...bodies: string[][]): string {
	return `## Delivery\n\nWe start with discovery.\n\n${bodies
		.map((body) => fence(body))
		.join("\n\nThen.\n\n")}\n`;
}

function renderPage(
	markdown: string,
	options: {
		editable?: boolean;
		visual?: boolean;
		paint?: ProposalThemePaint;
	} = {},
) {
	let editor: Editor | null = null;
	const utils = render(
		<DiagramHarness
			markdown={markdown}
			visual={
				options.visual === false
					? undefined
					: { isMember: true, paint: options.paint }
			}
			themeRoot={options.visual !== false}
			editable={options.editable}
			onEditor={(created) => {
				editor = created;
			}}
		/>,
	);
	return {
		...utils,
		editor: () => editor as unknown as Editor,
	};
}

function diagramTexts(editor: Editor): string[] {
	const texts: string[] = [];
	editor.state.doc.descendants((node) => {
		if (node.type.name === "mermaidBlock") {
			texts.push(node.textContent);
		}
	});
	return texts;
}

beforeEach(() => {
	intl.locale = "en";
});

describe("the failure view, for an editor", () => {
	it("says the diagram can't be drawn and will be left out of the exports, with its caption and actions", async () => {
		const { container } = renderPage(doc(BROKEN_BODY));

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
		expect(screen.getByText(EXPORTS)).toBeInTheDocument();
		expect(screen.getByText(CAPTION)).toBeInTheDocument();
		expect(screen.getByRole("group", { name: TITLE })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Edit source" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Edit with instructions" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Delete" }),
		).toBeInTheDocument();
		// No engine message, no source, no generic source view. (The node's
		// text stays in ProseMirror's hidden content element.)
		const view = container.querySelector("[data-diagram-failure]");
		expect(view?.textContent).not.toContain("Parse error");
		expect(view?.textContent).not.toContain("BROKEN");
		expect(
			screen.queryByRole("textbox", { name: "Mermaid diagram code" }),
		).not.toBeInTheDocument();
	});

	it("keeps the diagram's source in the document, out of sight", async () => {
		const { container } = renderPage(doc(BROKEN_BODY));
		await screen.findByText(TITLE);

		const node = container.querySelector(".node-mermaidBlock");
		const source = node?.querySelector("[data-node-view-content-react]");
		expect(source?.textContent).toContain("flowchart LRt0TD");
		// Inside a hidden holder, never as a visible block beside the view.
		const holder = source?.parentElement;
		expect(holder).not.toBe(node);
		expect(holder?.classList.contains("hidden")).toBe(true);
		expect(holder?.getAttribute("aria-hidden")).toBe("true");
	});

	it("takes no figure number", async () => {
		const { container } = renderPage(doc(BROKEN_BODY));
		await screen.findByText(TITLE);

		expect(container.querySelector(".pa-figure-counted")).toBeNull();
		expect(container.querySelector(".pa-figure-caption")).toBeNull();
	});

	it("numbers the figures on either side of it as one and two", async () => {
		const { container } = renderPage(
			doc(FLOWCHART_BODY, BROKEN_BODY, FLOWCHART_BODY),
		);
		await screen.findByText(TITLE);
		await waitFor(() =>
			expect(
				container.querySelectorAll(".mermaid-diagram-area svg"),
			).toHaveLength(2),
		);

		const wrappers = [...container.querySelectorAll(".mermaid-container")];
		expect(
			wrappers.map((wrapper) =>
				wrapper.classList.contains("pa-figure-counted"),
			),
		).toEqual([true, false, true]);
	});

	it.each([
		["a misspelt header", ["flowchrt TD", "  a --> b"]],
		["plain text", ["Discovery, then Build, then Launch."]],
	])("leaves %s out of the exports, unnumbered", async (_name, body) => {
		const { container } = renderPage(doc(body));

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
		expect(screen.getByText(EXPORTS)).toBeInTheDocument();
		expect(container.querySelector(".pa-figure-counted")).toBeNull();
	});

	it("offers no Edit with instructions for a source it is not offered for", async () => {
		const brokenGantt = [...GANTT_BODY, "  BROKEN"];
		renderPage(doc(brokenGantt));

		await screen.findByText(TITLE);
		expect(
			screen.queryByRole("button", { name: "Edit with instructions" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Edit source" }),
		).toBeInTheDocument();
	});

	it("Edit source opens the source view, and a save that still does not draw returns to the failure view", async () => {
		const user = userEvent.setup();
		const { editor } = renderPage(doc(BROKEN_BODY));

		await user.click(
			await screen.findByRole("button", { name: "Edit source" }),
		);
		const code = await screen.findByRole("textbox", {
			name: "Mermaid diagram code",
		});
		await waitFor(() => expect(code).toHaveFocus());

		const stillBroken = [...BROKEN_BODY, '  a --> b["Launch"]'].join("\n");
		fireEvent.focus(code);
		fireEvent.change(code, { target: { value: stillBroken } });
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
		expect(
			screen.queryByRole("textbox", { name: "Mermaid diagram code" }),
		).not.toBeInTheDocument();
		expect(diagramTexts(editor())).toEqual([stillBroken]);
	});

	it("a save that draws shows the diagram", async () => {
		const user = userEvent.setup();
		const { container } = renderPage(doc(BROKEN_BODY));

		await user.click(
			await screen.findByRole("button", { name: "Edit source" }),
		);
		const code = await screen.findByRole("textbox", {
			name: "Mermaid diagram code",
		});
		const fixed = [
			MARKER,
			`%% caption: ${CAPTION}`,
			"flowchart LR",
			'  a["Discovery"] --> b["Launch"]',
		].join("\n");
		fireEvent.focus(code);
		fireEvent.change(code, { target: { value: fixed } });
		fireEvent.keyDown(code, { key: "Enter", ctrlKey: true });

		await waitFor(() =>
			expect(
				container.querySelector(".mermaid-diagram-area svg"),
			).not.toBeNull(),
		);
		expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
		expect(container.querySelector(".pa-figure-counted")).not.toBeNull();
	});

	it("returns from the source view to the failure view without saving", async () => {
		const user = userEvent.setup();
		renderPage(doc(BROKEN_BODY));

		await user.click(
			await screen.findByRole("button", { name: "Edit source" }),
		);
		await screen.findByRole("textbox", { name: "Mermaid diagram code" });
		await user.click(
			screen.getByRole("button", {
				name: "Return to the rendered diagram. Any unsaved edits to the source are discarded.",
			}),
		);

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
	});

	it("Delete removes the diagram", async () => {
		const user = userEvent.setup();
		const { editor } = renderPage(doc(BROKEN_BODY));

		await user.click(await screen.findByRole("button", { name: "Delete" }));

		await waitFor(() => expect(diagramTexts(editor())).toEqual([]));
		expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
	});

	it("Edit with instructions opens its panel in the failure view", async () => {
		const user = userEvent.setup();
		renderPage(doc(BROKEN_BODY));

		await user.click(
			await screen.findByRole("button", {
				name: "Edit with instructions",
			}),
		);
		expect(
			await screen.findByRole("textbox", {
				name: "What should change in this diagram?",
			}),
		).toBeInTheDocument();
		expect(screen.getByText(TITLE)).toBeInTheDocument();
	});

	it("reads in German", async () => {
		intl.locale = "de";
		renderPage(doc(BROKEN_BODY));

		expect(
			await screen.findByText(
				"Dieses Diagramm kann nicht dargestellt werden",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText("Es wird bei PDF- und Word-Exporten weggelassen."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Quelltext bearbeiten" }),
		).toBeInTheDocument();
	});
});

describe("the failure view of a kind only the live page draws", () => {
	const BROKEN_GANTT = [`%% caption: ${CAPTION}`, ...GANTT_BODY, "  BROKEN"];

	it("says the exports print a numbered placeholder, and takes a number", async () => {
		const { container } = renderPage(doc(BROKEN_GANTT));

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
		expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
		expect(screen.queryByText(EXPORTS)).not.toBeInTheDocument();
		const view = container.querySelector("[data-diagram-failure]");
		expect(view?.classList.contains("pa-figure-counted")).toBe(true);
		expect(view?.querySelector(".pa-figure-caption")?.textContent).toBe(
			CAPTION,
		);
	});

	it("keeps an empty caption line for the number when it has no caption", async () => {
		const { container } = renderPage(doc([...GANTT_BODY, "  BROKEN"]), {
			editable: false,
		});

		await screen.findByText(TITLE);
		const caption = container.querySelector(
			"[data-diagram-failure] .pa-figure-caption",
		);
		expect(caption?.textContent).toBe("");
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("reads in German", async () => {
		intl.locale = "de";
		renderPage(doc(BROKEN_GANTT));

		expect(
			await screen.findByText(
				"PDF- und Word-Exporte zeigen an seiner Stelle einen nummerierten Platzhalter.",
			),
		).toBeInTheDocument();
	});
});

describe("the failure view, for a reader", () => {
	it("shows the message and the caption, without actions or source", async () => {
		const { container } = renderPage(doc(BROKEN_BODY), { editable: false });

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
		expect(screen.getByText(EXPORTS)).toBeInTheDocument();
		expect(screen.getByText(CAPTION)).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(container.querySelector("textarea, pre")).toBeNull();
		const view = container.querySelector("[data-diagram-failure]");
		expect(view?.textContent).not.toContain("Parse error");
		expect(view?.textContent).not.toContain("BROKEN");
	});
});

describe("outside a Proposal", () => {
	it("keeps the generic source view with the engine's message", async () => {
		renderPage(doc(BROKEN_BODY), { visual: false });

		expect(
			await screen.findByText("Parse error on line 2"),
		).toBeInTheDocument();
		expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
	});
});

describe("a kind only the live page draws", () => {
	it("draws a gantt diagram with a note to editors that it is not included in the PDF", async () => {
		const { container } = renderPage(doc(GANTT_BODY));

		await waitFor(() =>
			expect(
				container.querySelector(".mermaid-diagram-area svg"),
			).not.toBeNull(),
		);
		expect(await screen.findByText(NOT_PRINTABLE)).toBeInTheDocument();
		// Print keeps a captioned placeholder for it, so it takes a number.
		expect(container.querySelector(".pa-figure-counted")).not.toBeNull();
	});

	it("shows a reader no note", async () => {
		const { container } = renderPage(doc(GANTT_BODY), { editable: false });

		await waitFor(() =>
			expect(
				container.querySelector(".mermaid-diagram-area svg"),
			).not.toBeNull(),
		);
		expect(screen.queryByText(NOT_PRINTABLE)).not.toBeInTheDocument();
	});

	it.each([
		["a flowchart", FLOWCHART_BODY],
		["a sequence diagram", ["sequenceDiagram", "  A->>B: Hello"]],
		// The export reads the fence without its caption line.
		[
			"a captioned sequence diagram",
			["%% caption: Handshake", "sequenceDiagram", "  A->>B: Hello"],
		],
	])("shows no note for %s, which prints", async (_name, body) => {
		const { container } = renderPage(doc(body));

		await waitFor(() =>
			expect(
				container.querySelector(".mermaid-diagram-area svg"),
			).not.toBeNull(),
		);
		await act(async () => {});
		expect(screen.queryByText(NOT_PRINTABLE)).not.toBeInTheDocument();
	});

	it("notes a flowchart only mermaid.js could draw, which the exports leave out, and takes no number", async () => {
		const { container } = renderPage(
			doc([
				MARKER,
				"flowchart LR",
				`  t0["${ENGINE_THROWS}"] --> t1["Launch"]`,
			]),
		);

		await waitFor(() =>
			expect(
				container.querySelector(".mermaid-diagram-area svg"),
			).not.toBeNull(),
		);
		expect(await screen.findByText(NOT_PRINTABLE)).toBeInTheDocument();
		expect(container.querySelector(".pa-figure-counted")).toBeNull();
	});

	it.each([
		["pie", ["pie title Budget", '  "Build" : 60', '  "Run" : 40']],
		["mindmap", ["mindmap", "  root((Plan))", "    Build"]],
		["timeline", ["timeline", "  title Plan", "  2026 : Build"]],
		["a flowchart without a direction", ["graph", "  a --> b"]],
		[
			"frontmatter",
			["---", "title: Flow", "---", "flowchart LR", "  a --> b"],
		],
	])("notes that %s is not included in the PDF", async (_name, body) => {
		const { container } = renderPage(doc(body));

		await waitFor(() =>
			expect(
				container.querySelector(".mermaid-diagram-area svg"),
			).not.toBeNull(),
		);
		expect(await screen.findByText(NOT_PRINTABLE)).toBeInTheDocument();
	});
});

describe("figure numbers, as the exports number them", () => {
	const paint = resolveThemePaint(
		buildProposalThemeTokens({
			organization: null,
			style: { primaryColor: "#1f3a6b", accentColors: [] },
			brandKit: null,
			recipient: null,
		}),
	);

	it("numbers drawn figures and print placeholders alike, and skips what the exports leave out", async () => {
		// The fences of the export's parity test
		// (`render-diagrams.parity.test.ts`), which expects the same numbers,
		// but for the flowchart only mermaid.js draws, which is checked on
		// its own above.
		const bodies = [
			[
				"%% figure: process",
				"flowchart LR",
				'  s0["Discovery<br/>Agree on goals and success measures"]',
				'  s1["Pilot<br/>Configure the agreed scope"]',
				"  s0 --> s1",
			],
			["flowchart TD", "  a[Discovery] --> b[Launch]"],
			["Discovery, then Build, then Launch."],
			["flowchrt TD", "  a --> b"],
			GANTT_BODY,
			[...GANTT_BODY, "  BROKEN"],
			["sequenceDiagram", "  A->>B: Hello"],
		];
		const { container } = renderPage(doc(...bodies), { paint });

		await waitFor(() => {
			expect(
				container.querySelectorAll(".mermaid-diagram-area svg"),
			).toHaveLength(4);
			expect(
				container.querySelectorAll("[data-diagram-failure]"),
			).toHaveLength(3);
		});
		await act(async () => {});

		let next = 0;
		const numbers = [
			...container.querySelectorAll(".mermaid-container"),
		].map((figure) =>
			figure.classList.contains("pa-figure-counted") ? ++next : null,
		);
		expect(numbers).toEqual([1, 2, null, null, 3, 4, 5]);
		// A template drew the first.
		expect(
			container.querySelector('.mermaid-diagram-area svg[role="img"]'),
		).not.toBeNull();
	});
});
