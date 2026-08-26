/**
 * Unit tests for the AiUsageLimitBanner tenant scoping.
 *
 * Contract under test (gap-closure for guest 403s in the app shell):
 * - A project-scoped GUEST inside a host org gets the PERSONAL scope
 *   (explicit `organizationId: null` — multi-tenant XOR) for both the
 *   `aiUsageLimits.status` and `aiUsageLimits.list` hooks, so the
 *   org-scoped calls that 403 for guests never fire.
 * - Org members and personal context are unchanged.
 *
 * Run with:
 *   pnpm --filter web test modules/saas/payments/components/__tests__/AiUsageLimitBanner.test.tsx
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiUsageLimitBanner } from "../AiUsageLimitBanner";

const orgContextMock = vi.fn();
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => orgContextMock(),
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
	orgContextMock.mockReturnValue({ organizationId: "org-1" });
	guestMock.mockReturnValue(false);
	statusHookMock.mockReturnValue({ data: undefined });
	listHookMock.mockReturnValue({ data: undefined });
});

describe("AiUsageLimitBanner tenant scoping", () => {
	it("org member → status and list hooks receive the org id", () => {
		render(<AiUsageLimitBanner />);

		expect(statusHookMock).toHaveBeenCalledWith("org-1");
		expect(listHookMock).toHaveBeenCalledWith("org-1");
	});

	it("guest in host org → hooks receive explicit null (personal scope), never the org id", () => {
		guestMock.mockReturnValue(true);

		render(<AiUsageLimitBanner />);

		expect(statusHookMock).toHaveBeenCalledWith(null);
		expect(listHookMock).toHaveBeenCalledWith(null);
		expect(statusHookMock).not.toHaveBeenCalledWith("org-1");
		expect(listHookMock).not.toHaveBeenCalledWith("org-1");
	});

	it("personal context → hooks receive null (unchanged)", () => {
		orgContextMock.mockReturnValue({ organizationId: null });

		render(<AiUsageLimitBanner />);

		expect(statusHookMock).toHaveBeenCalledWith(null);
		expect(listHookMock).toHaveBeenCalledWith(null);
	});

	it("guest with a crossed personal limit → manage CTA routes to the PERSONAL settings page", () => {
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
							name: "Personal limit",
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
			"/app/settings/usage?limitId=limit-1",
		);
	});
});
