/**
 * Unit tests for `CustomMessages` — the `<CopilotSidebar Messages={…}>`
 * renderer for the AI assistant thread.
 *
 * Behavior under test: the structured operation-result
 * SYSTEM card ("✓ System / Changes applied.") is intentionally suppressed from
 * the thread — the agent's own conversational confirmation (e.g. "Changes have
 * been applied to the document.") already covers it, so the card read as a
 * duplicate. The agent's assistant messages must still render.
 *
 * Mocking strategy: only the boundaries are mocked — CopilotKit's chat hooks
 * and the hydrated-messages context. The message-routing logic under test (the
 * map() that decides operation-result-card vs RenderMessage) runs for real
 * against a stub RenderMessage that prints each row that reaches it.
 */

import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { render as rtlRender, screen } from "@testing-library/react";

// Every component under test reads its CopilotKit chat state from
// `<CopilotChatSessionProvider>` (one `useCopilotChatInternal()` per surface —
// see the provider's doc-comment and Fizzy #2389), so each render mounts the
// real provider over this file's mocked `useCopilotChatInternal`.
function render(ui: Parameters<typeof rtlRender>[0]) {
	return rtlRender(ui, { wrapper: CopilotChatSessionProvider });
}

import { describe, expect, it, vi } from "vitest";

const liveMessages: unknown[] = [];

vi.mock("@copilotkit/react-core", () => ({
	useCopilotChatInternal: () => ({ messages: liveMessages, interrupt: null }),
}));
vi.mock("@copilotkit/react-ui", () => ({
	useChatContext: () => ({ labels: {}, icons: {} }),
}));
vi.mock("../HydratedMessagesContext", () => ({
	useHydratedMessages: () => null,
}));

import { CustomMessages } from "../CustomMessages";

// Stub RenderMessage: prints the row's content so we can assert which messages
// reached the default render path (i.e. were NOT suppressed/intercepted).
const RenderMessageStub = ({ message }: { message: { content: string } }) => (
	<div data-testid="rendered-message">{message.content}</div>
);

function renderWith(messages: unknown[]) {
	liveMessages.length = 0;
	liveMessages.push(...messages);
	return render(
		// biome-ignore lint/suspicious/noExplicitAny: minimal MessagesProps stub
		<CustomMessages
			{...({
				inProgress: false,
				RenderMessage: RenderMessageStub,
			} as any)}
		/>,
	);
}

const SUCCESS_NO_ARTIFACT = {
	id: "sys1",
	role: "system",
	content: "SYSTEM\n\nChanges applied.",
	metadata: { kind: "operation_result", outcome: "success" },
};

describe("CustomMessages — operation-result SYSTEM card", () => {
	it("suppresses the redundant success card (no artifact)", () => {
		renderWith([SUCCESS_NO_ARTIFACT]);

		expect(
			document.querySelector('[data-message-kind="operation_result"]'),
		).toBeNull();
		// The card's stripped body ("Changes applied.") must not appear anywhere.
		expect(screen.queryByText("Changes applied.")).toBeNull();
	});

	it("still renders the agent's own assistant confirmation", () => {
		renderWith([
			{
				id: "a1",
				role: "assistant",
				content: "Changes have been applied to the document.",
			},
			SUCCESS_NO_ARTIFACT,
		]);

		expect(
			screen.getByText("Changes have been applied to the document."),
		).toBeInTheDocument();
		// The success card stays suppressed even alongside the agent message.
		expect(
			document.querySelector('[data-message-kind="operation_result"]'),
		).toBeNull();
		expect(screen.queryByText("Changes applied.")).toBeNull();
	});

	it("KEEPS the card for a failure outcome (durable status the agent line won't convey)", () => {
		renderWith([
			{
				id: "sysF",
				role: "system",
				content:
					"SYSTEM\n\nThe operation failed. Check the activity log for details.",
				metadata: { kind: "operation_result", outcome: "failure" },
			},
		]);

		expect(
			document.querySelector('[data-message-kind="operation_result"]'),
		).not.toBeNull();
		expect(screen.getByText(/The operation failed\./)).toBeInTheDocument();
	});

	it("KEEPS a success card that carries an artifact link (link lives only in the card)", () => {
		renderWith([
			{
				id: "sysA",
				role: "system",
				content: "SYSTEM\n\nChanges applied.",
				metadata: {
					kind: "operation_result",
					outcome: "success",
					artifact: { label: "View saved version", url: "/v/1" },
				},
			},
		]);

		expect(
			document.querySelector('[data-message-kind="operation_result"]'),
		).not.toBeNull();
		expect(screen.getByText("View saved version")).toBeInTheDocument();
	});
});
