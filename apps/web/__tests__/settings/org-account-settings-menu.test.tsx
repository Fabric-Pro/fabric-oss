/**
 * Fizzy #1875 (R7/R8/R9): account security and notification settings must be
 * reachable from an ORGANIZATION, not only from the personal route tree.
 *
 * The order assertion is the load-bearing one. `SettingsMenu` renders its
 * compact sidebar header from `menuItems[0].title` / `.avatar`, so an account
 * group placed FIRST would head an organization-owned page with the signed-in
 * user's own name and avatar. Appending is what keeps the header honest.
 *
 * Also pins the first menu entry gated by a database feature flag: Company
 * context (Fizzy #2719) appears only while `COMPANY_CONTEXT` is on for the
 * organization in the URL.
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
	// Danger Zone is gated on ownership rather than admin since Fizzy #2462 —
	// the server has always accepted owners alone, so showing the entry to an
	// admin only produced a refusal. This suite is about the ACCOUNT group, so
	// the viewer is neither.
	isOrganizationOwner: () => false,
}));

const getSession = vi.fn();
const getActiveOrganization = vi.fn();
const isGuestInOrg = vi.fn();
const isFeatureEnabled = vi.fn();

vi.mock("@repo/database", () => ({
	isFeatureEnabled: (key: string, organizationId?: string) =>
		isFeatureEnabled(key, organizationId),
}));

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
			"settings.menu.organization.companyContext": "Company context",
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
		isFeatureEnabled.mockResolvedValue(false);
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
		// The organization's pages are spread over several groups now (its own,
		// AI, Extensions, Activity); the account group is always the last one.
		const organizationGroups = menuItems.slice(0, -1);
		const accountGroup = menuItems[menuItems.length - 1];
		const orgProviders = organizationGroups
			.flatMap((group) => group.items)
			.find(
				(item) =>
					item.href === "/app/example-org/settings/ai-providers",
			);
		const accountProviders = accountGroup.items.find(
			(item) =>
				item.href === "/app/example-org/settings/account/ai-providers",
		);

		expect(orgProviders?.title).toBe("AI Providers");
		expect(accountProviders?.title).toBe("Personal AI Providers");
	});

	it("appends the account group AFTER the organization's own group", async () => {
		const menuItems = await buildMenu();
		const accountGroup = menuItems[menuItems.length - 1];

		// menuItems[0] drives the sidebar header — it must stay the org. The
		// organization's own pages are grouped (AI, Extensions, Activity), so
		// what matters is that the account group is the LAST one, after all of
		// them, not that there are exactly two.
		expect(menuItems[0].title).toBe("Example Org");
		expect(accountGroup.title).toBe("Account");
		expect(
			menuItems.slice(0, -1).some((group) => group.title === "Account"),
		).toBe(false);
		// Six now, not two. The personal settings tree is gone, so the
		// account-global pages that lived only there — the profile, account
		// deletion, and the member's own AI provider keys — moved here with the
		// other two. Each would have collided with an organization page of the
		// same slug at the top level, which is why the whole group is nested
		// under `account/`. Connected agents (the coding agents a member signed
		// in) is per person too, so it joins them, ahead of the danger zone.
		expect(accountGroup.items.map((item) => item.title)).toEqual([
			"settings.menu.account.general",
			"Security",
			"Notifications",
			"Personal AI Providers",
			"settings.menu.account.connectedAgents",
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

describe("organization settings menu — company context gate", () => {
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

	const COMPANY_CONTEXT_HREF = "/app/example-org/settings/company-context";

	it("has no Company context entry while the gate is off for the organization", async () => {
		isFeatureEnabled.mockResolvedValue(false);

		const menuItems = await buildMenu();
		const hrefs = menuItems.flatMap((group) =>
			group.items.map((item) => item.href),
		);

		expect(hrefs).not.toContain(COMPANY_CONTEXT_HREF);
		// Read for the organization in the URL, not a session default.
		expect(isFeatureEnabled).toHaveBeenCalledWith(
			"COMPANY_CONTEXT",
			"org-1",
		);
	});

	it("lists Company context in the AI group, after AI Memory, while the gate is on", async () => {
		isFeatureEnabled.mockImplementation(
			async (key: string) => key === "COMPANY_CONTEXT",
		);

		const menuItems = await buildMenu();
		const aiGroup = menuItems.find((group) => group.title === "AI");
		const aiHrefs = aiGroup?.items.map((item) => item.href) ?? [];

		expect(aiHrefs).toContain(COMPANY_CONTEXT_HREF);
		expect(aiHrefs.indexOf(COMPANY_CONTEXT_HREF)).toBe(
			aiHrefs.indexOf("/app/example-org/settings/ai-memory") + 1,
		);
		expect(
			aiGroup?.items.find((item) => item.href === COMPANY_CONTEXT_HREF)
				?.title,
		).toBe("Company context");
	});

	it("shows the entry to a member who is not an admin — the page is read-only for them, not hidden", async () => {
		// `isOrganizationAdmin` and `isOrganizationOwner` are mocked false for
		// this whole file.
		isFeatureEnabled.mockResolvedValue(true);

		const menuItems = await buildMenu();
		const hrefs = menuItems.flatMap((group) =>
			group.items.map((item) => item.href),
		);

		expect(hrefs).toContain(COMPANY_CONTEXT_HREF);
	});

	it("never reads the gate for a project guest, who is redirected first", async () => {
		isGuestInOrg.mockResolvedValue(true);
		isFeatureEnabled.mockResolvedValue(true);

		await expect(buildMenu()).rejects.toThrow("redirect:/app/example-org");
		expect(isFeatureEnabled).not.toHaveBeenCalled();
	});
});
