/**
 * Unit tests for `useDocumentAssistantHistoryEnabled`.
 *
 * Covers spec 2026-05-19-ai-assistant-document-chat-history §3.11 FR-27:
 *   - Personal context (no active org) is always treated as enabled.
 *   - Org context, server returns `true`  → hook returns `true`.
 *   - Org context, server returns `false` → hook returns `false`.
 *   - Org context, query still loading    → hook returns `true` (optimistic
 *     placeholder; matches the schema default and the "history is purely
 *     additive" stance from spec §13 step 3).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `useOrganizationContext` is the only client-side dependency we need to
// vary per test. Mock it before the hook imports its module graph.
const { mockUseOrganizationContext } = vi.hoisted(() => ({
	mockUseOrganizationContext: vi.fn(),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => mockUseOrganizationContext(),
}));

// `orpc.organizations.documentAssistantHistory.get.queryOptions` is the
// only oRPC surface this hook touches. Stub it so the test can drive the
// resolved value without spinning up a real server.
const { mockGetQueryFn } = vi.hoisted(() => ({
	mockGetQueryFn: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		organizations: {
			documentAssistantHistory: {
				get: {
					queryOptions: (opts: {
						input: { organizationId: string };
					}) => ({
						queryKey: [
							"organizations",
							"documentAssistantHistory",
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

import { useDocumentAssistantHistoryEnabled } from "../useDocumentAssistantHistoryEnabled";

function makeWrapper() {
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				// Disable retries so a rejected query surfaces immediately.
				retry: false,
				// Allow the placeholderData to surface during the in-flight
				// window we assert on in the "loading" test.
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

describe("useDocumentAssistantHistoryEnabled", () => {
	it("returns true for personal context without hitting the server", () => {
		mockUseOrganizationContext.mockReturnValue({
			organizationId: null,
			isOrgContext: false,
		});

		const { result } = renderHook(
			() => useDocumentAssistantHistoryEnabled(),
			{ wrapper: makeWrapper() },
		);

		expect(result.current).toBe(true);
		// Personal context must NEVER call the org-scoped procedure — there
		// is no org row to read.
		expect(mockGetQueryFn).not.toHaveBeenCalled();
	});

	it("returns true while the org-context query is still loading (optimistic default)", () => {
		mockUseOrganizationContext.mockReturnValue({
			organizationId: "org-1",
			isOrgContext: true,
		});
		// Never resolves — keep the query pending.
		mockGetQueryFn.mockReturnValue(new Promise(() => {}));

		const { result } = renderHook(
			() => useDocumentAssistantHistoryEnabled(),
			{ wrapper: makeWrapper() },
		);

		// placeholderData kicks in immediately while the queryFn is pending.
		expect(result.current).toBe(true);
	});

	it("returns true when the server reports the feature enabled", async () => {
		mockUseOrganizationContext.mockReturnValue({
			organizationId: "org-1",
			isOrgContext: true,
		});
		mockGetQueryFn.mockResolvedValue({
			documentAssistantHistoryEnabled: true,
		});

		const { result } = renderHook(
			() => useDocumentAssistantHistoryEnabled(),
			{ wrapper: makeWrapper() },
		);

		await waitFor(() => {
			expect(mockGetQueryFn).toHaveBeenCalledWith({
				organizationId: "org-1",
			});
		});
		expect(result.current).toBe(true);
	});

	it("returns false when the org has disabled the feature", async () => {
		mockUseOrganizationContext.mockReturnValue({
			organizationId: "org-2",
			isOrgContext: true,
		});
		mockGetQueryFn.mockResolvedValue({
			documentAssistantHistoryEnabled: false,
		});

		const { result } = renderHook(
			() => useDocumentAssistantHistoryEnabled(),
			{ wrapper: makeWrapper() },
		);

		await waitFor(() => {
			expect(result.current).toBe(false);
		});
		expect(mockGetQueryFn).toHaveBeenCalledWith({
			organizationId: "org-2",
		});
	});
});
