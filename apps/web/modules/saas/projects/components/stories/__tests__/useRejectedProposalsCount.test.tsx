/**
 * The Rejected count on the Roadmap's Rejected proposals entry reads the
 * Rejected list's size, and refreshes, without a page reload, whenever an
 * inbox action refreshes the inbox's other counts.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { invalidateProposalInboxQueries } from "../proposal-inbox-client";
import { useRejectedProposalsCount } from "../useRejectedProposalsCount";

const h = vi.hoisted(() => ({ count: vi.fn() }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			teamsChannelMonitor: { pendingProposals: { count: h.count } },
		},
	},
}));

describe("useRejectedProposalsCount", () => {
	it("counts the Rejected list and refreshes after an inbox action", async () => {
		h.count.mockResolvedValueOnce({ count: 2 });
		h.count.mockResolvedValueOnce({ count: 3 });
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				{children}
			</QueryClientProvider>
		);
		const { result } = renderHook(
			() => useRejectedProposalsCount("example-project", "example-org"),
			{ wrapper },
		);

		await waitFor(() => expect(result.current).toBe(2));
		expect(h.count).toHaveBeenCalledWith({
			projectId: "example-project",
			organizationId: "example-org",
			rejected: true,
		});

		invalidateProposalInboxQueries(
			client,
			"example-project",
			"example-org",
		);

		await waitFor(() => expect(result.current).toBe(3));
	});
});
