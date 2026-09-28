/**
 * Visual-slot controls in the editor chrome (Fizzy #2589, R37, R40, AE10).
 *
 * Covers:
 *   - `EditorToolbar` offers the insert control only when `visualSlots` is
 *     set — it is shared by several editors and defaults off.
 *   - `VisualSlotControlsGate` turns it on only for a Glossy-eligible type
 *     with the rollout gate on, and records the same answer for the slash
 *     command.
 *   - The chip a placed slot shows as: its accessible name, the section an
 *     orphan came from, and editing kind and hint through its popover, with
 *     the edit surviving the markdown round trip.
 *
 * next-intl is mocked globally to echo keys; this file resolves the real
 * English copy instead so accessible names are asserted as users hear them.
 *
 * What the axe scans do NOT prove: colour contrast. axe's `color-contrast`
 * rule bails out under jsdom (no `HTMLCanvasElement#getContext`, hence the
 * logged "Not implemented" noise); the chip uses theme tokens only.
 */

import {
	FEATURE_FLAG_REGISTRY,
	type FeatureFlagKey,
} from "@repo/utils/feature-flag-registry";
import { serializeVisualSlot } from "@repo/utils/glossy/visual-slots";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor } from "@tiptap/core";
import type { ReactNodeViewProps } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

vi.mock("next-intl", async () => {
	const { default: en } = await import("@repo/i18n/translations/en.json");
	const lookup = (path: string): unknown =>
		path
			.split(".")
			.reduce<unknown>(
				(node, key) =>
					node && typeof node === "object"
						? (node as Record<string, unknown>)[key]
						: undefined,
				en,
			);
	return {
		useTranslations: (namespace: string) => {
			const t = (key: string, values?: Record<string, unknown>) => {
				const message = lookup(`${namespace}.${key}`);
				if (typeof message !== "string") {
					return key;
				}
				return message.replace(/\{(\w+)\}/g, (_, name: string) =>
					String(values?.[name] ?? `{${name}}`),
				);
			};
			t.raw = (key: string) => lookup(`${namespace}.${key}`);
			return t;
		},
		useLocale: () => "en",
	};
});

// The node view is rendered directly below; inside the editor it would need
// a mounted `EditorContent`.
vi.mock("@tiptap/react", () => ({
	NodeViewWrapper: ({
		children,
		...props
	}: { children?: ReactNode } & Record<string, unknown>) => (
		<div data-node-view-wrapper="" {...props}>
			{children}
		</div>
	),
	ReactNodeViewRenderer: () => () => null,
}));

const { EditorToolbar } = await import("../EditorToolbar");
const { filterSlashCommands } = await import("../SlashCommands");
const { VisualSlot, VisualSlotControlsGate, VisualSlotNodeView } = await import(
	"../../lib/tiptap-visual-slot-extension"
);
const { getEditorMarkdownForSave } = await import(
	"../../lib/editor-markdown-save"
);

const INSERT_CONTROL =
	"Insert a visual slot: ask the Glossy edition for a visual at this spot, of a kind you choose or the best fit.";

let editors: Editor[] = [];
afterEach(() => {
	for (const editor of editors) {
		editor.destroy();
	}
	editors = [];
});

function makeEditor(content: string) {
	const editor = new Editor({
		extensions: [StarterKit, VisualSlot],
		content,
	});
	editors.push(editor);
	return editor;
}

function flags(overrides: Partial<Record<FeatureFlagKey, boolean>>) {
	const values = Object.fromEntries(
		Object.keys(FEATURE_FLAG_REGISTRY).map((key) => [key, false]),
	) as Record<FeatureFlagKey, boolean>;
	return { ...values, ...overrides };
}

function renderGatedToolbar(
	editor: Editor,
	{ gate, documentType }: { gate: boolean; documentType: string },
) {
	return render(
		<FeatureFlagProvider value={flags({ GLOSSY_EDITION: gate })}>
			<VisualSlotControlsGate editor={editor} documentType={documentType}>
				{(visualSlots) => (
					<EditorToolbar editor={editor} visualSlots={visualSlots} />
				)}
			</VisualSlotControlsGate>
		</FeatureFlagProvider>,
	);
}

function topLevelTypes(editor: Editor): string[] {
	const types: string[] = [];
	editor.state.doc.forEach((node) => {
		types.push(node.type.name);
	});
	return types;
}

function slotAttrs(editor: Editor) {
	const found: Array<Record<string, unknown>> = [];
	editor.state.doc.descendants((node) => {
		if (node.type.name === "visualSlot") {
			found.push(node.attrs);
		}
	});
	return found;
}

function slashTitles(editor: Editor): string[] {
	return filterSlashCommands("", editor).map((item) => item.title);
}

