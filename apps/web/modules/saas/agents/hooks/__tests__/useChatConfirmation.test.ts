import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { useChatConfirmation } from "../useChatConfirmation";

const ASKS = {
	requiresConfirmation: true,
	toolName: "fabric_publish_workflow",
	args: { workflowId: "wf-1" },
	draft: {
		kind: "workflow-action",
		workflowId: "wf-1",
		workflowName: "Nightly digest",
	},
};

const asking = (id: string) => ({
	id,
	toolCalls: [{ result: { workflows: [] } }, { result: ASKS }],
});

const messages = [
	{ role: "user" as const, content: "publish it", id: "u1" },
	{ role: "assistant" as const, content: "Ready.", id: "a1" },
];

const sendMessage = vi.fn(async (..._args: unknown[]) => null);

function mount() {
	return renderHook(() => useChatConfirmation({ messages, sendMessage }));
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("useChatConfirmation", () => {
	it("offers the approval a finished message's tool call asked for, tied to that message", () => {
		const { result } = mount();

		act(() => result.current.offer(asking("a1")));

		expect(result.current.pending).toMatchObject({
			messageId: "a1",
			toolName: "fabric_publish_workflow",
			args: { workflowId: "wf-1" },
		});
	});

	it("offers nothing for a message whose tools asked for nothing", () => {
		const { result } = mount();

		act(() =>
			result.current.offer({
				id: "a1",
				toolCalls: [{ result: { workflows: [] } }, {}],
			}),
		);
		act(() => result.current.offer({ id: "a2" }));

		expect(result.current.pending).toBeNull();
	});

	it("approving sends the call the card showed, once, through the conversation, and clears the card", async () => {
		const { result } = mount();
		act(() => result.current.offer(asking("a1")));

		await act(async () => {
			await result.current.approve();
		});

		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage).toHaveBeenCalledWith(
			"Approved: publish workflow “Nightly digest”.",
			[
				{ role: "user", content: "publish it" },
				{ role: "assistant", content: "Ready." },
			],
			{
				approvedToolCall: {
					toolName: "fabric_publish_workflow",
					args: { workflowId: "wf-1" },
				},
			},
		);
		expect(result.current.pending).toBeNull();
	});

	it("does not draw a card the person already answered when the same transcript renders again", async () => {
		const { result } = mount();
		act(() => result.current.offer(asking("a1")));
		await act(async () => {
			await result.current.approve();
		});

		act(() => result.current.offer(asking("a1")));

		expect(result.current.pending).toBeNull();
	});

	it("declining sends nothing, says so, and takes the card away for good", () => {
		const { result } = mount();
		act(() => result.current.offer(asking("a1")));

		act(() => result.current.decline());
		act(() => result.current.offer(asking("a1")));

		expect(sendMessage).not.toHaveBeenCalled();
		expect(toast.info).toHaveBeenCalledWith(
			"Cancelled. Nothing was changed.",
		);
		expect(result.current.pending).toBeNull();
	});

	it("does nothing when there is nothing to answer", async () => {
		const { result } = mount();

		await act(async () => {
			await result.current.approve();
		});
		act(() => result.current.decline());

		expect(sendMessage).not.toHaveBeenCalled();
		expect(toast.info).not.toHaveBeenCalled();
	});
});
