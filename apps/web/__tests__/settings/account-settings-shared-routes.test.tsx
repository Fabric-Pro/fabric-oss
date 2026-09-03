/**
 * Fizzy #1875 (R7/R8/R9/R10): the organization-side security and notification
 * routes are a ROUTING change only. They render the very same account-global
 * components as the personal routes, and no organization is threaded into
 * either — there is no per-organization copy of a password or a notification
 * preference to scope.
 *
 * The personal routes are asserted here too, because R10 requires them to keep
 * working unchanged: no redirect, no behaviour change.
 */

import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/config", () => ({
	config: {
		auth: {
			enablePasswordLogin: true,
			enableSocialLogin: false,
			enablePasskeys: false,
			enableTwoFactor: true,
		},
		prompts: { enabled: false },
		users: { enableBilling: false },
	},
}));

const getSession = vi.fn();
const getUserAccounts = vi.fn();
const getUserPasskeys = vi.fn();
const prefetchQuery = vi.fn();

vi.mock("@saas/auth/lib/server", () => ({
	getSession: (...args: unknown[]) => getSession(...args),
	getUserAccounts: (...args: unknown[]) => getUserAccounts(...args),
	getUserPasskeys: (...args: unknown[]) => getUserPasskeys(...args),
}));

vi.mock("@shared/lib/server", () => ({
	getServerQueryClient: () => ({
		prefetchQuery: (...args: unknown[]) => prefetchQuery(...args),
	}),
}));

vi.mock("next/navigation", () => ({
	redirect: (to: string) => {
		throw new Error(`redirect:${to}`);
	},
}));

vi.mock("next-intl/server", () => ({
	getTranslations: async () => (key: string) => key,
}));

// The security blocks are client components with their own network graphs;
// this test is about which surface renders, not what each block does.
vi.mock("@saas/settings/components/ChangePassword", () => ({
	ChangePasswordForm: () => <div>Change password</div>,
}));
vi.mock("@saas/settings/components/SetPassword", () => ({
	SetPasswordForm: () => <div>Set password</div>,
}));
vi.mock("@saas/settings/components/ConnectedAccountsBlock", () => ({
	ConnectedAccountsBlock: () => <div>Connected accounts</div>,
}));
vi.mock("@saas/settings/components/PasskeysBlock", () => ({
	PasskeysBlock: () => <div>Passkeys</div>,
}));
vi.mock("@saas/settings/components/TwoFactorBlock", () => ({
	TwoFactorBlock: () => <div>Two-factor authentication</div>,
}));
vi.mock("@saas/settings/components/ActiveSessionsBlock", () => ({
	ActiveSessionsBlock: () => <div>Active sessions</div>,
}));
vi.mock("@saas/settings/components/NotificationPreferencesForm", () => ({
	NotificationPreferencesForm: () => <div>Notification preferences</div>,
}));
vi.mock("@saas/settings/components/NotificationDeliveryForm", () => ({
	NotificationDeliveryForm: () => <div>Notification delivery</div>,
}));

import OrgNotificationsPage from "../../app/(saas)/app/(organizations)/[organizationSlug]/settings/account/notifications/page";
import OrgSecurityPage from "../../app/(saas)/app/(organizations)/[organizationSlug]/settings/account/security/page";
import { AccountNotificationSettings } from "../../modules/saas/settings/components/AccountNotificationSettings";
import { AccountSecuritySettings } from "../../modules/saas/settings/components/AccountSecuritySettings";
import { FeatureFlagProvider } from "../../modules/saas/shared/components/FeatureFlagProvider";

/**
 * These surfaces are React Server Components, so RTL cannot render the element
 * a route returns directly — it resolves one level first, which is exactly what
 * the server does before streaming the page.
 *
 * The provider stands in for the `(saas)/app` layout: these surfaces carry a
 * `PageHeader`, whose page-tour launcher reads a per-organization flag, and the
 * hook deliberately throws rather than defaulting when nobody supplies one.
 */