describe("EditorToolbar — visualSlots prop", () => {
	it("offers no insert control by default, and slots already in the document still load and save", () => {
		const slot = serializeVisualSlot({
			id: "slot-a",
			kind: "timeline",
			hint: "Show the phases",
		});
		const editor = makeEditor(`<p>Intro</p>${slot}`);

		render(<EditorToolbar editor={editor} />);

		expect(
			screen.queryByRole("button", { name: INSERT_CONTROL }),
		).toBeNull();
		expect(getEditorMarkdownForSave(editor)).toBe(`Intro\n\n${slot}`);
	});

	it("inserts the chosen kind and hint after the current top-level block", async () => {
		const user = userEvent.setup();
		const editor = makeEditor(
			"<h2>Timeline</h2><p>We start in Q1.</p><p>Then Q2.</p>",
		);
		editor.commands.setTextSelection(3);

		render(<EditorToolbar editor={editor} visualSlots />);
		await user.click(screen.getByRole("button", { name: INSERT_CONTROL }));
		await user.click(
			await screen.findByRole("radio", { name: /^Timeline/ }),
		);
		await user.type(
			screen.getByLabelText("Hint (optional)"),
			"Quarterly phases",
		);
		await user.click(screen.getByRole("button", { name: "Insert" }));

		expect(topLevelTypes(editor)).toEqual([
			"heading",
			"visualSlot",
			"paragraph",
			"paragraph",
		]);
		expect(slotAttrs(editor)).toEqual([
			expect.objectContaining({
				kind: "timeline",
				hint: "Quarterly phases",
				orphanedFrom: null,
			}),
		]);
	});
});

describe("VisualSlotControlsGate (R40, AE10)", () => {
	it("offers no insert control on a PRD, even with the gate on", () => {
		const editor = makeEditor("<p>Body</p>");

		renderGatedToolbar(editor, { gate: true, documentType: "PRD" });

		expect(
			screen.queryByRole("button", { name: INSERT_CONTROL }),
		).toBeNull();
		expect(slashTitles(editor)).not.toContain("Visual slot");
	});

	it("offers no insert control on a Business Case with the gate off, and keeps its slots (AE10)", () => {
		const slot = serializeVisualSlot({ id: "slot-a", kind: "stat" });
		const editor = makeEditor(`<p>Body</p>${slot}`);

		renderGatedToolbar(editor, {
			gate: false,
			documentType: "BUSINESS_CASE",
		});

		expect(
			screen.queryByRole("button", { name: INSERT_CONTROL }),
		).toBeNull();
		expect(slashTitles(editor)).not.toContain("Visual slot");
		expect(getEditorMarkdownForSave(editor)).toBe(`Body\n\n${slot}`);
	});

	it("offers the control and the slash command on a Business Case with the gate on", async () => {
		const user = userEvent.setup();
		const editor = makeEditor("<p>First</p><p>Second</p>");
		editor.commands.setTextSelection(2);

		const { unmount } = renderGatedToolbar(editor, {
			gate: true,
			documentType: "BUSINESS_CASE",
		});
		expect(slashTitles(editor)).toContain("Visual slot");

		await user.click(screen.getByRole("button", { name: INSERT_CONTROL }));
		await user.click(await screen.findByRole("button", { name: "Insert" }));

		expect(topLevelTypes(editor)).toEqual([
			"paragraph",
			"visualSlot",
			"paragraph",
		]);
		expect(slotAttrs(editor)[0]).toMatchObject({ kind: null, hint: null });

		// Leaving the chrome (raw view) withdraws the slash command too.
		unmount();
		expect(slashTitles(editor)).not.toContain("Visual slot");
	});

	it("offers the control on a Proposal with the gate on", () => {
		const editor = makeEditor("<p>Body</p>");

		renderGatedToolbar(editor, { gate: true, documentType: "PROPOSAL" });

		expect(
			screen.getByRole("button", { name: INSERT_CONTROL }),
		).toBeTruthy();
	});
});

