import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationDetail } from "../useConversationHistory";

const conversations = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agents: { conversations } },
}));

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			{children}
		</QueryClientProvider>
	);
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("useConversationDetail", () => {
	it("reads a conversation that is there", async () => {
		const stored = { id: "c1", isOwn: true };
		conversations.get.mockResolvedValue(stored);

		const { result } = renderHook(
			() => useConversationDetail("c1", "org-1"),
			{
				wrapper,
			},
		);

		await waitFor(() => expect(result.current.data).toEqual(stored));
		expect(conversations.get).toHaveBeenCalledWith({
			id: "c1",
			organizationId: "org-1",
		});
	});

	it("reads one that is gone as null, not as an error", async () => {
		conversations.get.mockRejectedValue(
			new ORPCError("NOT_FOUND", { message: "Conversation not found" }),
		);

		const { result } = renderHook(
			() => useConversationDetail("c1", "org-1"),
			{
				wrapper,
			},
		);

		await waitFor(() => expect(result.current.data).toBeNull());
		expect(result.current.isError).toBe(false);
	});

	it.each([
		["a server failure", new ORPCError("INTERNAL_SERVER_ERROR")],
		["a refusal", new ORPCError("FORBIDDEN", { message: "not found" })],
		["a network failure", new Error("Failed to fetch")],
		[
			"an error whose words say not found",
			new Error("Conversation not found"),
		],
	])(
		"reads %s as an error, so it is not told to the person as gone",
		async (_label, error) => {
			conversations.get.mockRejectedValue(error);

			const { result } = renderHook(
				() => useConversationDetail("c1", "org-1"),
				{
					wrapper,
				},
			);

			await waitFor(() => expect(result.current.isError).toBe(true));
			expect(result.current.data).toBeUndefined();
		},
	);

	it("reads nothing when there is no id", () => {
		const { result } = renderHook(() => useConversationDetail(null), {
			wrapper,
		});

		expect(result.current.fetchStatus).toBe("idle");
		expect(conversations.get).not.toHaveBeenCalled();
	});
});
