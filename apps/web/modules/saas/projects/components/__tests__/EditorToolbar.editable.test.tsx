/**
 * The editor toolbar follows the editor's editability (Fizzy #2946).
 *
 * TipTap commands write an editor whether or not it takes input, so while
 * the document editor holds its editor still — a run writes the document,
 * another tab reviews an assistant proposal, the client may not edit — the
 * toolbar's controls change nothing: every control is disabled, including
 * those inside a popover opened before, and an image read meanwhile goes in
 * only once the editor takes input again.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import { StarterKit } from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tiptap/react", () => ({
	NodeViewWrapper: () => null,
	ReactNodeViewRenderer: () => () => null,
}));

const { EditorToolbar } = await import("../EditorToolbar");

let editors: Editor[] = [];
afterEach(() => {
	for (const editor of editors) {
		editor.destroy();
	}
	editors = [];
});

function makeEditor(content = "<p>Phase one, then two.</p>") {
	const editor = new Editor({ extensions: [StarterKit, Image], content });
	editors.push(editor);
	return editor;
}

function imageCount(editor: Editor): number {
	let count = 0;
	editor.state.doc.descendants((node) => {
		if (node.type.name === "image") {
			count += 1;
		}
	});
	return count;
}

describe("EditorToolbar while its editor takes no input (Fizzy #2946)", () => {
	it("disables its controls, and enables them again once the editor takes input", async () => {
		const user = userEvent.setup();
		const editor = makeEditor();
		editor.commands.setTextSelection({ from: 1, to: 6 });
		render(<EditorToolbar editor={editor} />);
		const bold = screen.getByRole("button", { name: "bold" });
		const table = screen.getByRole("button", { name: "insertTable" });
		expect(bold).not.toBeDisabled();
		expect(table).not.toBeDisabled();

		act(() => {
			editor.setEditable(false);
		});
		expect(bold).toBeDisabled();
		expect(table).toBeDisabled();
		expect(screen.getByRole("button", { name: "heading1" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "image" })).toBeDisabled();
		await user.click(bold);
		await user.click(table);
		expect(editor.getHTML()).toBe("<p>Phase one, then two.</p>");

		act(() => {
			editor.setEditable(true);
		});
		expect(bold).not.toBeDisabled();
		await user.click(bold);
		expect(editor.getHTML()).toContain("<strong>");
	});

	it("disables a popover opened before, and an image read meanwhile goes in once the editor takes input", async () => {
		const user = userEvent.setup();
		const editor = makeEditor();
		render(<EditorToolbar editor={editor} />);
		await user.click(screen.getByRole("button", { name: "image" }));
		const browse = await screen.findByRole("button", {
			name: "Browse files",
		});
		expect(browse).not.toBeDisabled();

		act(() => {
			editor.setEditable(false);
		});
		expect(browse).toBeDisabled();
		const input = document.querySelector<HTMLInputElement>(
			'input[type="file"]',
		) as HTMLInputElement;
		const file = new File([new Uint8Array([137, 80, 78, 71])], "flow.png", {
			type: "image/png",
		});
		await act(async () => {
			fireEvent.change(input, { target: { files: [file] } });
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(imageCount(editor)).toBe(0);

		await act(async () => {
			editor.setEditable(true);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(imageCount(editor)).toBe(1);
	});
});
