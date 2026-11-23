/**
 * "Update using context" takes the editor read-only while it runs and gives
 * it back at the end. A member who cannot edit the story (a project viewer)
 * starts no update, and no ending of one makes their editor editable.
 */

import { act, renderHook } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateWithContextMock } = vi.hoisted(() => ({
	updateWithContextMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { stories: { updateWithContext: updateWithContextMock } },
	},
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { useUpdateWithContext } from "../useUpdateWithContext";

function fakeEditor() {
	const editor = {
		setEditable: vi.fn(),
		commands: { setContent: vi.fn() },
	};
	return { editor, asEditor: editor as unknown as Editor };
}

function renderUpdate(editor: Editor, canEdit: boolean) {
	return renderHook(() =>
		useUpdateWithContext({
			projectId: "proj-1",
			storyId: "story-1",
			organizationId: "org-1",
			editor,
			canEdit,
			parseContent: (markdown) => ({
				description: markdown,
				acceptanceCriteria: "",
			}),
			getEditorMarkdownForSave: () => "Body",
			fromMarkdown: (markdown) => markdown,
			diffPartialText: (_baseline, next) => next,
			onSaved: vi.fn(),
		}),
	);
}

beforeEach(() => {
	updateWithContextMock.mockReset();
});

describe("useUpdateWithContext for a member who cannot edit", () => {
	it("starts no update and leaves the editor alone", async () => {
		const { editor, asEditor } = fakeEditor();
		const { result } = renderUpdate(asEditor, false);

		await act(async () => {
			await result.current.start();
		});

		expect(updateWithContextMock).not.toHaveBeenCalled();
		expect(editor.setEditable).not.toHaveBeenCalled();
		expect(result.current.isActive).toBe(false);
	});

	it.each([
		{ canEdit: true, editable: true },
		{ canEdit: false, editable: false },
	])(
		"leaves the editor editable=$editable after a reject when canEdit=$canEdit",
		({ canEdit, editable }) => {
			const { editor, asEditor } = fakeEditor();
			const { result } = renderUpdate(asEditor, canEdit);

			act(() => {
				result.current.reject();
			});

			expect(editor.setEditable).toHaveBeenLastCalledWith(editable);
		},
	);
});

describe("useUpdateWithContext for a member who can edit", () => {
	it("gives the editor back after a failed request", async () => {
		updateWithContextMock.mockRejectedValue(new Error("Network error"));
		const { editor, asEditor } = fakeEditor();
		const { result } = renderUpdate(asEditor, true);

		await act(async () => {
			await result.current.start();
		});

		expect(updateWithContextMock).toHaveBeenCalledTimes(1);
		expect(editor.setEditable.mock.calls).toEqual([[false], [true]]);
	});
});
