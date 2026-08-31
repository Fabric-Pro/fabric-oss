/**
 * Unit tests for the AiUsageLimitBanner tenant scoping.
 *
 * Contract under test:
 * - A project-scoped GUEST inside a host org is scoped to THEIR OWN
 *   organization for both the `aiUsageLimits.status` and `aiUsageLimits.list`
 *   hooks — never the host's, whose org-scoped calls 403 for them anyway. This
 *   was personal scope (an explicit `null`) until personal context was removed
 *   and every account gained an organization (Fizzy #1875).
 * - An org member is scoped to the organization in the URL.
 * - The manage CTA lands in the same tenancy the rows were fetched with, and
 *   addresses it by SLUG. It used to interpolate the organization ID into a
 *   segment that resolves by slug, so the link 404'd for every member; nothing
 *   here asserted a member's href, which is how that survived.
 *
 * Run with:
 *   pnpm --filter web test modules/saas/payments/components/__tests__/AiUsageLimitBanner.test.tsx
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiUsageLimitBanner } from "../AiUsageLimitBanner";

const orgContextMock = vi.fn();
const accountOrgMock = vi.fn();
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => orgContextMock(),
	useAccountOrganization: () => accountOrgMock(),
}));

const guestMock = vi.fn();
vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => guestMock(),
}));

const statusHookMock = vi.fn();
const listHookMock = vi.fn();
vi.mock("@saas/payments/hooks/useAiUsageLimits", () => ({
	useAiUsageLimitsStatus: (organizationId: string | null | undefined) =>
		statusHookMock(organizationId),
	useAiUsageLimits: (organizationId: string | null | undefined) =>
		listHookMock(organizationId),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

beforeEach(() => {
	vi.clearAllMocks();
	orgContextMock.mockReturnValue({
		organizationId: "org-1",
		organizationSlug: "acme",
	});
	guestMock.mockReturnValue(false);
	// A guest is never a member of the host, so their own org is a different
	// one — which is the whole point of the distinction below.
	accountOrgMock.mockReturnValue({ id: "org-own", slug: "own-workspace" });
	statusHookMock.mockReturnValue({ data: undefined });
	listHookMock.mockReturnValue({ data: undefined });
});

describe("AiUsageLimitBanner tenant scoping", () => {
	it("org member → status and list hooks receive the org id", () => {
		render(<AiUsageLimitBanner />);

		expect(statusHookMock).toHaveBeenCalledWith("org-1");
		expect(listHookMock).toHaveBeenCalledWith("org-1");
	});

	it("guest in host org → hooks receive their OWN org, never the host's", () => {
		guestMock.mockReturnValue(true);

		render(<AiUsageLimitBanner />);

		expect(statusHookMock).toHaveBeenCalledWith("org-own");
		expect(listHookMock).toHaveBeenCalledWith("org-own");
		expect(statusHookMock).not.toHaveBeenCalledWith("org-1");
		expect(listHookMock).not.toHaveBeenCalledWith("org-1");
	});

	it("no organization resolved yet → hooks receive null rather than a guess", () => {
		orgContextMock.mockReturnValue({
			organizationId: null,
			organizationSlug: null,
		});

		render(<AiUsageLimitBanner />);

		expect(statusHookMock).toHaveBeenCalledWith(null);
		expect(listHookMock).toHaveBeenCalledWith(null);
	});

	// The regression this file did not have: a member's CTA. It addressed the
	// organization by ID in a segment that resolves by SLUG, so it 404'd.
	it("member → manage CTA addresses the org by slug, not by id", () => {
		statusHookMock.mockReturnValue({
			data: {
				statuses: [
					{
						percent: 95,
						limit: {
							id: "limit-1",
							bannerThresholdPercent: 90,
							enforcement: "HARD",
							name: "Team limit",
							window: "DAILY",
						},
					},
				],
			},
		});
		listHookMock.mockReturnValue({ data: { canManage: true, limits: [] } });

		render(<AiUsageLimitBanner />);

		expect(
			screen.getByRole("link", { name: /banner\.manageCta/ }),
		).toHaveAttribute("href", "/app/acme/settings/usage?limitId=limit-1");
	});

	it("guest with a crossed limit → manage CTA routes to their OWN org", () => {
		guestMock.mockReturnValue(true);
		statusHookMock.mockReturnValue({
			data: {
				statuses: [
					{
						percent: 95,
						limit: {
							id: "limit-1",
							bannerThresholdPercent: 90,
							enforcement: "HARD",
							name: "Their own limit",
							window: "DAILY",
						},
					},
				],
			},
		});
		listHookMock.mockReturnValue({ data: { canManage: true, limits: [] } });

		render(<AiUsageLimitBanner />);

		const manageLink = screen.getByRole("link", {
			name: /banner\.manageCta/,
		});
		expect(manageLink).toHaveAttribute(
			"href",
			"/app/own-workspace/settings/usage?limitId=limit-1",
		);
	});
});
