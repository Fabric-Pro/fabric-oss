import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRemoveConversationProject } from "../useRemoveConversationProject";

const detach = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { conversations: { detach } } },
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			conversations: {
				getProject: {
					key: () => [["projects", "conversations", "getProject"]],
				},
			},
		},
	},
}));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			{children}
		</QueryClientProvider>
	);
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("useRemoveConversationProject (#2040)", () => {
	it("detaches the project from an open conversation before clearing the pill", async () => {
		detach.mockResolvedValue({ success: true });
		const onRemoved = vi.fn();
		const { result } = renderHook(
			() =>
				useRemoveConversationProject({
					conversationId: "conv_1",
					organizationId: "org_1",
					onRemoved,
				}),
			{ wrapper },
		);

		await act(() => result.current.removeProject());

		expect(detach).toHaveBeenCalledWith({
			conversationId: "conv_1",
			organizationId: "org_1",
		});
		expect(onRemoved).toHaveBeenCalledTimes(1);
	});

	it("keeps the pill when the detach fails, and says so", async () => {
		detach.mockRejectedValue(new Error("Forbidden"));
		const onRemoved = vi.fn();
		const { result } = renderHook(
			() =>
				useRemoveConversationProject({
					conversationId: "conv_1",
					organizationId: "org_1",
					onRemoved,
				}),
			{ wrapper },
		);

		await act(() => result.current.removeProject());

		expect(onRemoved).not.toHaveBeenCalled();
		expect(toastError).toHaveBeenCalled();
	});

	it("only clears the pill before any conversation exists", async () => {
		const onRemoved = vi.fn();
		const { result } = renderHook(
			() =>
				useRemoveConversationProject({
					conversationId: null,
					organizationId: "org_1",
					onRemoved,
				}),
			{ wrapper },
		);

		await act(() => result.current.removeProject());

		expect(detach).not.toHaveBeenCalled();
		expect(onRemoved).toHaveBeenCalledTimes(1);
	});
});
