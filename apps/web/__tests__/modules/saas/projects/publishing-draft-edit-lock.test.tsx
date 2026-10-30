import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
	claim: vi.fn().mockResolvedValue({ status: "claimed", heldBy: null }),
	release: vi.fn().mockResolvedValue({}),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			publishingSuite: {
				claimDraftLock: {
					mutationOptions: (options: object) => ({
						mutationFn: calls.claim,
						...options,
					}),
				},
				releaseDraftLock: {
					mutationOptions: (options: object) => ({
						mutationFn: calls.release,
						...options,
					}),
				},
			},
		},
	},
}));

import { useDraftEditLock } from "@saas/projects/components/publishing-suite/DraftEditLock";

it("releases when an edit goes clean and claims the next edit", async () => {
	const client = new QueryClient();
	const { rerender, unmount } = renderHook(
		({ isDirty }) =>
			useDraftEditLock({
				projectId: "example-project",
				topicId: "example-topic",
				organizationId: "example-org",
				postType: "BLOG_POST",
				canEdit: true,
				hasDraft: true,
				isDirty,
			}),
		{
			initialProps: { isDirty: false },
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={client}>
					{children}
				</QueryClientProvider>
			),
		},
	);
	rerender({ isDirty: true });
	await waitFor(() => expect(calls.claim).toHaveBeenCalledTimes(1));
	rerender({ isDirty: false });
	await waitFor(() => expect(calls.release).toHaveBeenCalledTimes(1));
	rerender({ isDirty: true });
	await waitFor(() => expect(calls.claim).toHaveBeenCalledTimes(2));
	unmount();
	await waitFor(() => expect(calls.release).toHaveBeenCalledTimes(2));
});
