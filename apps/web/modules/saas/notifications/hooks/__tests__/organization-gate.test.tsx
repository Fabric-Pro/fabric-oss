import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { organizationIdMock, listMock, unreadCountMock } = vi.hoisted(() => ({
	organizationIdMock: vi.fn<() => string | null>(),
	listMock: vi.fn(),
	unreadCountMock: vi.fn(),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: organizationIdMock,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		notifications: { list: listMock, unreadCount: unreadCountMock },
	},
}));

import { useNotificationUnreadCount } from "../use-notification-unread-count";
import { useNotifications } from "../use-notifications";

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

// The notification procedures refuse a request that names no organization,
// and the active organization can be unresolved on the first client render.
describe("notification queries wait for an organization", () => {
	beforeEach(() => {
		listMock.mockReset().mockResolvedValue({ items: [], nextCursor: null });
		unreadCountMock.mockReset().mockResolvedValue({ count: 0 });
	});

	it("sends nothing while the organization is unresolved", async () => {
		organizationIdMock.mockReturnValue(null);
		const list = renderHook(() => useNotifications(), { wrapper });
		const count = renderHook(() => useNotificationUnreadCount(), {
			wrapper,
		});
		// Let any mount-time fetch run before asserting it never happened.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(list.result.current.fetchStatus).toBe("idle");
		expect(count.result.current.fetchStatus).toBe("idle");
		expect(listMock).not.toHaveBeenCalled();
		expect(unreadCountMock).not.toHaveBeenCalled();
	});

	it("queries with the organization once it is known", async () => {
		organizationIdMock.mockReturnValue("example-org");
		renderHook(() => useNotifications(), { wrapper });
		renderHook(() => useNotificationUnreadCount(), { wrapper });
		await waitFor(() => {
			expect(listMock).toHaveBeenCalledWith(
				expect.objectContaining({ organizationId: "example-org" }),
			);
			expect(unreadCountMock).toHaveBeenCalledWith({
				organizationId: "example-org",
			});
		});
	});
});
