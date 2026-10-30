/**
 * The live chat's outcome chips, from `DocumentAssistantOutcomesProvider`
 * (Fizzy #2946).
 *
 * An old thread kept `confirm_changes` cards from earlier days that nobody
 * answered: with no stamp they read "Pending" forever, though the editor had
 * no review to answer them with. Pinned here, through the provider and the
 * chip as the assistant bubble renders them:
 *   - an unstamped proposal reads "Pending" only while the chat waits on its
 *     call (its confirm card is live), and "No decision recorded" otherwise;
 *   - a stamped proposal keeps its stamp;
 *   - a tool that is not a proposal gets no chip.
 */

import { CopilotKitContext } from "@copilotkit/react-core/v2/context";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const conversation = vi.hoisted(() => ({
	messages: [] as unknown[],
}));
vi.mock("@saas/projects/hooks/useDocumentAssistantHistory", () => ({
	useActiveDocumentAssistantConversation: () => ({
		data: { conversation: { messages: conversation.messages } },
	}),
}));

import { DiffOutcomeChip } from "../../modules/saas/projects/components/copilot/DiffOutcomeChip";
import {
	DocumentAssistantOutcomesProvider,
	useDocumentAssistantOutcomes,
} from "../../modules/saas/projects/components/copilot/DocumentAssistantOutcomesProvider";

/** The chips of one assistant message, as the assistant bubble lists them. */
function Chips({ messageId }: { messageId: string }) {
	const entries =
		useDocumentAssistantOutcomes()?.getOutcomesForMessageId(messageId) ??
		[];
	return (
		<ul>
			{entries.map((entry) => (
				<li key={entry.id} data-testid={`chip-${entry.id}`}>
					{entry.name} <DiffOutcomeChip toolCall={entry} />
				</li>
			))}
		</ul>
	);
}

function renderChips(messageId: string, executing: string[] = []) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<CopilotKitContext.Provider
			value={{ executingToolCallIds: new Set(executing) } as never}
		>
			<DocumentAssistantOutcomesProvider
				documentRefKind="PROJECT_DOCUMENT"
				documentRefId="doc-1"
				projectId="proj-1"
				organizationId="org-1"
			>
				{children}
			</DocumentAssistantOutcomesProvider>
		</CopilotKitContext.Provider>
	);
	return render(<Chips messageId={messageId} />, { wrapper });
}

describe("DocumentAssistantOutcomesProvider chips (Fizzy #2946)", () => {
	it("reads an old unanswered confirm_changes card as not awaiting a decision, and a live one as Pending", () => {
		conversation.messages = [
			{
				id: "msg-old",
				role: "assistant",
				toolCalls: [{ id: "call-old", name: "confirm_changes" }],
			},
			{
				id: "msg-live",
				role: "assistant",
				toolCalls: [{ id: "call-live", name: "confirm_changes" }],
			},
		];

		const old = renderChips("msg-old", ["call-live"]);
		expect(screen.getByTestId("chip-call-old")).toHaveTextContent(
			"No decision recorded",
		);
		expect(screen.queryByText("Pending")).not.toBeInTheDocument();
		old.unmount();

		renderChips("msg-live", ["call-live"]);
		expect(screen.getByTestId("chip-call-live")).toHaveTextContent(
			"Pending",
		);
	});

	it("keeps a stamped proposal's outcome", () => {
		conversation.messages = [
			{
				id: "msg-1",
				role: "assistant",
				toolCalls: [
					{
						id: "call-1",
						name: "confirm_changes",
						acceptedAt: "2026-10-20T10:00:00Z",
					},
				],
			},
		];

		renderChips("msg-1");

		expect(screen.getByTestId("chip-call-1")).toHaveTextContent(/Accepted/);
	});

	it("gives no chip to a tool that is not a proposal", () => {
		conversation.messages = [
			{
				id: "msg-1",
				role: "assistant",
				toolCalls: [
					{ id: "call-search", name: "search_project_knowledge" },
					{ id: "call-write", name: "write_document_local" },
				],
			},
		];

		renderChips("msg-1");

		expect(
			screen.queryByTestId("chip-call-search"),
		).not.toBeInTheDocument();
		expect(screen.getByTestId("chip-call-write")).toHaveTextContent(
			"No decision recorded",
		);
	});
});
