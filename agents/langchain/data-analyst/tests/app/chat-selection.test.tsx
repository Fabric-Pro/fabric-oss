// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TypedUIMessage } from "@/lib/types";

/**
 * Regression guard for chat selection under `@ai-sdk/react` 4.
 *
 * Version 4 binds `setMessages` to one specific `Chat` instance: it closes
 * over `chat`, which is `useMemo(..., [chatKey])` keyed on `id`
 * (`dist/index.js:352-356`, `417-424`). Version 3 wrote through a mutable
 * `chatRef` (`dist/index.js:244-251`, `313-320`), so a `setMessages` captured
 * before an id change still reached the live chat.
 *
 * `handleSelectChat` changes the session id, awaits the history fetch, and
 * only then applies it. Under the pre-migration code it applied the history
 * through the `setMessages` captured in the click handler, which after the id
 * change belonged to the discarded `Chat` — the fetched history went into an
 * instance nothing renders and the selected conversation stayed empty.
 *
 * `useChat` is deliberately NOT mocked here: the binding it performs is the
 * behaviour under test. Only the data sources and the presentational children
 * are stubbed.
 */

const HISTORY: TypedUIMessage[] = [
	{
		id: "msg-1",
		role: "user",
		parts: [{ type: "text", text: "what is in this dataset" }],
	},
	{
		id: "msg-2",
		role: "assistant",
		parts: [{ type: "text", text: "loaded history reply" }],
	},
];

const selectChat = vi.fn(async () => HISTORY);

vi.mock("@/hooks/use-chat-history", () => ({
	useChatHistory: () => ({
		chats: [
			{
				id: "chat-1",
				userId: "u1",
				title: "Saved conversation",
				model: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		],
		isLoadingChats: false,
		createChat: vi.fn(),
		selectChat,
		deleteChat: vi.fn(),
		saveMessages: vi.fn(async () => undefined),
	}),
}));

vi.mock("@/hooks/use-local-storage", () => ({
	useLocalStorage: (_key: string, initial: unknown) => {
		// Mirrors the real hook's shape without touching storage.
		const ref = { current: initial };
		return [ref.current, vi.fn()];
	},
}));

vi.mock("@/hooks/use-streaming-chat", () => ({
	useStreamingChat: () => ({
		messages: [],
		sendMessage: vi.fn(),
		status: "idle",
		error: null,
		setMessages: vi.fn(),
	}),
}));

// Presentational children reduced to the one affordance the test drives and
// the one signal it asserts on.
vi.mock("@/components/chat/chat-sidebar", () => ({
	ChatSidebar: ({
		onSelectChat,
	}: {
		onSelectChat: (chatId: string) => void;
	}) => (
		<button
			type="button"
			data-testid="select-chat"
			onClick={() => onSelectChat("chat-1")}
		>
			select
		</button>
	),
}));

vi.mock("@/components/chat/chat-message", () => ({
	ChatMessage: ({ message }: { message: { id: string } }) => (
		<div data-testid="chat-message">{message.id}</div>
	),
}));

vi.mock("@/components/chat/chat-input", () => ({
	ChatInput: () => <div data-testid="chat-input" />,
}));

vi.mock("@/components/ui/loader", () => ({
	Loader: () => <div data-testid="loader" />,
}));

describe("chat selection loads history into the active chat session", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		selectChat.mockClear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	it("renders the fetched history after the session id changes", async () => {
		const { default: Chat } = await import("@/app/page");

		await act(async () => {
			root.render(<Chat />);
		});

		expect(
			container.querySelectorAll("[data-testid=chat-message]"),
		).toHaveLength(0);

		await act(async () => {
			container
				.querySelector<HTMLButtonElement>("[data-testid=select-chat]")
				?.click();
		});

		expect(selectChat).toHaveBeenCalledWith("chat-1");

		// The assertion that fails on the pre-fix code: the history has to
		// reach the `Chat` instance the new session id selects, so `useChat`
		// publishes it and the messages render.
		const rendered = Array.from(
			container.querySelectorAll("[data-testid=chat-message]"),
		).map((node) => node.textContent);

		expect(rendered).toEqual(["msg-1", "msg-2"]);
	});
});
