/**
 * Unit tests for `useIsGuestInOrg` seeded-context resolution.
 *
 * Contract under test (gap-closure for the guest shell flash):
 * - When `OrganizationGuestProvider` has server-seeded a value, the hook
 *   returns it on the FIRST render and the fallback `organizations.isGuest`
 *   query never fires (no flash, no extra request — for guests AND members).
 * - Without a seeded provider, the legacy oRPC fallback query still works.
 *
 * Run with:
 *   pnpm --filter web test modules/saas/organizations/hooks/__tests__/use-is-guest-in-org.test.tsx
 */
import { OrganizationGuestProvider } from "@saas/organizations/lib/organization-guest-context";
import { resetSeededOrganizationGuestFlags } from "@saas/organizations/lib/organization-guest-store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useIsGuestInOrg } from "../use-is-guest-in-org";

const orgContextMock = vi.fn();
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => orgContextMock(),
}));

const isGuestQueryFn = vi.fn();
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		organizations: {
			isGuest: {
				queryOptions: ({
					input,
				}: {
					input: { organizationId: string };
				}) => ({
					queryKey: ["organizations", "isGuest", input],
					queryFn: () => isGuestQueryFn(input),
				}),
			},
		},
	},
}));

function makeWrapper(seed?: { isGuest: boolean }) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
		},
	});
	return function Wrapper({ children }: { children: ReactNode }) {
		if (seed === undefined) {
			return (
				<QueryClientProvider client={queryClient}>
					{children}
				</QueryClientProvider>
			);
		}
		return (
			<QueryClientProvider client={queryClient}>
				<OrganizationGuestProvider
					organizationSlug="acme"
					isGuest={seed.isGuest}
				>
					{children}
				</OrganizationGuestProvider>
			</QueryClientProvider>
		);
	};
}

async function flushAsync() {
	await new Promise((resolve) => setTimeout(resolve, 25));
}

beforeEach(() => {
	vi.clearAllMocks();
	resetSeededOrganizationGuestFlags();
	orgContextMock.mockReturnValue({ organizationId: "org-1" });
	isGuestQueryFn.mockResolvedValue({ isGuest: false });
});

describe("useIsGuestInOrg", () => {
	it("returns the seeded TRUE value on the first render without firing the fallback query", async () => {
		const { result } = renderHook(() => useIsGuestInOrg(), {
			wrapper: makeWrapper({ isGuest: true }),
		});

		// First render — no flash window where the hook reports false.
		expect(result.current).toBe(true);

		await flushAsync();
		expect(result.current).toBe(true);
		expect(isGuestQueryFn).not.toHaveBeenCalled();
	});

	it("returns the seeded FALSE value (member) without firing the fallback query", async () => {
		const { result } = renderHook(() => useIsGuestInOrg(), {
			wrapper: makeWrapper({ isGuest: false }),
		});

		expect(result.current).toBe(false);

		await flushAsync();
		expect(result.current).toBe(false);
		// Seeded knowledge in EITHER direction makes the round-trip
		// redundant — members no longer pay the request either.
		expect(isGuestQueryFn).not.toHaveBeenCalled();
	});

	it("falls back to the oRPC query when no provider seeded a value", async () => {
		isGuestQueryFn.mockResolvedValue({ isGuest: true });

		const { result } = renderHook(() => useIsGuestInOrg(), {
			wrapper: makeWrapper(),
		});

		// Loading default stays false (legacy behavior).
		expect(result.current).toBe(false);

		await waitFor(() => expect(result.current).toBe(true));
		expect(isGuestQueryFn).toHaveBeenCalledWith({
			organizationId: "org-1",
		});
	});

	it("stays disabled in personal context (no org id, no provider)", async () => {
		orgContextMock.mockReturnValue({ organizationId: null });

		const { result } = renderHook(() => useIsGuestInOrg(), {
			wrapper: makeWrapper(),
		});

		expect(result.current).toBe(false);

		await flushAsync();
		expect(isGuestQueryFn).not.toHaveBeenCalled();
	});
});
