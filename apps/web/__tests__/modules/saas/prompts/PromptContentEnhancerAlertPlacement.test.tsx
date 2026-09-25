/**
 * Fizzy #2250: the enhancer's editor area does not scroll, and a long body
 * pushes everything after the textarea out of view. The inline reason Save is
 * disabled rendered below the textarea, so on staging it sat below the fold at
 * every viewport — present in the DOM, invisible to the user. It now renders
 * ABOVE the textarea; this pins that order.
 */

import { PromptContentEnhancer } from "@saas/prompts/components/PromptContentEnhancer";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({ state: {}, setState: vi.fn(), nodeName: undefined }),
	useCopilotAction: vi.fn(),
	useCopilotChat: () => ({ isLoading: false }),
	useCopilotReadable: vi.fn(),
}));

vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: ({ children }: { children?: React.ReactNode }) => (
		<>{children}</>
	),
}));

vi.mock("@saas/shared/components/copilot/CopilotAssistantMessage", () => ({
	CopilotAssistantMessageForPromptEnhancer: () => null,
}));

vi.mock("@saas/shared/components/FabricLogo", () => ({
	FabricLogo: () => null,
}));

describe("PromptContentEnhancer inline reason placement", () => {
	it("renders the reason before the textarea, where it stays on screen", () => {
		render(
			<PromptContentEnhancer
				promptId="p1"
				promptName="Meeting summary"
				format="PLAIN_TEXT"
				tags={[]}
				initialContent="Summarise the meeting notes."
				onSave={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);
		const textarea = screen.getByPlaceholderText(/prompt here/);

		fireEvent.change(textarea, { target: { value: "" } });

		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("Prompt content cannot be empty");
		expect(
			alert.compareDocumentPosition(textarea) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(textarea).toHaveAttribute("aria-describedby", alert.id);
	});
});
