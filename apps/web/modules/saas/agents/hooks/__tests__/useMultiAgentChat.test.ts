/**
 * The live multi-agent turn belongs to one thread: once the chat moves off
 * that thread (the open conversation deleted, a new chat, another
 * conversation), the turn is no longer followed or shown.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const turns = vi.hoisted(
	() =>
		[] as Array<{
			threadId: string;
			attach: ReturnType<typeof vi.fn>;
			dispose: ReturnType<typeof vi.fn>;
		}>,
);

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock("@saas/payments/lib/ai-usage-limit-toast", () => ({
	isAiUsageLimitExceededPayload: () => false,
	useShowAiUsageLimitToast: () => vi.fn(),
}));

vi.mock("../useRuntimeEligible", () => ({
	useRuntimeEligible: () => true,
}));

vi.mock("../../lib/multi-agent-runtime-turn", () => ({
	MultiAgentRuntimeTurn: class {
		readonly attach = vi.fn(async () => undefined);
		readonly dispose = vi.fn();
		constructor(readonly threadId: string) {
			turns.push(this);
		}
	},
}));

import type { MultiAgentTurnRecord } from "../../lib/multi-agent-runtime-protocol";
import { useMultiAgentChat } from "../useMultiAgentChat";

const runningRecord: MultiAgentTurnRecord = {
	version: 1,
	final: false,
	agents: [
		{
			index: 0,
			agentId: "agent-a",
			name: "Agent A",
			memberKey: "ma_example-key",
			executionId: "exec-1",
			turnId: "turn-1",
			status: "running",
		},
		{
			index: 1,
			agentId: "agent-b",
			name: "Agent B",
			memberKey: "ma_example-key_a1",
			executionId: "exec-2",
			turnId: "turn-2",
			status: "running",
		},
	],
};

const latest = {
	id: "exec-1",
	userMessage: "Example question",
	multiAgent: runningRecord,
};

function render(initialConversationId: string | null) {
	return renderHook(
		({ conversationId }: { conversationId: string | null }) =>
			useMultiAgentChat({
				offered: true,
				organizationId: "org-1",
				conversationId,
				latest: conversationId === "conv-1" ? latest : undefined,
				first: null,
				setFirst: vi.fn(),
				persist: vi.fn(),
				onConversationStarted: vi.fn(),
			}),
		{ initialProps: { conversationId: initialConversationId } },
	);
}

beforeEach(() => {
	turns.length = 0;
});

describe("useMultiAgentChat: the live turn follows its thread", () => {
	it("follows a running turn of the open conversation", () => {
		const { result } = render("conv-1");

		expect(turns).toHaveLength(1);
		expect(turns[0]?.threadId).toBe("conv-1");
		expect(turns[0]?.attach).toHaveBeenCalledTimes(1);
		expect(result.current.liveView([])?.question).toBe("Example question");
	});

	it("stops following and clears the turn when the open conversation is deleted", () => {
		const { result, rerender } = render("conv-1");

		rerender({ conversationId: null });

		expect(turns[0]?.dispose).toHaveBeenCalledTimes(1);
		expect(result.current.liveView([])).toBeNull();
		expect(result.current.isRunning).toBe(false);
	});

	it("clears the turn when another conversation opens", () => {
		const { result, rerender } = render("conv-1");

		rerender({ conversationId: "conv-2" });

		expect(turns[0]?.dispose).toHaveBeenCalledTimes(1);
		expect(result.current.liveView([])).toBeNull();
	});

	it("follows the turn again when its conversation is reopened", () => {
		const { rerender } = render("conv-1");

		rerender({ conversationId: null });
		rerender({ conversationId: "conv-1" });

		expect(turns).toHaveLength(2);
		expect(turns[1]?.threadId).toBe("conv-1");
		expect(turns[1]?.attach).toHaveBeenCalledTimes(1);
	});
});
