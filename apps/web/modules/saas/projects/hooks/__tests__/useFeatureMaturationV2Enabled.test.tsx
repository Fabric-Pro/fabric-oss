/**
 * Unit tests for `useFeatureMaturationV2Enabled`.
 *
 * Covers Feature Maturation V2 spec §9 (feature flag & v1/v2 toggle), updated for
 * the #1797 all-tenant rollout:
 *   - Personal context (no active org) is always ENABLED (V2 is on for personal;
 *     no server call — there is no org row to read).
 *   - Org context, server returns `true`  → hook returns `true`.
 *   - Org context, server returns `false` → hook returns `false` (per-org
 *     kill-switch still works).
 *   - Org context, query still loading    → hook returns `true` (optimistic
 *     placeholder; V2 is the default for all orgs now, so avoid a tab flash while
 *     the rare opted-out org confirms).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseOrganizationContext } = vi.hoisted(() => ({
	mockUseOrganizationContext: vi.fn(),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => mockUseOrganizationContext(),
}));

const { mockGetQueryFn } = vi.hoisted(() => ({
	mockGetQueryFn: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		organizations: {
			featureMaturationV2: {
				get: {
					queryOptions: (opts: {
						input: { organizationId: string };
					}) => ({
						queryKey: [
							"organizations",
							"featureMaturationV2",
							"get",
							opts.input,
						],
						queryFn: () => mockGetQueryFn(opts.input),
					}),
				},
			},
		},
	},
}));

import { useFeatureMaturationV2Enabled } from "../useFeatureMaturationV2Enabled";

function makeWrapper() {
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				gcTime: 0,
			},
		},
	});
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

beforeEach(() => {
	mockUseOrganizationContext.mockReset();
	mockGetQueryFn.mockReset();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("useFeatureMaturationV2Enabled", () => {
	it("returns true for personal context without hitting the server", () => {
		mockUseOrganizationContext.mockReturnValue({
			organizationId: null,
			isOrgContext: false,
		});

		const { result } = renderHook(() => useFeatureMaturationV2Enabled(), {
			wrapper: makeWrapper(),
		});

		// #1797: personal is enrolled in V2 unconditionally, and must NEVER call
		// the org-scoped procedure — there is no org row to read.
		expect(result.current).toBe(true);
		expect(mockGetQueryFn).not.toHaveBeenCalled();
	});

	it("returns true while the org-context query is still loading (optimistic default)", () => {
		mockUseOrganizationContext.mockReturnValue({
			organizationId: "org-1",
			isOrgContext: true,
		});
		// Never resolves — keep the query pending.
		mockGetQueryFn.mockReturnValue(new Promise(() => {}));

		const { result } = renderHook(() => useFeatureMaturationV2Enabled(), {
			wrapper: makeWrapper(),
		});

		// #1797: placeholderData is now optimistic true — V2 is the default for
		// all orgs, so don't flash V1 while the rare opted-out org confirms.
		expect(result.current).toBe(true);
	});

	it("returns true when the server reports V2 enabled", async () => {
		mockUseOrganizationContext.mockReturnValue({
			organizationId: "org-1",
			isOrgContext: true,
		});
		mockGetQueryFn.mockResolvedValue({
			featureMaturationV2Enabled: true,
		});

		const { result } = renderHook(() => useFeatureMaturationV2Enabled(), {
			wrapper: makeWrapper(),
		});

		await waitFor(() => {
			expect(result.current).toBe(true);
		});
		expect(mockGetQueryFn).toHaveBeenCalledWith({
			organizationId: "org-1",
		});
	});

	it("returns false when the org has V2 disabled", async () => {
		mockUseOrganizationContext.mockReturnValue({
			organizationId: "org-2",
			isOrgContext: true,
		});
		mockGetQueryFn.mockResolvedValue({
			featureMaturationV2Enabled: false,
		});

		const { result } = renderHook(() => useFeatureMaturationV2Enabled(), {
			wrapper: makeWrapper(),
		});

		// Wait for the resolved value to settle past the optimistic `true`
		// placeholder — the per-org kill-switch must land on `false`.
		await waitFor(() => {
			expect(result.current).toBe(false);
		});
		expect(mockGetQueryFn).toHaveBeenCalledWith({
			organizationId: "org-2",
		});
	});
});
