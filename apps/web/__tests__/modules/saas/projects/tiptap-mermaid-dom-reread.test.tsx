/**
 * A diagram's source survives ProseMirror reading the editor's DOM back
 * (Fizzy #2946). A modal overlay (a menu, a dialog) hides the rest of the
 * page from screen readers but keeps every live region readable, so a live
 * region inside the editor made it mark the editor's blocks `aria-hidden`.
 * ProseMirror reads those attribute changes as an edit and parses the range
 * around the diagrams again, which turned each diagram's line breaks into
 * spaces, and the autosave then kept the damage.
 *
 * The editor is the document editor's own extension set with the real node
 * view, Radix menu and renderer; only the translations (the real message
 * files) and the oRPC client are stubbed.
 */

import {
	buildProposalThemeTokens,
	resolveThemePaint,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/core";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { describe, expect, it, vi } from "vitest";
import { DiagramHarness, fence } from "./tiptap-mermaid-visual-harness";

vi.mock("next-intl", async () => {
	const actual =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	const en = (await import("@repo/i18n/translations/en.json")).default;
	return {
		useTranslations: (namespace: string) =>
			actual.createTranslator({
				locale: "en",
				messages: en as never,
				namespace: namespace as never,
				onError: () => {},
			}),
		useLocale: () => "en",
	};
});

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				listVisualSpecs: vi.fn(async () => ({ specs: [] })),
				// Never answers: the panel stays on its progress announcement.
				editVisual: vi.fn(() => new Promise(() => {})),
			},
		},
	},
}));

const FIRST = [
	"flowchart LR",
	't0["Discovery"]',
	"style t0 fill:#e7e8eb,stroke:#334155",
	't1["Pilot"]',
	"t0 --> t1",
];
const SECOND = ["flowchart LR", 't0["Discover"]', 't1["Decide"]', "t0 --> t1"];
const DOCUMENT = [
	"## 1. Executive Summary",
	"",
	"Intro.",
	"",
	fence(FIRST),
	"",
	"## 2. Plan",
	"",
	"Then.",
	"",
	fence(SECOND),
	"",
	"## 3. Next",
	"",
	"End.",
	"",
].join("\n");
const SOURCES = [FIRST.join("\n"), SECOND.join("\n")];

const paint = resolveThemePaint(
	buildProposalThemeTokens({
		organization: null,
		style: { primaryColor: "#1f3a6b", accentColors: [] },
		brandKit: null,
		recipient: null,
	}),
);

async function renderEditor(withMenu: boolean) {
	let editor: Editor | null = null;
	const utils = render(
		<>
			{withMenu && (
				<DropdownMenu>
					<DropdownMenuTrigger>Download</DropdownMenuTrigger>
					<DropdownMenuContent>
						<DropdownMenuItem>PDF</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
			<DiagramHarness
				markdown={DOCUMENT}
				visual={{ isMember: true, paint }}
				onEditor={(created) => {
					editor = created;
				}}
			/>
		</>,
	);
	await waitFor(() =>
		expect(
			utils.container.querySelectorAll(".mermaid-diagram-area svg"),
		).toHaveLength(2),
	);
	const sources = () => {
		const found: string[] = [];
		(editor as unknown as Editor).state.doc.descendants((node) => {
			if (node.type.name === "mermaidBlock") {
				found.push(node.textContent.trimEnd());
			}
		});
		return found;
	};
	const proseMirror = () => {
		const element = utils.container.querySelector(".ProseMirror");
		if (!element) {
			throw new Error("no editor DOM");
		}
		return element;
	};
	return { ...utils, sources, proseMirror };
}

/** Lets ProseMirror's mutation observer flush what it saw. */
const settle = () =>
	act(() => new Promise((resolve) => setTimeout(resolve, 50)));

async function openMenu() {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "Download" }));
	await screen.findByRole("menu");
	await settle();
}

describe("a diagram read back from the editor's DOM", () => {
	it("keeps its source's line breaks", async () => {
		const { container, sources } = await renderEditor(false);
		const text = container.querySelector(
			".node-mermaidBlock [data-node-view-content-react]",
		)?.firstChild as Text;

		// The same text written back: ProseMirror's observer reads the node.
		await act(async () => {
			text.nodeValue = `${text.nodeValue}`;
		});
		await settle();

		expect(sources()).toEqual(SOURCES);
	});
});

describe("opening a modal menu beside the Proposal's editor", () => {
	it("leaves its diagrams as they were", async () => {
		const { sources } = await renderEditor(true);

		await openMenu();

		expect(sources()).toEqual(SOURCES);
	});

	it("hides the editor from screen readers without writing into its DOM", async () => {
		const { container, proseMirror } = await renderEditor(true);
		const written: string[] = [];
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				written.push(record.attributeName ?? "");
			}
		});
		observer.observe(proseMirror(), {
			subtree: true,
			attributes: true,
			attributeFilter: ["aria-hidden", "data-aria-hidden"],
		});

		await openMenu();
		for (const record of observer.takeRecords()) {
			written.push(record.attributeName ?? "");
		}
		observer.disconnect();

		// The overlay did hide the page around the editor.
		expect(container.querySelector("[data-aria-hidden]")).not.toBeNull();
		expect(written).toEqual([]);
	});
});

describe("the diagrams' live region", () => {
	it("is one region outside the editor's DOM, and still says Edit with instructions' progress", async () => {
		const { container, proseMirror } = await renderEditor(false);
		const user = userEvent.setup();

		expect(proseMirror().querySelectorAll("[aria-live]")).toHaveLength(0);
		const regions = container.querySelectorAll(
			"output[aria-live='polite']",
		);
		expect(regions).toHaveLength(1);

		const trigger = screen.getAllByRole("button", {
			name: "Diagram actions",
		})[0];
		act(() => trigger.focus());
		await user.keyboard("{Enter}");
		await user.click(
			await screen.findByRole("menuitem", {
				name: "Edit with instructions",
			}),
		);
		await user.type(
			await screen.findByRole("textbox", {
				name: "What should change in this diagram?",
			}),
			"Lay it out top to bottom",
		);
		await user.click(screen.getByRole("button", { name: "Generate" }));

		await waitFor(() =>
			expect(regions[0]?.textContent).toBe(
				"Generating a proposed diagram…",
			),
		);
	});
});
