/**
 * Fizzy #1875 (R7/R8): `settings-security` was registered `scope: "personal"`,
 * and the drawer filters personal-scoped items out of organization context —
 * so the guide stopped mentioning account security the moment you were in an
 * organization. Now that the page has an organization-rooted home, that scope
 * value was simply wrong.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const organizationContext = {
	basePath: "/app/example-org",
	isOrgContext: true,
};

vi.mock("@repo/config", () => ({
	config: {
		prompts: { enabled: true },
		users: { enableBilling: false },
	},
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", role: "user" } }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => organizationContext,
}));

const push = vi.fn();

vi.mock("next/navigation", () => ({
	usePathname: () => "/app/example-org/settings/general",
	useRouter: () => ({ push }),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

import { GetStartedDrawer } from "../../../../modules/saas/get-started/components/GetStartedDrawer";
import { GET_STARTED_GROUPS } from "../../../../modules/saas/get-started/lib/get-started-registry";

const settingsItems = () =>
	GET_STARTED_GROUPS.find((group) => group.id === "settings")?.items ?? [];

describe("get-started drawer — account settings in organization context", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		organizationContext.isOrgContext = true;
	});

	it("no longer marks security as personal-only", () => {
		const security = settingsItems().find(
			(item) => item.id === "settings-security",
		);

		expect(security).toBeDefined();
		expect(security?.scope).toBeUndefined();
		expect(security?.href?.({ basePath: "/app/example-org" })).toBe(
			"/app/example-org/settings/security",
		);
	});

	it("registers notifications, reachable from both contexts", () => {
		const notifications = settingsItems().find(
			(item) => item.id === "settings-notifications",
		);

		expect(notifications).toBeDefined();
		expect(notifications?.scope).toBeUndefined();
		expect(notifications?.href?.({ basePath: "/app" })).toBe(
			"/app/settings/notifications",
		);
		expect(notifications?.href?.({ basePath: "/app/example-org" })).toBe(
			"/app/example-org/settings/notifications",
		);
	});

	it("shows both entries in the drawer for an organization member", async () => {
		render(
			<GetStartedDrawer
				onClose={vi.fn()}
				onStartTour={vi.fn()}
				onShowComponent={vi.fn()}
			/>,
		);

		expect(screen.getByText("Security")).toBeDefined();
		expect(screen.getByText("Notifications")).toBeDefined();
	});

	it("still shows them in personal context", async () => {
		organizationContext.isOrgContext = false;
		organizationContext.basePath = "/app";

		render(
			<GetStartedDrawer
				onClose={vi.fn()}
				onStartTour={vi.fn()}
				onShowComponent={vi.fn()}
			/>,
		);

		expect(screen.getByText("Security")).toBeDefined();
		expect(screen.getByText("Notifications")).toBeDefined();

		organizationContext.basePath = "/app/example-org";
	});

	it("opens the organization-rooted security page from the drawer", async () => {
		const onClose = vi.fn();
		render(
			<GetStartedDrawer
				onClose={onClose}
				onStartTour={vi.fn()}
				onShowComponent={vi.fn()}
			/>,
		);

		const openButtons = screen.getAllByRole("button", { name: /open/i });
		expect(openButtons.length).toBeGreaterThan(0);

		const securityRow = screen.getByText("Security").closest("li");
		expect(securityRow).not.toBeNull();
		const open = securityRow?.querySelector("button:last-of-type");
		expect(open).not.toBeNull();
		await userEvent.click(open as HTMLElement);

		expect(push).toHaveBeenCalledWith("/app/example-org/settings/security");
	});
});
