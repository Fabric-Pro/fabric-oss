/**
 * The To Do entry in the sidebar (Fizzy #2340).
 *
 * `TODO_LIST` is a Rollout gate, not a Kill switch: off, the capability is
 * ABSENT. Not present and empty, not present and disabled — absent. The
 * backend half already behaves that way (`todos.list` answers NOT_FOUND for an
 * organization that is not enrolled), and a sidebar entry rendered against a
 * gate its backend does not honour is the shape of an outage rather than of a
 * feature that is simply not on yet.
 *
 * So both directions are pinned here. The "off" case fails if the entry is
 * ever softened into a disabled row; the "on" case fails if the gate is
 * tightened into something an enrolled organization cannot pass.
 */

import type { FeatureFlagKey } from "@repo/utils/feature-flag-registry";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const organizationContext = {
	basePath: "/app/example-org",
	isOrgContext: true,
};
let flags: Partial<Record<FeatureFlagKey, boolean>> = {};

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
	useContextPath: (path: string) => `${organizationContext.basePath}/${path}`,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => organizationContext,
	useAccountBasePath: () => "/app/example-org",
	useAccountPath: (path: string) => `/app/example-org/${path}`,
}));

vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => false,
}));

vi.mock("@saas/projects/hooks/use-project-shortcuts", () => ({
	useProjectShortcuts: () => [],
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: FeatureFlagKey) => flags[key] ?? false,
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

/** next-intl is echoed globally by vitest.setup.ts, so labels ARE their keys. */
const TODO_LABEL = "app.menu.todos";
const TODO_HREF = "/app/example-org/todos";

const todoLinks = () =>
	screen
		.queryAllByRole("link", { name: new RegExp(TODO_LABEL) })
		.map((link) => link.getAttribute("href"));

beforeEach(() => {
	flags = {};
});

describe("NavBar — the To Do entry is gated on TODO_LIST", () => {
	it("renders no To Do entry at all when the flag is off", () => {
		render(<NavBar />);

		expect(todoLinks()).toHaveLength(0);
		// Not a disabled row, not an empty shell, not a tooltip promising it
		// later — nothing bearing the label exists.
		expect(screen.queryByText(TODO_LABEL)).toBeNull();
		expect(
			document.querySelector('[data-onboarding-target="nav-todos"]'),
		).toBeNull();
		// Nothing else in the sidebar points at the route either.
		for (const link of screen.queryAllByRole("link")) {
			expect(link.getAttribute("href")).not.toContain("/todos");
		}
	});

	it("renders the entry, pointing at the workspace's To Do page, when on", () => {
		flags = { TODO_LIST: true };
		render(<NavBar />);

		const hrefs = todoLinks();
		expect(hrefs.length).toBeGreaterThan(0);
		// The desktop rail and the mobile drawer each render the list once, so
		// the assertion is on the destination, not on the count.
		expect(new Set(hrefs)).toEqual(new Set([TODO_HREF]));
	});

	it("carries the onboarding anchor the tour and the drawer point at", () => {
		// The drift guard only proves the literal id is in this file's SOURCE.
		// This proves it reaches the DOM — on the live, flag-on nav item.
		flags = { TODO_LIST: true };
		render(<NavBar />);

		const anchored = document.querySelectorAll(
			'[data-onboarding-target="nav-todos"]',
		);
		expect(anchored.length).toBeGreaterThan(0);
		for (const element of anchored) {
			expect(element.getAttribute("href")).toBe(TODO_HREF);
		}
	});
});
