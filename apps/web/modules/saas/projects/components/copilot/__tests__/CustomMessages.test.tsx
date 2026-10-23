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

import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const liveMessages: unknown[] = [];
/** The persisted conversation, as `HydratedMessagesProvider` hands it. */
let hydrated: {
	historicalMessages: unknown[];
	historicalIdSet: Set<string>;
} | null = null;

vi.mock("@copilotkit/react-core", () => ({
	useCopilotChatInternal: () => ({ messages: liveMessages, interrupt: null }),
}));
vi.mock("@copilotkit/react-ui", () => ({
	useChatContext: () => ({ labels: {}, icons: {} }),
}));
vi.mock("../HydratedMessagesContext", () => ({
	useHydratedMessages: () => hydrated,
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

/**
 * A row keeps its identity when a message enters the history ahead of it
 * (Fizzy #2946): an accept's operation result, or its persisted reply, moved
 * the live tool call's row, React mounted it again, and the confirm card of
 * a tool call answered long before said once more that a proposal was under
 * review.
 */
describe("CustomMessages — a row's identity", () => {
	afterEach(() => {
		hydrated = null;
		liveMessages.length = 0;
	});

	it("does not mount a live tool call's card again when the history grows ahead of it, and still marks the last row current", () => {
		let mounts = 0;
		let unmounts = 0;
		function Card() {
			useEffect(() => {
				mounts += 1;
				return () => {
					unmounts += 1;
				};
			}, []);
			return <span data-testid="card" />;
		}
		const current = new Map<string, boolean>();
		// As CopilotKit's own `RenderMessage` (react-ui dist/index.mjs): the
		// message it renders is keyed by the `index` it is handed, and an
		// assistant message renders its `generativeUI` inside it.
		function RenderMessage({
			message,
			index,
			isCurrentMessage,
			AssistantMessage,
		}: Record<string, any>) {
			current.set(message.id, isCurrentMessage);
			if (message.role !== "assistant") {
				return <div key={index}>{message.content}</div>;
			}
			return (
				<AssistantMessage
					key={index}
					message={message}
					subComponent={message.generativeUI?.()}
				/>
			);
		}
		function AssistantMessage({
			message,
			subComponent,
		}: Record<string, any>) {
			return (
				<div>
					{message.content}
					<div>{subComponent}</div>
				</div>
			);
		}
		const user = { id: "u1", role: "user", content: "Add a sentence." };
		const text = { id: "a1", role: "assistant", content: "Proposed." };
		// The tool calls' own row, which is never persisted under its id: its
		// calls are persisted on the text message before it.
		const toolCalls = {
			id: "a1-tools",
			role: "assistant",
			content: "",
			toolCalls: [{ id: "tc1", function: { name: "confirm_changes" } }],
			generativeUI: () => <Card />,
		};
		const reply = {
			id: "a2",
			role: "assistant",
			content: "Changes accepted.",
		};
		liveMessages.push(user, text, toolCalls, reply);
		const props = {
			inProgress: false,
			RenderMessage,
			AssistantMessage,
			UserMessage: () => null,
		} as any;
		const view = render(<CustomMessages {...props} />);
		expect(mounts).toBe(1);

		// The turn is persisted, then the accept's operation result enters
		// the history ahead of the live rows, then a saved accept's, which
		// renders nothing but has its place too.
		const persisted = [
			{ id: "u1", role: "user", content: "Add a sentence." },
			{ id: "a1", role: "assistant", content: "Proposed." },
		];
		const failure = {
			id: "s1",
			role: "system",
			content:
				"The accepted changes could not be saved; they are still in the editor.",
			metadata: { kind: "operation_result", outcome: "failure" },
		};
		const success = {
			id: "s2",
			role: "system",
			content: "Changes applied.",
			metadata: { kind: "operation_result", outcome: "success" },
		};
		for (const history of [
			persisted,
			[...persisted, failure],
			[...persisted, failure, success],
		]) {
			hydrated = {
				historicalMessages: history,
				historicalIdSet: new Set(history.map((message) => message.id)),
			};
			view.rerender(<CustomMessages {...props} />);
		}

		expect(mounts).toBe(1);
		expect(unmounts).toBe(0);
		expect(screen.getAllByTestId("card")).toHaveLength(1);
		expect(current.get("a2")).toBe(true);
		expect(current.get("a1-tools")).toBe(false);
		view.unmount();
	});
});
