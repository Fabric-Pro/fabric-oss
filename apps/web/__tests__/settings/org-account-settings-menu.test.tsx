/**
 * Fizzy #1875 (R7/R8/R9): account security and notification settings must be
 * reachable from an ORGANIZATION, not only from the personal route tree.
 *
 * The order assertion is the load-bearing one. `SettingsMenu` renders its
 * compact sidebar header from `menuItems[0].title` / `.avatar`, so an account
 * group placed FIRST would head an organization-owned page with the signed-in
 * user's own name and avatar. Appending is what keeps the header honest.
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/config", () => ({
	config: {
		organizations: { enable: true, enableBilling: false },
		users: { enableBilling: false },
		storage: { bucketNames: { avatars: "avatars" } },
		auth: { enableTwoFactor: true },
		ui: { saas: { useSidebarLayout: true } },
	},
}));

vi.mock("@repo/auth/lib/helper", () => ({
	isOrganizationAdmin: () => false,
}));

const getSession = vi.fn();
const getActiveOrganization = vi.fn();
const isGuestInOrg = vi.fn();

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => getSession(),
	getActiveOrganization: (slug: string) => getActiveOrganization(slug),
	isGuestInOrg: (userId: string, orgId: string) =>
		isGuestInOrg(userId, orgId),
}));

vi.mock("@saas/settings/lib/deployment-admin", () => ({
	isDeploymentAdminEmail: () => false,
}));

vi.mock("@saas/settings/lib/user-activity-flag", () => ({
	isUserActivityDashboardEnabled: () => false,
}));

vi.mock("@saas/organizations/components/OrganizationLogo", () => ({
	OrganizationLogo: ({ name }: { name: string }) => (
		<span data-testid="org-logo">{name}</span>
	),
}));

vi.mock("@saas/mcp/components/McpLogo", () => ({
	McpLogo: () => <span />,
}));

vi.mock("@saas/settings/components/OrgSettingsLayoutClient", () => ({
	OrgSettingsLayoutClient: ({ children }: { children: ReactNode }) => (
		<>{children}</>
	),
}));

vi.mock("next/navigation", () => ({
	redirect: (to: string) => {
		throw new Error(`redirect:${to}`);
	},
	usePathname: () => "/app/example-org/settings/general",
}));

vi.mock("next-intl/server", () => ({
	getTranslations: async () => (key: string) => {
		const copy: Record<string, string> = {
			"settings.menu.account.title": "Account",
			"settings.menu.account.security": "Security",
			"settings.menu.organization.general": "General",
			"settings.menu.organization.members": "Members",
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

import OrgSettingsLayout from "../../app/(saas)/app/(organizations)/[organizationSlug]/settings/layout";

type MenuGroup = {
	title: string;
	items: { title: string; href: string }[];
};

async function buildMenu(): Promise<MenuGroup[]> {
	const element = (await OrgSettingsLayout({
		children: null,
		params: Promise.resolve({ organizationSlug: "example-org" }),
	})) as React.ReactElement<{
		children: React.ReactElement<{ menuItems: MenuGroup[] }>;
	}>;

	return element.props.children.props.menuItems;
}

describe("organization settings menu — account group", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getSession.mockResolvedValue({
			user: {
				id: "user-1",
				name: "Example Member",
				email: "dev@example.com",
				image: null,
			},
		});
		getActiveOrganization.mockResolvedValue({
			id: "org-1",
			name: "Example Org",
			slug: "example-org",
			logo: null,
			members: [],
		});
		isGuestInOrg.mockResolvedValue(false);
	});

	it("offers security and notifications from organization context", async () => {
		const menuItems = await buildMenu();
		const hrefs = menuItems.flatMap((group) =>
			group.items.map((item) => item.href),
		);

		expect(hrefs).toContain("/app/example-org/settings/account/security");
		expect(hrefs).toContain(
			"/app/example-org/settings/account/notifications",
		);
	});

	it("offers the member's own AI providers, which they can edit without being an admin", async () => {
		// `isOrganizationAdmin` is mocked false for this whole file — the entry
		// must be there anyway. It is the destination the "AI provider
		// required" notice sends a member who cannot touch the organization's
		// own providers (Fizzy #1875, R12/AE7), so hiding it from non-admins
		// would leave that notice pointing at nothing again.
		const menuItems = await buildMenu();
		const hrefs = menuItems.flatMap((group) =>
			group.items.map((item) => item.href),
		);

		expect(hrefs).toContain(
			"/app/example-org/settings/account/ai-providers",
		);
	});

	it("does not reuse the organization page's label for the account one", async () => {
		// Two links with the same accessible name pointing at different pages
		// — one editable by this member, one read-only for them — is exactly
		// the ambiguity this notice's remedy cannot afford.
		const menuItems = await buildMenu();
		const orgProviders = menuItems[0].items.find(
			(item) => item.href === "/app/example-org/settings/ai-providers",
		);
		const accountProviders = menuItems[1].items.find(
			(item) =>
				item.href === "/app/example-org/settings/account/ai-providers",
		);

		expect(orgProviders?.title).toBe("AI Providers");
		expect(accountProviders?.title).toBe("Personal AI Providers");
	});

	it("appends the account group AFTER the organization's own group", async () => {
		const menuItems = await buildMenu();

		expect(menuItems).toHaveLength(2);
		// menuItems[0] drives the sidebar header — it must stay the org.
		expect(menuItems[0].title).toBe("Example Org");
		expect(menuItems[1].title).toBe("Account");
		// Five now, not two. The personal settings tree is gone, so the
		// account-global pages that lived only there — the profile, account
		// deletion, and the member's own AI provider keys — moved here with the
		// other two. Each would have collided with an organization page of the
		// same slug at the top level, which is why the whole group is nested
		// under `account/`.
		expect(menuItems[1].items.map((item) => item.title)).toEqual([
			"settings.menu.account.general",
			"Security",
			"Notifications",
			"Personal AI Providers",
			"settings.menu.account.dangerZone",
		]);
	});

	it("renders both entries as links a member can click", async () => {
		render(
			(await OrgSettingsLayout({
				children: null,
				params: Promise.resolve({ organizationSlug: "example-org" }),
			})) as React.ReactElement,
		);

		expect(
			screen
				.getAllByRole("link", { name: "Security" })
				.map((link) => link.getAttribute("href")),
		).toContain("/app/example-org/settings/account/security");
		expect(
			screen
				.getAllByRole("link", { name: "Notifications" })
				.map((link) => link.getAttribute("href")),
		).toContain("/app/example-org/settings/account/notifications");
	});

	it("keeps the sidebar header showing the organization, not the user", async () => {
		render(
			(await OrgSettingsLayout({
				children: null,
				params: Promise.resolve({ organizationSlug: "example-org" }),
			})) as React.ReactElement,
		);

		expect(screen.getAllByText("Example Org").length).toBeGreaterThan(0);
		// The signed-in user's name must not head an organization-owned page.
		expect(screen.queryByTitle("Example Member")).toBeNull();
	});
});
