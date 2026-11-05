/**
 * The rendered Markdown diff draws through the editor's diff CSS, which applies
 * only under a `streaming-diff-active` ancestor, and its lists through `prose`.
 * Without those ancestors the marks are in the DOM with nothing visible.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tiptap/react", () => ({
	useEditor: (config: { content?: string; editable?: boolean }) => config,
	EditorContent: ({
		editor,
	}: {
		editor: { content?: string; editable?: boolean };
	}) => (
		<div
			className="tiptap"
			data-testid="diff-content"
			data-content={editor.content ?? ""}
			data-editable={String(editor.editable)}
		/>
	),
}));

vi.mock("../../../lib/tiptap-extensions-advanced", () => ({
	advancedExtensions: [],
}));

vi.mock("../../DocumentEditor.css", () => ({}));

import RenderedMarkdownDiff from "../RenderedMarkdownDiff";

describe("RenderedMarkdownDiff", () => {
	it("sits under the ancestors the editor's diff and list styles need", () => {
		render(
			<RenderedMarkdownDiff
				before={"- old line\n"}
				after={"- old line\n- new line\n"}
				label="Rendered change"
			/>,
		);

		const content = screen.getByTestId("diff-content");
		expect(content.closest(".streaming-diff-active")).not.toBeNull();
		expect(content.closest(".prose")).not.toBeNull();
		expect(
			screen.getByRole("region", { name: "Rendered change" }),
		).toContainElement(content);
	});

	it("marks the addition in a read-only editor", () => {
		render(
			<RenderedMarkdownDiff
				before={"First paragraph.\n"}
				after={"First paragraph.\n\nSecond paragraph.\n"}
				label="Rendered change"
			/>,
		);

		const content = screen.getByTestId("diff-content");
		expect(content.getAttribute("data-editable")).toBe("false");
		expect(content.getAttribute("data-content")).toMatch(
			/<ins[^>]*>[^<]*Second paragraph/,
		);
	});
});
