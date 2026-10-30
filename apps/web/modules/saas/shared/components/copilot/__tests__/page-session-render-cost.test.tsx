import { act, render } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vitest";

const source = vi.hoisted(() => ({
	session: { isLoading: false, messages: [] as unknown[] },
	listeners: new Set<() => void>(),
}));
vi.mock("@copilotkit/react-core", () => ({
	useCopilotChatInternal: () =>
		useSyncExternalStore(
			(fn) => {
				source.listeners.add(fn);
				return () => {
					source.listeners.delete(fn);
				};
			},
			() => source.session,
		),
}));

import {
	equalDocumentAssistantMessages,
	selectDocumentAssistantMessages,
} from "@saas/projects/components/copilot/document-assistant-message-projection";
import * as sessionHooks from "../CopilotChatSessionProvider";

const useLoading = () =>
	sessionHooks.useCopilotChatSessionSelector((s) => s.isLoading);
describe("page session subscription render cost", () => {
	for (const page of ["StoryWorkspace", "DocumentEditorInner"]) {
		it(`session loading selector used by ${page} ignores unread changes`, () => {
			let renders = 0;
			function PageSubscription() {
				renders++;
				return <span>{String(useLoading())}</span>;
			}
			const view = render(
				<sessionHooks.CopilotChatSessionProvider>
					<PageSubscription />
				</sessionHooks.CopilotChatSessionProvider>,
			);
			const before = renders;
			for (let i = 0; i < 8; i++) {
				act(() => {
					source.session = { ...source.session, messages: [i] };
					for (const fn of source.listeners) {
						fn();
					}
				});
			}
			expect(renders).toBe(before);
			act(() => {
				source.session = {
					...source.session,
					isLoading: !source.session.isLoading,
				};
				for (const fn of source.listeners) {
					fn();
				}
			});
			expect(renders).toBe(before + 1);
			view.unmount();
		});
	}
});

it("observes in-place message appends without rendering for unchanged wire messages", () => {
	source.session = { isLoading: false, messages: [] };
	let renders = 0;
	function MatcherSubscription() {
		renders++;
		const messages = sessionHooks.useCopilotChatSessionSelector(
			selectDocumentAssistantMessages,
			equalDocumentAssistantMessages,
		);
		const json = messages.map((message) => message.id).join(",");
		return <span data-testid="wire">{json}</span>;
	}
	const view = render(
		<sessionHooks.CopilotChatSessionProvider>
			<MatcherSubscription />
		</sessionHooks.CopilotChatSessionProvider>,
	);
	const before = renders;
	act(() => {
		source.session = { ...source.session };
		for (const fn of source.listeners) {
			fn();
		}
	});
	expect(renders).toBe(before);
	act(() => {
		source.session.messages.push({
			id: "example-message",
			role: "user",
			content: "hello",
		});
		source.session = { ...source.session };
		for (const fn of source.listeners) {
			fn();
		}
	});
	expect(renders).toBe(before + 1);
	expect(view.getByTestId("wire")).toHaveTextContent("example-message");
	view.unmount();
});

it("editor message projection ignores content and argument chunks but observes new tool calls", () => {
	const message = {
		id: "assistant",
		role: "assistant",
		content: "first",
		toolCalls: [] as {
			id: string;
			function: { name: string; arguments: string };
		}[],
	};
	source.session = { isLoading: false, messages: [message] };
	let renders = 0;
	function EditorMessageSubscription() {
		renders++;
		const messages = sessionHooks.useCopilotChatSessionSelector(
			selectDocumentAssistantMessages,
			equalDocumentAssistantMessages,
		);
		return <span>{messages[0].toolCalls.length}</span>;
	}
	const view = render(
		<sessionHooks.CopilotChatSessionProvider>
			<EditorMessageSubscription />
		</sessionHooks.CopilotChatSessionProvider>,
	);
	const publish = () =>
		act(() => {
			source.session = { ...source.session };
			for (const fn of source.listeners) {
				fn();
			}
		});
	const before = renders;
	message.content += " streaming chunk";
	publish();
	expect(renders).toBe(before);
	message.toolCalls.push({
		id: "call",
		function: { name: "confirm_changes", arguments: "" },
	});
	publish();
	expect(renders).toBe(before + 1);
	message.toolCalls[0].function.arguments += "large document chunk";
	publish();
	expect(renders).toBe(before + 1);
	view.unmount();
});

it("projects legacy action identities and human classifiers without reading tool argument bodies", () => {
	const legacy = {
		id: "legacy",
		name: "confirm_changes",
		parentMessageId: "parent",
		actionExecutionId: "answered",
		isActionExecutionMessage: () => true,
	};
	const human = {
		id: "human",
		_getType: () => "human",
		get content() {
			throw new Error("user text is not needed for identity");
		},
	};
	const assistant = {
		id: "assistant",
		role: "assistant",
		content: "text",
		toolCalls: [
			{
				id: "call",
				function: {
					name: "write_document_local",
					get arguments() {
						throw new Error("tool arguments must not be read");
					},
				},
			},
		],
	};
	const messages = selectDocumentAssistantMessages({
		messages: [legacy, human, assistant],
	} as never);
	expect(messages[0].isActionExecutionMessage?.()).toBe(true);
	expect(messages[0]).toMatchObject({
		parentMessageId: "parent",
		actionExecutionId: "answered",
	});
	expect(messages[1]).toMatchObject({ id: "human", type: "human" });
	expect(messages[2]).toMatchObject({
		content: "present",
		toolCalls: [{ id: "call", function: { name: "write_document_local" } }],
	});
});