describe("VisualSlotNodeView — the chip", () => {
	function nodeViewProps(
		editor: Editor,
		overrides: Partial<ReactNodeViewProps> = {},
	): ReactNodeViewProps {
		let position = -1;
		editor.state.doc.descendants((node, pos) => {
			if (position === -1 && node.type.name === "visualSlot") {
				position = pos;
			}
		});
		const node = editor.state.doc.nodeAt(position);
		if (!node) {
			throw new Error("no slot in the document");
		}
		return {
			node,
			editor,
			selected: false,
			getPos: () => position,
			updateAttributes: (attrs: Record<string, unknown>) => {
				editor.commands.command(({ tr }) => {
					tr.setNodeMarkup(position, undefined, {
						...node.attrs,
						...attrs,
					});
					return true;
				});
			},
			deleteNode: () => {
				editor.commands.deleteRange({
					from: position,
					to: position + node.nodeSize,
				});
			},
			...overrides,
		} as unknown as ReactNodeViewProps;
	}

	it('has the accessible name "Visual slot: timeline" and passes axe', async () => {
		const editor = makeEditor(
			serializeVisualSlot({
				id: "slot-a",
				kind: "timeline",
				hint: "Show the phases",
			}),
		);

		const { container } = render(
			<VisualSlotNodeView {...nodeViewProps(editor)} />,
		);

		const chip = screen.getByRole("button", {
			name: "Visual slot: timeline",
		});
		expect(chip.getAttribute("aria-describedby")).toBeTruthy();
		expect(within(chip).getByText("Show the phases")).toBeTruthy();
		expect(await axe(container)).toHaveNoViolations();
	});

	it("names best fit when the slot has no kind", () => {
		const editor = makeEditor(serializeVisualSlot({ id: "slot-b" }));

		render(<VisualSlotNodeView {...nodeViewProps(editor)} />);

		expect(
			screen.getByRole("button", { name: "Visual slot: best fit" }),
		).toBeTruthy();
	});

	it("names the section an orphaned slot came from", () => {
		const editor = makeEditor(
			serializeVisualSlot({
				id: "slot-c",
				kind: "flow",
				orphanedFrom: "Implementation Phases",
			}),
		);

		render(<VisualSlotNodeView {...nodeViewProps(editor)} />);

		expect(
			screen.getByText(
				"Moved here: its section “Implementation Phases” no longer exists",
			),
		).toBeTruthy();
	});

	it("is a named, non-interactive figure in a read-only editor, and passes axe", async () => {
		const editor = makeEditor(
			serializeVisualSlot({ id: "slot-a", kind: "org_chart" }),
		);
		editor.setEditable(false);

		const { container } = render(
			<VisualSlotNodeView {...nodeViewProps(editor)} />,
		);

		expect(screen.queryByRole("button")).toBeNull();
		expect(
			screen.getByRole("figure", { name: "Visual slot: org chart" }),
		).toBeTruthy();
		expect(await axe(container)).toHaveNoViolations();
	});

	it("opens the popover prefilled, and a saved edit survives the markdown round trip", async () => {
		const user = userEvent.setup();
		const editor = makeEditor(
			`<h2>Phases</h2>${serializeVisualSlot({
				id: "slot-a",
				kind: "timeline",
				hint: "Show the phases",
			})}`,
		);

		render(<VisualSlotNodeView {...nodeViewProps(editor)} />);
		await user.click(
			screen.getByRole("button", { name: "Visual slot: timeline" }),
		);

		const timeline = await screen.findByRole("radio", {
			name: /^Timeline/,
		});
		expect(timeline.getAttribute("aria-checked")).toBe("true");
		const hint = screen.getByLabelText("Hint (optional)");
		expect((hint as HTMLInputElement).value).toBe("Show the phases");

		await user.click(screen.getByRole("radio", { name: /^Flow/ }));
		await user.clear(hint);
		await user.type(hint, "Approval steps");
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(getEditorMarkdownForSave(editor)).toBe(
			`## Phases\n\n${serializeVisualSlot({
				id: "slot-a",
				kind: "flow",
				hint: "Approval steps",
			})}`,
		);
	});

	it("keeps a kind it does not offer when only the hint is edited", async () => {
		const user = userEvent.setup();
		const editor = makeEditor(
			serializeVisualSlot({ id: "slot-x", kind: "bar-chart" }),
		);

		render(<VisualSlotNodeView {...nodeViewProps(editor)} />);
		await user.click(
			screen.getByRole("button", { name: "Visual slot: bar-chart" }),
		);
		await user.type(
			await screen.findByLabelText("Hint (optional)"),
			"Revenue",
		);
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(slotAttrs(editor)[0]).toMatchObject({
			kind: "bar-chart",
			hint: "Revenue",
		});
	});

	it("removes the slot from the popover", async () => {
		const user = userEvent.setup();
		const editor = makeEditor(
			`<p>Body</p>${serializeVisualSlot({ id: "slot-a" })}`,
		);

		render(<VisualSlotNodeView {...nodeViewProps(editor)} />);
		await user.click(
			screen.getByRole("button", { name: "Visual slot: best fit" }),
		);
		await user.click(
			await screen.findByRole("button", { name: "Remove slot" }),
		);

		expect(slotAttrs(editor)).toEqual([]);
	});
});
