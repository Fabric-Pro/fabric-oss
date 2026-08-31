/**
 * Fizzy #1875 (R7/R8): the user menu hid its account-settings entry whenever
 * the app was in organization context, which — together with the sidebar doing
 * the same — left an organization member with no way to reach their own
 * account settings at all.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const organizationContext = { isOrgContext: true };

vi.mock("@repo/config", () => ({
	config: {
		auth: { redirectAfterLogout: "/" },
		organizations: { hideOrganization: false },
		storage: { bucketNames: { avatars: "avatars" } },
	},
}));

vi.mock("@repo/auth/client", () => ({
	authClient: { signOut: vi.fn() },
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: {
			id: "user-1",
			name: "Example Member",
			email: "dev@example.com",
			image: null,
			role: "user",
		},
	}),
}));

vi.mock("@saas/organizations/hooks", () => ({
	useContextPath: (path: string) =>
		organizationContext.isOrgContext
			? `/app/example-org/${path}`
			: `/app/${path}`,
	useOrganizationContext: () => organizationContext,
}));

vi.mock("@saas/meeting-digest/lib/personal-insights-cache", () => ({
	purgeUser: vi.fn(),
}));

vi.mock("@saas/shared/components/ColorModeToggle", () => ({
	ColorModeToggle: () => null,
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => {
		const copy: Record<string, string> = {
			"app.userMenu.accountSettings": "Account settings",
			"app.menu.organizationSettings": "Organization settings",
			"app.userMenu.colorMode": "Color mode",
			"app.userMenu.home": "Home",
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

import { UserMenu } from "../../../../modules/saas/shared/components/UserMenu";

async function openMenu() {
	render(<UserMenu />);
	await userEvent.click(screen.getByRole("button", { name: "User menu" }));
}

describe("UserMenu account settings entry", () => {
	beforeEach(() => {
		organizationContext.isOrgContext = true;
	});

	it("offers account settings in organization context, alongside org settings", async () => {
		await openMenu();

		expect(
			screen
				.getByRole("menuitem", { name: "Account settings" })
				.getAttribute("href"),
		).toBe("/app/settings/general");
		expect(
			screen
				.getByRole("menuitem", { name: "Organization settings" })
				.getAttribute("href"),
		).toBe("/app/example-org/settings/general");
	});

	it("still offers account settings in personal context", async () => {
		organizationContext.isOrgContext = false;
		await openMenu();

		expect(
			screen
				.getByRole("menuitem", { name: "Account settings" })
				.getAttribute("href"),
		).toBe("/app/settings/general");
		expect(
			screen.queryByRole("menuitem", { name: "Organization settings" }),
		).toBeNull();
	});
});
