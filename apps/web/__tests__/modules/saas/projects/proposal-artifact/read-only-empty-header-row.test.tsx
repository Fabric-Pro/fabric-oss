/**
 * A Proposal table whose header cells are all empty (Fizzy #2946).
 *
 * GFM requires a header row, so a table written without one arrives with an
 * empty header row. Print leaves that row out; on the Proposal theme's paper
 * the read-only views hide it too: the live preview's document and the saved
 * body shown outside the room. An editable editor keeps it, where its cells
 * can be filled in, and a header with text in any cell keeps it everywhere.
 *
 * The editors are the real Tiptap ones with the editor's extensions, and the
 * stylesheet is the real live theme, injected by `ProposalThemeStyle`; jsdom
 * cascades its rules into `getComputedStyle`.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

import { PROPOSAL_THEME_ROOT_SELECTORS } from "@repo/utils/proposal-artifact/proposal-theme";
import {
	buildProposalThemeTokens,
	resolveThemePaint,
	themeCustomProperties,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { ProposalLiveSections } from "@saas/projects/components/proposal-artifact/ProposalLiveSections";
import { RoomSavedBody } from "@saas/projects/components/proposal-artifact/RoomSavedBody";
import {
	type ProposalThemeRootProps,
	ProposalThemeStyle,
} from "@saas/projects/components/proposal-artifact/use-proposal-theme";
import { fromMarkdown } from "@saas/projects/lib/diff-utils";
import { createAdvancedExtensions } from "@saas/projects/lib/tiptap-extensions-advanced";
import { EditorContent, useEditor } from "@tiptap/react";
import type { CSSProperties } from "react";

/** What the page hands a themed view: the neutral paint. */
const THEME_ROOT_PROPS: ProposalThemeRootProps = {
	className: "proposal-theme",
	"data-proposal-theme": "live",
	style: themeCustomProperties(
		resolveThemePaint(
			buildProposalThemeTokens({
				organization: null,
				style: null,
				brandKit: null,
				recipient: null,
			}),
		),
	) as CSSProperties,
};

const LIVE_ROOT = PROPOSAL_THEME_ROOT_SELECTORS.live;

/**
 * Three tables: one written without a header (an empty header row), one
 * with a header, and one whose header leaves only its corner cell empty.
 */
const TABLES = [
	"## Plan",
	"",
	"| | |",
	"|---|---|",
	"| Discovery | Two weeks |",
	"| Delivery | Six weeks |",
	"| Support | Three months |",
	"",
	"## Phases",
	"",
	"| Phase | Length |",
	"|---|---|",
	"| Kickoff | One day |",
	"",
	"## Options",
	"",
	"| | Option A |",
	"|---|---|",
	"| Price | Fixed |",
].join("\n");

/** The editor's tables under `container`, once they have rendered. */
async function renderedTables(
	container: HTMLElement,
): Promise<HTMLTableElement[]> {
	await waitFor(() => {
		expect(container.querySelectorAll("table")).toHaveLength(3);
	});
	return [...container.querySelectorAll<HTMLTableElement>("table")];
}

function rows(table: HTMLTableElement): HTMLTableRowElement[] {
	return [...table.querySelectorAll<HTMLTableRowElement>("tbody > tr")];
}

function display(element: Element): string {
	return window.getComputedStyle(element).display;
}

/**
 * An empty header row as the editor draws it, in `tbody`: every cell a `th`
 * whose one paragraph holds only the editor's placeholder line break.
 */
function expectEmptyHeaderRow(row: HTMLTableRowElement): void {
	expect(row.cells.length).toBeGreaterThan(0);
	for (const cell of row.cells) {
		expect(cell.tagName).toBe("TH");
		expect(cell.innerHTML).toBe(
			'<p><br class="ProseMirror-trailingBreak"></p>',
		);
	}
}

/** A read-only editor's tables: the empty header row hidden, the rest kept. */
function expectHiddenOnlyWhereEmpty(tables: HTMLTableElement[]): void {
	const [written, headed, corner] = tables as [
		HTMLTableElement,
		HTMLTableElement,
		HTMLTableElement,
	];
	const [header, first, second, third] = rows(written) as [
		HTMLTableRowElement,
		HTMLTableRowElement,
		HTMLTableRowElement,
		HTMLTableRowElement,
	];
	expectEmptyHeaderRow(header);
	expect(display(header)).toBe("none");
	for (const row of [first, second, third]) {
		expect(display(row)).not.toBe("none");
	}
	// The hidden row still counts toward the zebra, which tints odd rows of
	// `tbody`: the first data row stays plain, as under a header.
	const zebra = `${LIVE_ROOT} tbody > tr:nth-child(odd) > td`;
	expect(first.cells[0]?.matches(zebra)).toBe(false);
	expect(second.cells[0]?.matches(zebra)).toBe(true);
	expect(third.cells[0]?.matches(zebra)).toBe(false);

	// A header with text in any cell keeps its row.
	for (const table of [headed, corner]) {
		const [row] = rows(table);
		expect(row?.cells[0]?.tagName).toBe("TH");
		expect(display(row as HTMLTableRowElement)).not.toBe("none");
	}
	expect(rows(corner)[0]?.cells[0]?.innerHTML).toBe(
		'<p><br class="ProseMirror-trailingBreak"></p>',
	);
}

/** The document editor's extensions, built once as the read-only views do. */
const EXTENSIONS = createAdvancedExtensions({
	projectId: null,
	documentId: null,
	statTiles: true,
});

function EditableBody({ markdown }: { markdown: string }) {
	const editor = useEditor({
		extensions: EXTENSIONS,
		content: fromMarkdown(markdown),
		editable: true,
		immediatelyRender: false,
	});
	return <EditorContent editor={editor} />;
}

describe("a table header row with nothing in it, on the theme's paper", () => {
	it("is hidden in the live preview's read-only document", async () => {
		const { container } = render(
			<ProposalLiveSections
				liveContent={TABLES}
				savedContent={null}
				status="GENERATING"
				progress={40}
				title="Example proposal"
				generationStartedAt={new Date()}
				updatedAt={new Date()}
				themeRootProps={THEME_ROOT_PROPS}
			/>,
		);
		await screen.findByRole("heading", { level: 2, name: "Plan" });

		const root = container.querySelector<HTMLElement>(LIVE_ROOT);
		expect(root?.querySelector(".tiptap")).toHaveAttribute(
			"contenteditable",
			"false",
		);
		expectHiddenOnlyWhereEmpty(await renderedTables(root as HTMLElement));
	});

	it("is hidden in the saved body shown outside the room", async () => {
		const { container } = render(
			<div {...THEME_ROOT_PROPS}>
				<ProposalThemeStyle />
				<RoomSavedBody markdown={TABLES} statTiles />
			</div>,
		);

		const tables = await renderedTables(container);
		expect(container.querySelector(".tiptap")).toHaveAttribute(
			"contenteditable",
			"false",
		);
		expectHiddenOnlyWhereEmpty(tables);
	});

	it("stays in an editable editor, where its cells can be filled in", async () => {
		const { container } = render(
			<div {...THEME_ROOT_PROPS}>
				<ProposalThemeStyle />
				<EditableBody markdown={TABLES} />
			</div>,
		);

		const [written] = await renderedTables(container);
		expect(container.querySelector(".tiptap")).toHaveAttribute(
			"contenteditable",
			"true",
		);
		const [header] = rows(written as HTMLTableElement) as [
			HTMLTableRowElement,
		];
		expectEmptyHeaderRow(header);
		expect(display(header)).not.toBe("none");
	});
});
