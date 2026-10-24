/**
 * Live role colours on a client-document Proposal's page (Fizzy #2946): a
 * generated flowchart names roles (`class <id> surface`), and the page draws
 * them in the theme's paint by appending the role class definitions before
 * rendering. A Style change repaints the diagram without its source, and so
 * Main, changing. Without a paint (every other page) the source is drawn as
 * written; a non-flowchart never gets the definitions.
 *
 * The real renderer draws; its input is recorded.
 */

import {
	buildProposalThemeTokens,
	type ProposalThemePaint,
	resolveThemePaint,
	visualRoleClassDefs,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DiagramHarness,
	FLOWCHART_BODY,
	fence,
	GANTT_BODY,
	MARKER,
	newQueryClient,
} from "./tiptap-mermaid-visual-harness";

const renderer = vi.hoisted(() => ({
	beautiful: [] as string[],
	native: [] as string[],
}));

vi.mock("beautiful-mermaid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("beautiful-mermaid")>();
	return {
		...actual,
		renderMermaidSVG: (
			code: string,
			options: Parameters<typeof actual.renderMermaidSVG>[1],
		) => {
			renderer.beautiful.push(code);
			return actual.renderMermaidSVG(code, options);
		},
	};
});

vi.mock("mermaid", () => ({
	default: {
		initialize: () => {},
		mermaidAPI: { getSiteConfig: () => ({}) },
		render: async (_id: string, code: string) => {
			renderer.native.push(code);
			return {
				svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 200 100"><text>Gantt</text></svg>',
			};
		},
	},
}));

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

function paintFor(primaryColor: string): ProposalThemePaint {
	return resolveThemePaint(
		buildProposalThemeTokens({
			organization: null,
			style: { primaryColor, accentColors: [] },
			brandKit: null,
			recipient: null,
		}),
	);
}

const NAVY = paintFor("#1f3a8a");
const GREEN = paintFor("#166534");
const FLOWCHART = fence(FLOWCHART_BODY);
const DOCUMENT = `## Delivery\n\nWe start with discovery.\n\n${FLOWCHART}\n`;

/** The node fill a drawn diagram's `surface` node wears. */
function surfaceFill(container: HTMLElement): string | null {
	const svg = container.querySelector(".mermaid-diagram-area svg");
	const rect = svg?.querySelector(
		"g.node rect, rect[fill]:not([fill='none'])",
	);
	return rect?.getAttribute("fill") ?? null;
}

beforeEach(() => {
	renderer.beautiful = [];
	renderer.native = [];
});

describe("live role colours", () => {
	it("appends the theme's role class definitions to a flowchart, marker kept first", async () => {
		const { container } = render(
			<DiagramHarness markdown={DOCUMENT} visual={{ paint: NAVY }} />,
		);
		await waitFor(() =>
			expect(
				container.querySelector(".mermaid-diagram-area svg"),
			).not.toBeNull(),
		);

		const drawn = renderer.beautiful.at(-1) ?? "";
		expect(drawn.split("\n")[0]).toBe(MARKER);
		for (const line of visualRoleClassDefs(NAVY)) {
			expect(drawn).toContain(line);
		}
		expect(surfaceFill(container)).toBe(NAVY.tint);
	});

	it("repaints on a paint change, leaving the saved Markdown byte-identical", async () => {
		let editor: Editor | null = null;
		const queryClient = newQueryClient();
		const onEditor = (created: Editor) => {
			editor = created;
		};
		const { container, rerender } = render(
			<DiagramHarness
				markdown={DOCUMENT}
				visual={{ paint: NAVY }}
				onEditor={onEditor}
				queryClient={queryClient}
			/>,
		);
		await waitFor(() => expect(surfaceFill(container)).toBe(NAVY.tint));
		const before = getEditorMarkdownForSave(editor as unknown as Editor);

		rerender(
			<DiagramHarness
				markdown={DOCUMENT}
				visual={{ paint: GREEN }}
				onEditor={onEditor}
				queryClient={queryClient}
			/>,
		);

		await waitFor(() => expect(surfaceFill(container)).toBe(GREEN.tint));
		expect(NAVY.tint).not.toBe(GREEN.tint);
		expect(renderer.beautiful.at(-1)).toContain(
			visualRoleClassDefs(GREEN)[0],
		);
		expect(getEditorMarkdownForSave(editor as unknown as Editor)).toBe(
			before,
		);
	});

	it("draws the source as written without a paint", async () => {
		const { container } = render(
			<DiagramHarness markdown={DOCUMENT} visual={{ paint: null }} />,
		);
		await waitFor(() =>
			expect(
				container.querySelector(".mermaid-diagram-area svg"),
			).not.toBeNull(),
		);
		expect(renderer.beautiful.at(-1)).toBe(FLOWCHART_BODY.join("\n"));
		expect(renderer.beautiful.at(-1)).not.toContain("classDef");
	});

	it("draws the source as written on any other page (no diagrams context)", async () => {
		const { container } = render(
			<DiagramHarness markdown={DOCUMENT} themeRoot={false} />,
		);
		await waitFor(() =>
			expect(
				container.querySelector(".mermaid-diagram-area svg"),
			).not.toBeNull(),
		);
		expect(renderer.beautiful.at(-1)).not.toContain("classDef");
	});

	it("never appends the definitions to a gantt diagram", async () => {
		const { container } = render(
			<DiagramHarness
				markdown={`## Plan\n\n${fence(GANTT_BODY)}\n`}
				visual={{ paint: NAVY }}
			/>,
		);
		await waitFor(() => expect(renderer.native.length).toBeGreaterThan(0));
		await waitFor(() =>
			expect(
				container.querySelector(".mermaid-diagram-area svg"),
			).not.toBeNull(),
		);
		expect(renderer.native.at(-1)).not.toContain("classDef");
		expect(
			renderer.beautiful.every((code) => !code.includes("classDef")),
		).toBe(true);
	});

	it("keeps a diagram's own literal colours", async () => {
		const baked = fence([
			"flowchart LR",
			'  a["Discovery"] --> b["Launch"]',
			"  style a fill:#e7e8eb",
		]);
		const { container } = render(
			<DiagramHarness
				markdown={`## Flow\n\n${baked}\n`}
				visual={{ paint: NAVY }}
			/>,
		);
		await waitFor(() =>
			expect(
				container.querySelector(".mermaid-diagram-area svg"),
			).not.toBeNull(),
		);
		expect(
			container.querySelector(".mermaid-diagram-area svg")?.innerHTML,
		).toContain("#e7e8eb");
	});
});
