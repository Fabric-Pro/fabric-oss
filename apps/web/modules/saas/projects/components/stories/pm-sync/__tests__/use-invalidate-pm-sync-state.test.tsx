/**
 * Key-shape guard for `useInvalidatePmSyncState` (and the Review Center
 * delegation onto it).
 *
 * These tests run against the REAL `@orpc/tanstack-query` utils so they
 * exercise the real generated key shapes — only the transport client is
 * mocked. oRPC query keys are NESTED (`[["projects","stories","list"],
 * { input, type }]`); a hand-built flat filter like `["projects","stories"]`
 * silently matches nothing, which shipped as a stale conflict pill. The
 * literal-shape pin below fails loudly if that flat pattern returns or an
 * `@orpc/tanstack-query` upgrade changes the key format.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// The router-utils proxy walks `client[prop]` lazily at every depth, so the
// mock must be a self-returning proxy — a plain `{}` stub throws a TypeError
// on second-level traversal. Invoking it throws: these tests exercise key
// generation and cache invalidation only, never the transport.
vi.mock("@shared/lib/orpc-client", () => {
	const anyClient: unknown = new Proxy(function noop() {}, {
		get: () => anyClient,
		apply: () => {
			throw new Error("orpcClient must not be called in this test");
		},
	});
	return { orpcClient: anyClient };
});

// `use-review-center.ts` (imported for the delegation test) also exports query
// hooks that read the org context at call time; the module import alone must
// not drag the real auth/session chain into this suite.
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		basePath: "/app",
	}),
}));

// REAL createTanstackQueryUtils → real generated keys.
import { orpc } from "@shared/lib/orpc-query-utils";
import { useInvalidateReviewCenter } from "../review-center/use-review-center";
import { useInvalidatePmSyncState } from "../use-invalidate-pm-sync-state";

const PROJECT_ID = "p1";

function createWrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>
				{children}
			</QueryClientProvider>
		);
	};
}

/**
 * Seed the cache under the exact key shapes the live subscriptions register:
 * - stories.list — StoriesRoadmap, personal (`organizationId: null`) and org
 * - stories.get  — StoryWorkspacePage (`{ projectId, storyId, organizationId }`)
 * - reviewCenter.items / count — use-review-center query hooks
 */
function seedLiveSubscriptionKeys(queryClient: QueryClient) {
	const keys = {
		listPersonal: orpc.projects.stories.list.queryKey({
			input: { projectId: PROJECT_ID, organizationId: null },
		}),
		listOrg: orpc.projects.stories.list.queryKey({
			input: { projectId: PROJECT_ID, organizationId: "org-1" },
		}),
		get: orpc.projects.stories.get.queryKey({
			input: {
				projectId: PROJECT_ID,
				storyId: "s1",
				organizationId: null,
			},
		}),
		reviewCenterItems: orpc.projects.reviewCenter.items.queryKey({
			input: { projectId: PROJECT_ID, organizationId: null },
		}),
		reviewCenterCount: orpc.projects.reviewCenter.count.queryKey({
			input: { projectId: PROJECT_ID, organizationId: null },
		}),
	};
	queryClient.setQueryData(keys.listPersonal, []);
	queryClient.setQueryData(keys.listOrg, []);
	queryClient.setQueryData(keys.get, { id: "s1" });
	queryClient.setQueryData(keys.reviewCenterItems, {
		conflicts: [],
		failures: [],
		pullDrift: [],
	});
	queryClient.setQueryData(keys.reviewCenterCount, {
		conflictsCount: 0,
		failuresCount: 0,
		pullDriftCount: 0,
		total: 0,
	});
	return keys;
}

describe("oRPC query-key shape (bug-class tripwire)", () => {
	it("generates NESTED keys — [pathArray, { input, type }] — never flat string arrays", () => {
		expect(
			orpc.projects.stories.list.queryKey({
				input: { projectId: "p1", organizationId: null },
			}),
		).toEqual([
			["projects", "stories", "list"],
			{
				input: { projectId: "p1", organizationId: null },
				type: "query",
			},
		]);
	});
});

describe("useInvalidatePmSyncState", () => {
	it("invalidates all four query families under their live subscription keys", () => {
		const queryClient = new QueryClient();
		const keys = seedLiveSubscriptionKeys(queryClient);

		const { result } = renderHook(
			() => useInvalidatePmSyncState(PROJECT_ID),
			{ wrapper: createWrapper(queryClient) },
		);
		result.current();

		for (const key of Object.values(keys)) {
			expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
		}
	});

	it("matches an entry whose input omitted organizationId (undefined serialization)", () => {
		// StoriesRoadmap subscribes with `organizationId: string | null` while
		// StoryCard props allow `undefined` — exact-input invalidation keys
		// diverge on that serialization. Partial matching must cover both.
		const queryClient = new QueryClient();
		const undefinedOrgKey = orpc.projects.stories.list.queryKey({
			input: { projectId: PROJECT_ID, organizationId: undefined },
		});
		queryClient.setQueryData(undefinedOrgKey, []);

		const { result } = renderHook(
			() => useInvalidatePmSyncState(PROJECT_ID),
			{ wrapper: createWrapper(queryClient) },
		);
		result.current();

		expect(queryClient.getQueryState(undefinedOrgKey)?.isInvalidated).toBe(
			true,
		);
	});

	it("does NOT invalidate another project's queries (project-scoped filter)", () => {
		const queryClient = new QueryClient();
		const otherProjectKey = orpc.projects.stories.list.queryKey({
			input: { projectId: "OTHER", organizationId: null },
		});
		queryClient.setQueryData(otherProjectKey, []);

		const { result } = renderHook(
			() => useInvalidatePmSyncState(PROJECT_ID),
			{ wrapper: createWrapper(queryClient) },
		);
		result.current();

		expect(queryClient.getQueryState(otherProjectKey)?.isInvalidated).toBe(
			false,
		);
	});
});

describe("useInvalidateReviewCenter (delegation)", () => {
	it("invalidates the same four families — a row action refreshes the roadmap too", () => {
		// ReviewCenterPanel.test.tsx mocks this hook as a no-op, so the
		// delegation onto the shared helper needs direct coverage here.
		const queryClient = new QueryClient();
		const keys = seedLiveSubscriptionKeys(queryClient);

		const { result } = renderHook(
			() => useInvalidateReviewCenter(PROJECT_ID),
			{ wrapper: createWrapper(queryClient) },
		);
		result.current();

		for (const key of Object.values(keys)) {
			expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
		}
	});
});
