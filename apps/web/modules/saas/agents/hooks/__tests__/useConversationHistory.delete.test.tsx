import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationHistory } from "../useConversationHistory";

const conversations = vi.hoisted(() => ({
	list: vi.fn(),
	get: vi.fn(),
	delete: vi.fn(),
}));

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

describe("useConversationHistory — delete (#2040 F40)", () => {
	function setup(organizationId: string | null = "example-org") {
		conversations.list.mockResolvedValue({
			conversations: [],
			hasMore: false,
		});
		conversations.get.mockResolvedValue(null);
		conversations.delete.mockImplementation(async ({ id }) => ({ id }));
		const { result } = renderHook(
			() =>
				useConversationHistory({
					agentId: "fabric-workspace-assistant",
					organizationId,
				}),
			{ wrapper },
		);
		act(() => result.current.selectConversation("conv_open"));
		return result;
	}

	it("keeps the open conversation selected when another one is deleted", async () => {
		const result = setup();

		await act(() => result.current.deleteConversation("conv_other"));

		expect(conversations.delete).toHaveBeenCalledWith({
			id: "conv_other",
			organizationId: "example-org",
		});
		expect(result.current.activeConversationId).toBe("conv_open");
	});

	it("clears the selection when the open conversation itself is deleted", async () => {
		const result = setup();

		await act(() => result.current.deleteConversation("conv_open"));

		expect(result.current.activeConversationId).toBeNull();
	});
});

it("omits a missing organization on deletion instead of sending null", async () => {
	conversations.list.mockResolvedValue({ conversations: [] });
	conversations.get.mockResolvedValue(null);
	conversations.delete.mockResolvedValue({ id: "example-conversation" });
	const { result } = renderHook(
		() => useConversationHistory({ organizationId: null }),
		{ wrapper },
	);
	await act(() => result.current.deleteConversation("example-conversation"));
	expect(conversations.delete).toHaveBeenCalledWith({
		id: "example-conversation",
		organizationId: undefined,
	});
});
