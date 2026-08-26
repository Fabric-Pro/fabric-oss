/**
 * Unit tests for the `isGuest` exposure on `useOrganizationContext`.
 *
 * Contract under test: the org layout server-seeds the guest flag via
 * `OrganizationGuestProvider`; `useOrganizationContext()` surfaces it as
 * `isGuest: boolean`, defaulting to false when no provider seeded a
 * value (personal context / non-org trees).
 *
 * Run with:
 *   pnpm --filter web test modules/saas/organizations/hooks/__tests__/use-organization-context.test.tsx
 */
import { OrganizationGuestProvider } from "@saas/organizations/lib/organization-guest-context";
import { resetSeededOrganizationGuestFlags } from "@saas/organizations/lib/organization-guest-store";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useOrganizationContext } from "../use-organization-context";

beforeEach(() => {
	resetSeededOrganizationGuestFlags();
});

describe("useOrganizationContext — isGuest", () => {
	it("defaults to false when no provider seeded a value (personal context)", () => {
		const { result } = renderHook(() => useOrganizationContext());

		expect(result.current.isGuest).toBe(false);
	});

	it("exposes the server-seeded TRUE flag on the first render", () => {
		const wrapper = ({ children }: { children: ReactNode }) => (
			<OrganizationGuestProvider organizationSlug="acme" isGuest={true}>
				{children}
			</OrganizationGuestProvider>
		);

		const { result } = renderHook(() => useOrganizationContext(), {
			wrapper,
		});

		expect(result.current.isGuest).toBe(true);
	});

	it("exposes the server-seeded FALSE flag for full members", () => {
		const wrapper = ({ children }: { children: ReactNode }) => (
			<OrganizationGuestProvider organizationSlug="acme" isGuest={false}>
				{children}
			</OrganizationGuestProvider>
		);

		const { result } = renderHook(() => useOrganizationContext(), {
			wrapper,
		});

		expect(result.current.isGuest).toBe(false);
	});
});
