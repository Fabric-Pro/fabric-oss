/**
 * Unit tests for `useActiveOrganizationQuery` guest routing.
 *
 * Contract under test (gap-closure for the guest 403 probe noise):
 * - Known guest (explicit option or server-seeded store) → the thin
 *   `organizations.getGuestOrg` endpoint is called DIRECTLY and the
 *   Better Auth membership probe (which always 403s for guests) never
 *   fires.
 * - Member / unknown → the existing probe-then-guest-fallback behavior
 *   is byte-for-byte unchanged.
 * - Stale guest seed (e.g. promoted mid-session) → falls through to the
 *   standard membership path instead of erroring.
 *
 * Run with:
 *   pnpm --filter web test modules/saas/organizations/lib/__tests__/active-organization-query.test.tsx
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActiveOrganizationQuery } from "../api";
import {
	resetSeededOrganizationGuestFlags,
	seedOrganizationGuestFlag,
} from "../organization-guest-store";

const getFullOrganizationMock = vi.fn();
vi.mock("@repo/auth/client", () => ({
	authClient: {
		organization: {
			getFullOrganization: (input: unknown) =>
				getFullOrganizationMock(input),
			list: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
		},
	},
}));

const getGuestOrgMock = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		organizations: {
			getGuestOrg: (input: unknown) => getGuestOrgMock(input),
			generateSlug: vi.fn(),
			invitations: { list: vi.fn() },
		},
	},
}));

const GUEST_ORG = {
	id: "org-1",
	slug: "acme",
	name: "Acme",
	logo: null,
	createdAt: new Date("2026-01-01"),
	members: [],
	invitations: [],
};

const MEMBER_ORG = {
	id: "org-1",
	slug: "acme",
	name: "Acme",
	logo: null,
	createdAt: new Date("2026-01-01"),
	members: [{ id: "member-1", userId: "user-1", role: "member" }],
	invitations: [],
};

function makeWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
		},
	});
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>
				{children}
			</QueryClientProvider>
		);
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	resetSeededOrganizationGuestFlags();
});

describe("useActiveOrganizationQuery", () => {
	it("known guest via options → calls getGuestOrg directly, Better Auth probe never fires", async () => {
		getGuestOrgMock.mockResolvedValue(GUEST_ORG);

		const { result } = renderHook(
			() => useActiveOrganizationQuery("acme", { isGuest: true }),
			{ wrapper: makeWrapper() },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(result.current.data).toEqual(GUEST_ORG);
		expect(getGuestOrgMock).toHaveBeenCalledExactlyOnceWith({
			slug: "acme",
		});
		expect(getFullOrganizationMock).not.toHaveBeenCalled();
	});

	it("known guest via the server-seeded store → same direct path (covers the ActiveOrganizationProvider instance mounted above the org layout)", async () => {
		seedOrganizationGuestFlag("acme", true);
		getGuestOrgMock.mockResolvedValue(GUEST_ORG);

		const { result } = renderHook(
			() => useActiveOrganizationQuery("acme"),
			{ wrapper: makeWrapper() },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(result.current.data).toEqual(GUEST_ORG);
		expect(getGuestOrgMock).toHaveBeenCalledExactlyOnceWith({
			slug: "acme",
		});
		expect(getFullOrganizationMock).not.toHaveBeenCalled();
	});

	it("member path (seeded false) → Better Auth result returned, guest endpoint untouched", async () => {
		seedOrganizationGuestFlag("acme", false);
		getFullOrganizationMock.mockResolvedValue({
			data: MEMBER_ORG,
			error: null,
		});

		const { result } = renderHook(
			() => useActiveOrganizationQuery("acme"),
			{ wrapper: makeWrapper() },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(result.current.data).toEqual(MEMBER_ORG);
		expect(getFullOrganizationMock).toHaveBeenCalledExactlyOnceWith({
			query: { organizationSlug: "acme" },
		});
		expect(getGuestOrgMock).not.toHaveBeenCalled();
	});

	it("unknown viewer (no seed) → existing probe + guest fallback on 403 still works", async () => {
		getFullOrganizationMock.mockResolvedValue({
			data: null,
			error: { status: 403, message: "FORBIDDEN" },
		});
		getGuestOrgMock.mockResolvedValue(GUEST_ORG);

		const { result } = renderHook(
			() => useActiveOrganizationQuery("acme"),
			{ wrapper: makeWrapper() },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(result.current.data).toEqual(GUEST_ORG);
		expect(getFullOrganizationMock).toHaveBeenCalledTimes(1);
		expect(getGuestOrgMock).toHaveBeenCalledExactlyOnceWith({
			slug: "acme",
		});
	});

	it("unknown viewer (no seed) → 5xx probe errors are NOT masked by the guest fallback", async () => {
		getFullOrganizationMock.mockResolvedValue({
			data: null,
			error: { status: 500, message: "Internal error" },
		});

		const { result } = renderHook(
			() => useActiveOrganizationQuery("acme"),
			{ wrapper: makeWrapper() },
		);

		await waitFor(() => expect(result.current.isError).toBe(true));

		expect(getGuestOrgMock).not.toHaveBeenCalled();
		expect(result.current.error?.message).toBe("Internal error");
	});

	it("stale guest seed (promoted to member) → guest call fails, falls through to the membership path", async () => {
		seedOrganizationGuestFlag("acme", true);
		getGuestOrgMock.mockRejectedValue(new Error("NOT_FOUND"));
		getFullOrganizationMock.mockResolvedValue({
			data: MEMBER_ORG,
			error: null,
		});

		const { result } = renderHook(
			() => useActiveOrganizationQuery("acme"),
			{ wrapper: makeWrapper() },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(result.current.data).toEqual(MEMBER_ORG);
		expect(getGuestOrgMock).toHaveBeenCalledTimes(1);
		expect(getFullOrganizationMock).toHaveBeenCalledTimes(1);
	});
});
