/**
 * `useAssistantThreadId` — the thread rule the document, feature and topic
 * assistants share (`assistant-thread.tsx`):
 *
 *   - a mount with a conversation runs on the conversation's id;
 *   - a mount without one runs on an id minted once for the mount;
 *   - the id never moves on a re-render or a later conversation id (a spill
 *     to a continuation conversation keeps the thread);
 *   - only "New conversation" (`startNewThread()`) mints a fresh id, and
 *     adopting a fork (`startNewThread(forkId)`) moves to the fork's id.
 */

import { useAssistantThreadId } from "@saas/shared/components/copilot/assistant-thread";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const CONVERSATION = "conv-example-0001";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("useAssistantThreadId", () => {
	it("runs on the conversation's id when the mount has one", () => {
		const { result } = renderHook(() => useAssistantThreadId(CONVERSATION));

		expect(result.current.threadId).toBe(CONVERSATION);
	});

	it("mints one id for a mount without a conversation and keeps it", () => {
		const { result, rerender } = renderHook(
			({ initial }: { initial: string | null }) =>
				useAssistantThreadId(initial),
			{ initialProps: { initial: null } },
		);
		const minted = result.current.threadId;

		rerender({ initial: null });
		rerender({ initial: "conv-example-0002" });

		expect(minted).toMatch(UUID);
		expect(result.current.threadId).toBe(minted);
	});

	it("keeps the thread when the conversation id changes later", () => {
		const { result, rerender } = renderHook(
			({ initial }: { initial: string }) => useAssistantThreadId(initial),
			{ initialProps: { initial: CONVERSATION } },
		);

		rerender({ initial: "conv-example-continuation" });

		expect(result.current.threadId).toBe(CONVERSATION);
	});

	it("moves to a fresh id only on a new conversation", () => {
		const { result } = renderHook(() => useAssistantThreadId(CONVERSATION));
		const before = result.current;

		act(() => {
			result.current.startNewThread();
		});

		expect(result.current.threadId).toMatch(UUID);
		expect(result.current.threadId).not.toBe(CONVERSATION);
		expect(result.current.startNewThread).toBe(before.startNewThread);
	});

	it("moves to the fork's conversation id when a fork is adopted", () => {
		const { result } = renderHook(() => useAssistantThreadId(CONVERSATION));

		act(() => {
			result.current.startNewThread("conv-example-fork");
		});

		expect(result.current.threadId).toBe("conv-example-fork");
	});
});
