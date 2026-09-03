/**
 * Observer-dedup guard for `useReviewCenterCount`.
 *
 * The toolbar badge (`ReviewCenterInbox`) and the review panel both observe
 * this query, and on the roadmap they mount in different commits. With
 * `staleTime: 0` + `refetchOnMount: "always"` the second observer re-fetched
 * a count the first had just received. The hook now keeps a short staleTime
 * so a second observer inside that window reuses the cached result. Runs
 * against the REAL `@orpc/tanstack-query` utils; only the transport is mocked.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// Every invocation is recorded with the procedure path that was walked to
// reach it and the input it received, so the test asserts the hook called
// `projects.reviewCenter.count` with the expected input — not merely that
// "something" was called once.
const { transportCalls } = vi.hoisted(() => ({
	transportCalls: [] as { path: string; input: unknown }[],
}));

// The router-utils client is walked lazily at every depth, so the mock is a
// path-tracking self-returning proxy rather than a plain nested object.
vi.mock("@shared/lib/orpc-client", () => {
	const makeClient = (path: string[]): unknown =>
		new Proxy(function noop() {}, {
			get: (_target, prop) =>
				typeof prop === "string"
					? makeClient([...path, prop])
					: undefined,
			apply: (_target, _thisArg, [input]) => {
				transportCalls.push({ path: path.join("."), input });
				return Promise.resolve({
					total: 2,
					conflictsCount: 1,
					failuresCount: 1,
					pullDriftCount: 0,
				});
			},
		});
	return { orpcClient: makeClient([]) };
});

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org1",
		basePath: "/app/org1",
	}),
}));

import { useReviewCenterCount } from "../use-review-center";

function createWrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>
				{children}
			</QueryClientProvider>
		);
	};
}

describe("useReviewCenterCount", () => {
	it("a second observer mounting right after the first reuses the cached count", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = createWrapper(queryClient);

		// First observer: the always-mounted toolbar badge.
		const badge = renderHook(() => useReviewCenterCount("p1"), { wrapper });
		await waitFor(() => expect(badge.result.current.data?.total).toBe(2));
		expect(transportCalls).toEqual([
			{
				path: "projects.reviewCenter.count",
				input: { projectId: "p1", organizationId: "org1" },
			},
		]);

		// Second observer: the panel, mounting in a later commit.
		const panel = renderHook(() => useReviewCenterCount("p1"), { wrapper });
		await waitFor(() => expect(panel.result.current.data?.total).toBe(2));

		expect(transportCalls).toHaveLength(1);
	});
});
