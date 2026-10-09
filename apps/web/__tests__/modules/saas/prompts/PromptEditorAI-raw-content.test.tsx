/**
 * The prompt editor opens in its raw view, where the textarea is the
 * content. The hidden rich editor, when it holds text of its own, re-applies
 * it on a format change, and those updates used to replace the content to
 * save: the raw edits were lost and the older body was saved while the
 * textarea still showed the new one.
 *
 * TipTap and the Radix select are real; only CopilotKit and the toolbar are
 * stubbed.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@copilotkit/react-core", () => ({
	CopilotKit: ({ children }: { children: ReactNode }) => <>{children}</>,
	useCopilotChat: () => ({ isLoading: false }),
	useCopilotReadable: () => undefined,
	useCopilotAction: () => undefined,
}));
vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: () => null,
}));
vi.mock("@copilotkit/react-ui/styles.css", () => ({}));
vi.mock("@saas/shared/components/copilot/CopilotChatSessionProvider", () => ({
	CopilotChatSessionProvider: ({ children }: { children: ReactNode }) => (
		<>{children}</>
	),
}));
vi.mock("@saas/shared/components/copilot/use-copilot-error-handler", () => ({
	useCopilotErrorHandler: () => () => undefined,
}));
vi.mock("@saas/shared/components/copilot/CopilotAssistantMessage", () => ({
	CopilotAssistantMessageForPromptEnhancer: () => null,
}));
vi.mock("@saas/projects/components/EditorToolbar", () => ({
	EditorToolbar: () => null,
}));

import { PromptEditorAI } from "@saas/prompts/components/PromptEditorAI";

const BODY =
	"You are a careful reviewer.\n\nCheck every claim against the sources.";

function renderEditor(initialContent?: string) {
	const onSave = vi.fn();
	render(
		<PromptEditorAI
			onSave={onSave}
			onCancel={() => undefined}
			organizationId="org-1"
			initialData={
				initialContent === undefined
					? undefined
					: {
							name: "Reviewer",
							scope: "ORG",
							format: "PLAIN_TEXT",
							tags: [],
							isPublic: false,
							content: initialContent,
						}
			}
		/>,
	);
	return onSave;
}

describe("PromptEditorAI — raw view content", () => {
	it("saves the raw edits, not the rich editor's older text, after the format changes", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor("An older body.");

		const textarea = screen.getByPlaceholderText(
			"Enter your plain text prompt here...",
		);
		await user.clear(textarea);
		await user.click(textarea);
		await user.paste(BODY);
		await user.click(screen.getByRole("combobox", { name: /format/i }));
		await user.click(
			await screen.findByRole("option", { name: "Markdown" }),
		);

		// The textarea still shows the edit.
		expect(
			screen.getByPlaceholderText("Enter your markdown prompt here..."),
		).toHaveValue(BODY);

		await user.click(screen.getByRole("button", { name: /save prompt/i }));

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({ content: BODY, format: "MARKDOWN" }),
		);
	});

	it("saves text pasted into a new prompt", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor();

		await user.type(
			screen.getByPlaceholderText("Enter prompt name"),
			"Reviewer",
		);
		await user.click(
			screen.getByPlaceholderText("Enter your plain text prompt here..."),
		);
		await user.paste(BODY);
		await user.click(screen.getByRole("button", { name: /save prompt/i }));

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Reviewer", content: BODY }),
		);
	});

	it("still saves no content for an empty prompt", async () => {
		const user = userEvent.setup();
		const onSave = renderEditor();

		await user.type(
			screen.getByPlaceholderText("Enter prompt name"),
			"Draft",
		);
		await user.click(screen.getByRole("button", { name: /save prompt/i }));

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Draft", content: undefined }),
		);
	});
});