async function renderPage(page: ReactElement) {
	const Surface = page.type as (
		props: unknown,
	) => ReactElement | Promise<ReactElement>;

	return render(
		<FeatureFlagProvider value={{ PUBLISHING_SUITE: false }}>
			{await Surface(page.props)}
		</FeatureFlagProvider>,
	);
}

describe("account settings routes — account-global, inside an organization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getSession.mockResolvedValue({ user: { id: "user-1" } });
		getUserAccounts.mockResolvedValue([{ providerId: "credential" }]);
		getUserPasskeys.mockResolvedValue([]);
		prefetchQuery.mockResolvedValue(undefined);
	});

	// These asserted that both route trees rendered the same surface, which was
	// the guarantee that mattered while both existed. Only one tree does now,
	// so what is left to pin is that the organization route renders the shared
	// account-global component rather than a copy of it — a copy is how the two
	// would drift apart again if someone rebuilt the personal side.
	it("renders the shared account-security surface", async () => {
		const organization = (await OrgSecurityPage({
			searchParams: Promise.resolve({}),
		})) as ReactElement;

		expect(organization.type).toBe(AccountSecuritySettings);
	});

	it("renders the shared account-notifications surface", () => {
		const organization = OrgNotificationsPage() as ReactElement;

		expect(organization.type).toBe(AccountNotificationSettings);
	});

	it("threads no organization into either surface — they are the account's, not the tenant's", async () => {
		const security = (await OrgSecurityPage({
			searchParams: Promise.resolve({ mfaRequired: "1" }),
		})) as ReactElement;
		const notifications = OrgNotificationsPage() as ReactElement;

		// `mfaRequired` is the only prop either surface accepts; an
		// organizationId/slug here would mean per-org security settings.
		expect(Object.keys(security.props)).toEqual(["mfaRequired"]);
		expect(security.props).toEqual({ mfaRequired: true });
		expect(Object.keys(notifications.props)).toEqual([]);
	});

	it("reads account-global data with no tenant argument", async () => {
		await AccountSecuritySettings({});

		expect(getSession).toHaveBeenCalledWith();
		expect(getUserAccounts).toHaveBeenCalledWith();
		for (const call of prefetchQuery.mock.calls) {
			expect(JSON.stringify(call)).not.toContain("organization");
		}
	});

	it("shows the account security blocks for an organization member", async () => {
		await renderPage(
			(await OrgSecurityPage({
				searchParams: Promise.resolve({}),
			})) as ReactElement,
		);

		expect(screen.getByText("Security")).toBeDefined();
		expect(screen.getByText("Change password")).toBeDefined();
		expect(screen.getByText("Two-factor authentication")).toBeDefined();
		expect(screen.getByText("Active sessions")).toBeDefined();
	});

	it("shows the notification forms for an organization member", async () => {
		await renderPage(OrgNotificationsPage() as ReactElement);

		expect(screen.getByText("Notification preferences")).toBeDefined();
		expect(screen.getByText("Notification delivery")).toBeDefined();
	});

	it("renders the whole surface, not a stub of it", async () => {
		// This asserted the personal routes were untouched while both trees
		// existed. The personal tree is gone; what still needs pinning is that
		// moving these pages did not quietly drop half of what they render.
		const { unmount } = await renderPage(
			(await OrgSecurityPage({
				searchParams: Promise.resolve({}),
			})) as ReactElement,
		);
		expect(screen.getByText("Change password")).toBeDefined();
		expect(screen.getByText("Active sessions")).toBeDefined();
		unmount();

		await renderPage(OrgNotificationsPage() as ReactElement);
		expect(screen.getByText("Notification preferences")).toBeDefined();
		expect(screen.getByText("Notification delivery")).toBeDefined();
	});

	it("keeps the two-factor enforcement notice", async () => {
		// The enforcement redirect lands here with `mfaRequired`, and now lands
		// inside the organization rather than pushing the member out of it.
		await renderPage(
			(await OrgSecurityPage({
				searchParams: Promise.resolve({ mfaRequired: "1" }),
			})) as ReactElement,
		);
		expect(
			screen.getByText(
				/Your organization requires two-factor authentication/,
			),
		).toBeDefined();
	});
});
