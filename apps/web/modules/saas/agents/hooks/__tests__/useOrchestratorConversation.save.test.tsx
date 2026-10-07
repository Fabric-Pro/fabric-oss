/**
 * `useOrchestratorConversation().saveExecution` sends one turn (Fizzy #2949).
 *
 * The save used to read the conversation, add its turn and execution to what
 * it read, and write the whole message list and metadata back with `update`.
 * A turn another tab saved between that read and the write was lost. These
 * tests pin that the hook now sends only its own turn, the execution record
 * and the settings to `saveTurn`, and never reads or rewrites the
 * conversation itself.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createExecutionRecord,
	useOrchestratorConversation,
} from "../useOrchestratorConversation";

const conversations = vi.hoisted(() => ({
	list: vi.fn(),
	get: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	saveTurn: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agents: { conversations } },
}));

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			{children}
		</QueryClientProvider>
	);
}

const question = {
	id: "msg_q",
	role: "user" as const,
	content: "What changed this week?",
	timestamp: "2026-10-06T10:00:00.000Z",
};
const answer = {
	id: "msg_a",
	role: "assistant" as const,
	content: "Three pull requests merged.",
	timestamp: "2026-10-06T10:00:05.000Z",
};

beforeEach(() => {
	conversations.list.mockResolvedValue({
		conversations: [],
		total: 0,
		hasMore: false,
	});
	// What a read would return: another tab's turn the save must not drop.
	conversations.get.mockResolvedValue({
		id: "conv_1",
		messages: [{ id: "other", role: "user", content: "Other tab" }],
		metadata: { mode: "orchestrator", executions: [{ id: "exec_other" }] },
	});
	conversations.saveTurn.mockResolvedValue({
		id: "conv_1",
		addedMessages: 2,
		removedMessages: 0,
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("useOrchestratorConversation — saveExecution", () => {
	it("sends only the turn, its execution and the settings, without reading or rewriting the conversation", async () => {
		const { result } = renderHook(
			() =>
				useOrchestratorConversation({
					organizationId: "org_1",
					executionMode: "deep",
					instanceId: "instance_1",
				}),
			{ wrapper },
		);
		const execution = createExecutionRecord(
			"orch-exec-1",
			question.content,
			"deep",
		);

		await act(async () => {
			await result.current.saveExecution({
				conversationId: "conv_1",
				execution,
				messages: [question, answer],
				removeMessageIds: ["msg_seed"],
				selectedMcpConfigIds: ["mcp_1"],
				documentChatId: "doc_chat_1",
			});
		});

		expect(conversations.saveTurn).toHaveBeenCalledTimes(1);
		expect(conversations.saveTurn).toHaveBeenCalledWith({
			conversationId: "conv_1",
			organizationId: "org_1",
			messages: [question, answer],
			execution,
			removeMessageIds: ["msg_seed"],
			settings: {
				executionMode: "deep",
				instanceId: "instance_1",
				selectedMcpConfigIds: ["mcp_1"],
				documentChatId: "doc_chat_1",
			},
		});
		expect(conversations.get).not.toHaveBeenCalled();
		expect(conversations.update).not.toHaveBeenCalled();
	});

	it("passes a cleared tool selection as null and omits an empty removal list", async () => {
		const { result } = renderHook(
			() => useOrchestratorConversation({ organizationId: "org_1" }),
			{ wrapper },
		);

		await act(async () => {
			await result.current.saveExecution({
				conversationId: "conv_1",
				execution: createExecutionRecord(
					"exec-1",
					question.content,
					"balanced",
				),
				messages: [question, answer],
				removeMessageIds: [],
				selectedMcpConfigIds: null,
				documentChatId: null,
			});
		});

		const sent = conversations.saveTurn.mock.calls[0]?.[0];
		expect(sent.removeMessageIds).toBeUndefined();
		expect(sent.settings).toEqual({
			executionMode: "balanced",
			instanceId: undefined,
			selectedMcpConfigIds: null,
			documentChatId: undefined,
		});
	});

	it("no longer offers a whole-metadata execution update", () => {
		const { result } = renderHook(() => useOrchestratorConversation(), {
			wrapper,
		});

		expect("updateExecution" in result.current).toBe(false);
	});
});
