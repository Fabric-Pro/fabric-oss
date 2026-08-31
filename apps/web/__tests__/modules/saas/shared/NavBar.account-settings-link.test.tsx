/**
 * Fizzy #1875 (R7/R8): the sidebar's account entry and its organization entry
 * used to be mutually exclusive, so an organization member had no route to
 * their own account settings from anywhere in the chrome.
 *
 * The guest case is the other half. `treatAsPersonal = isGuest || !isOrgContext`
 * exists so a project-only guest is shown the PERSONAL chrome and the host
 * organization is never named or linked in it — adding an account link must not
 * smuggle an organization link in with it.
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const organizationContext = {
	basePath: "/app/example-org",
	isOrgContext: true,
};
let isGuest = false;

vi.mock("@repo/config", () => ({
	config: {
		ui: { saas: { useSidebarLayout: true } },
		auth: { redirectAfterLogout: "/" },
		organizations: { enable: true, hideOrganization: false },
		users: { enableBilling: false },
		prompts: { enabled: false },
		storage: { bucketNames: { avatars: "avatars" } },
	},
}));

vi.mock("@repo/auth/client", () => ({
	authClient: { signOut: vi.fn() },
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "user-1", name: "Example Member", image: null },
	}),
}));

vi.mock("@saas/organizations/hooks", () => ({
	useContextPath: (path: string) =>
		organizationContext.isOrgContext
			? `${organizationContext.basePath}/${path}`
			: `/app/${path}`,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => organizationContext,
	// Mirrors the real rule: the URL's organization when it is one of the
	// caller's, and otherwise their own — which for a guest it never is.
	useAccountBasePath: () => (isGuest ? "/app/own-org" : "/app/example-org"),
	useAccountPath: (path: string) =>
		`${isGuest ? "/app/own-org" : "/app/example-org"}/${path}`,
}));

vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => isGuest,
}));

vi.mock("@saas/projects/hooks/use-project-shortcuts", () => ({
	useProjectShortcuts: () => [],
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@saas/shared/contexts/SidebarCollapseContext", () => ({
	useSidebarCollapse: () => ({
		isCollapsed: false,
		toggleCollapsed: vi.fn(),
	}),
}));

vi.mock("@saas/meeting-digest/lib/personal-insights-cache", () => ({
	purgeUser: vi.fn(),
}));

vi.mock("@saas/jobs/components/JobHubButton", () => ({
	JobHubButton: () => null,
}));

vi.mock("@saas/notifications/components/NotificationBell", () => ({
	NotificationBell: () => null,
}));

vi.mock("@saas/shared/components/IncidentRailIndicator", () => ({
	IncidentRailIndicator: () => null,
}));

vi.mock("@saas/get-started/components/GetStartedPointer", () => ({
	GetStartedPointer: () => null,
}));

vi.mock("@saas/shared/components/UserMenu", () => ({
	UserMenu: () => null,
}));

vi.mock("@saas/organizations/components/OrganizationSelect", () => ({
	// Note the spelling: the live export is misspelled `OrganzationSelect`.
	OrganzationSelect: () => <div data-testid="org-select" />,
}));

vi.mock("next/navigation", () => ({
	usePathname: () => "/app/example-org",
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => {
		const copy: Record<string, string> = {
			"app.userMenu.accountSettings": "Account settings",
			"app.menu.organizationSettings": "Organization settings",
			"app.userMenu.logout": "Logout",
		};
		return copy[key] ?? key;
	},
}));

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		...rest
	}: {
		children: ReactNode;
		href: string;
	}) => (
		<a href={href} {...rest}>
			{children}
		</a>
	),
}));

import { NavBar } from "../../../../modules/saas/shared/components/NavBar";

const hrefsFor = (name: string) =>
	screen
		.queryAllByRole("link", { name: new RegExp(name, "i") })
		.map((link) => link.getAttribute("href"));

describe("NavBar account utilities", () => {
	beforeEach(() => {
		organizationContext.basePath = "/app/example-org";
		organizationContext.isOrgContext = true;
		isGuest = false;
	});

	it("offers an account-settings link in organization context", () => {
		render(<NavBar />);

		// The organization entry is still there …
		expect(hrefsFor("Organization settings")).toContain(
			"/app/example-org/settings/general",
		);
		// … and the account's own settings are now reachable alongside it.
		expect(hrefsFor("Account settings")).toContain(
			"/app/example-org/settings/account/profile",
		);
	});

	// This used to assert the opposite, on the reasoning that there was no
	// organization-rooted profile page to point at. There is one now — the
	// personal settings tree was replaced by `settings/account/*` inside an
	// organization — so the link resolves there and leaves nothing personal.
	it("roots the account link inside an organization", () => {
		render(<NavBar />);

		expect(hrefsFor("Account settings")).not.toContain(
			"/app/settings/general",
		);
		expect(hrefsFor("Account settings")).toContain(
			"/app/example-org/settings/account/profile",
		);
	});

	it("still offers the account link with no org in the URL", () => {
		organizationContext.isOrgContext = false;
		organizationContext.basePath = "/app";
		render(<NavBar />);

		expect(hrefsFor("Account settings")).toContain(
			"/app/example-org/settings/account/profile",
		);
		expect(hrefsFor("Organization settings")).toHaveLength(0);
	});

	it("gives a guest their OWN org's chrome with no link to the host", () => {
		isGuest = true;
		render(<NavBar />);

		expect(hrefsFor("Account settings")).toContain(
			"/app/own-org/settings/account/profile",
		);
		// No organization entry, and no href rooted at the host organization.
		expect(hrefsFor("Organization settings")).toHaveLength(0);
		for (const link of screen.queryAllByRole("link")) {
			expect(link.getAttribute("href")).not.toContain("example-org");
		}
	});

	it("does not duplicate the account link for a guest", () => {
		isGuest = true;
		render(<NavBar />);

		const accountLinks = hrefsFor("Account settings").filter(
			(href) => href === "/app/own-org/settings/account/profile",
		);
		// The mobile drawer and the desktop rail each render the list once.
		expect(new Set(accountLinks).size).toBe(1);
		expect(accountLinks.length).toBeLessThanOrEqual(2);
	});
});
