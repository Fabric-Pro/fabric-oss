/**
 * The stamp of an accept or reject on its proposal is only the
 * conversation's record. Its failure toast must not claim anything about the
 * edit itself: an offline Confirm that applied nothing said "your
 * accept/reject was still applied".
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	mutateAsync: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: { error: m.toastError },
}));
vi.mock("../useDocumentAssistantHistory", () => ({
	useRecordDocumentAssistantDiffOutcome: () => ({
		mutateAsync: m.mutateAsync,
	}),
}));

import { useDiffOutcomeStamp } from "../use-diff-outcome-stamp";

const AUDIT = {
	conversationId: "conversation-1",
	projectId: "project-1",
	organizationId: null,
	messageId: "message-1",
	toolCallId: "call-1",
};

beforeEach(() => {
	vi.clearAllMocks();
});

it("says the decision was not recorded, and nothing about the edit, when the stamp fails", async () => {
	m.mutateAsync.mockRejectedValueOnce(new Error("Failed to fetch"));
	const { result } = renderHook(() => useDiffOutcomeStamp());

	await act(async () => {
		await result.current(AUDIT, "accepted");
	});

	expect(m.toastError).toHaveBeenCalledTimes(1);
	expect(m.toastError).toHaveBeenCalledWith(
		"Couldn't record your decision in the conversation history.",
	);
});

it("stamps the outcome on the proposal and stays quiet when it lands", async () => {
	m.mutateAsync.mockResolvedValueOnce(undefined);
	const { result } = renderHook(() => useDiffOutcomeStamp());

	await act(async () => {
		await result.current(AUDIT, "rejected");
	});

	expect(m.mutateAsync).toHaveBeenCalledWith(
		expect.objectContaining({
			conversationId: "conversation-1",
			messageId: "message-1",
			toolCallId: "call-1",
			outcome: "rejected",
		}),
	);
	expect(m.toastError).not.toHaveBeenCalled();
});
