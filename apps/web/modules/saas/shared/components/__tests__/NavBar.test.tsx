import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
});

const sessionMock = vi.fn();
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => sessionMock(),
}));

const orgContextMock = vi.fn();
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => orgContextMock(),
	// The Job Hub button in the sidebar footer polls its badge count through
	// `useTenantQuery`, which reads the active org id directly.
	useOrganizationId: () => "org-1",
	// Account-level destinations resolve to an organization the caller
	// BELONGS to, which for a guest is not the one in the URL.
	useAccountBasePath: () => "/app/own-org",
	useAccountPath: (path: string) => `/app/own-org/${path}`,
}));

const guestMock = vi.fn();
vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => guestMock(),
}));

vi.mock("@saas/organizations/hooks", () => ({
	useContextPath: () => "/app/org-1/settings/general",
}));

// Mutable so a test can exercise the collapsed rail, where the launcher has no
// visible label and the adornment has to move onto the icon.
let mockIsCollapsed = false;
vi.mock("@saas/shared/contexts/SidebarCollapseContext", () => ({
	useSidebarCollapse: () => ({
		get isCollapsed() {
			return mockIsCollapsed;
		},
		toggleCollapsed: vi.fn(),
	}),
}));

vi.mock("@repo/auth/client", () => ({
	authClient: {
		signOut: vi.fn(),
	},
}));

vi.mock("@repo/config", () => ({
	config: {
		auth: { redirectAfterLogout: "/" },
		ui: { saas: { useSidebarLayout: true } },
		organizations: { enable: true, hideOrganization: false },
		prompts: { enabled: true },
		payments: { plans: {} },
		i18n: { defaultLocale: "en", locales: { en: {} } },
	},
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
	usePathname: () => "/app/org-1/projects",
	// The Job Hub panel (mounted by the sidebar footer's button) reads the
	// route's project id to surface the current project's jobs first.
	useParams: () => ({}),
	useRouter: () => ({
		push: vi.fn(),
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@saas/mcp/components/McpLogo", () => ({
	McpLogo: () => null,
}));

vi.mock("@saas/workflows/components/TemporalLogo", () => ({
	TemporalLogo: () => null,
}));

vi.mock("@saas/notifications/components/NotificationBell", () => ({
	NotificationBell: () => null,
}));

vi.mock("@saas/shared/components/ColorModeToggle", () => ({
	ColorModeToggle: () => null,
}));

vi.mock("@saas/shared/components/FabricLogo", () => ({
	FabricLogo: () => null,
}));

vi.mock("@saas/shared/components/icons/CloudArrowLeftRightIcon", () => ({
	CloudArrowLeftRightIcon: () => null,
}));

vi.mock("@saas/shared/components/icons/FolderOpenIcon", () => ({
	FolderOpenIcon: () => null,
}));

vi.mock("@saas/shared/components/icons/PuzzleIcon", () => ({
	PuzzleIcon: () => null,
}));

vi.mock("@saas/shared/components/icons/RobotIcon", () => ({
	RobotIcon: () => null,
}));

vi.mock("@saas/shared/components/icons/SparklesIcon", () => ({
	SparklesIcon: () => null,
}));

vi.mock("@saas/shared/components/icons/Square3Stack3DIcon", () => ({
	Square3Stack3DIcon: () => null,
}));

vi.mock("@saas/shared/components/SidebarEdgeHandle", () => ({
	SidebarEdgeHandle: () => null,
}));

vi.mock("@saas/shared/components/ThemeToggle", () => ({
	ThemeToggle: () => null,
}));

vi.mock("@saas/shared/components/UserMenu", () => ({
	UserMenu: () => null,
}));

vi.mock("@saas/organizations/components/OrganizationSelect", () => ({
	OrganzationSelect: () => null,
}));

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		"aria-label": ariaLabel,
	}: {
		children: ReactNode;
		href: string;
		"aria-label"?: string;
	}) => (
		<a href={href} aria-label={ariaLabel}>
			{children}
		</a>
	),
}));

const getOnboardingState = vi.fn();
const getProjectShortcuts = vi.hoisted(() => vi.fn());

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		users: {
			onboarding: {
				getState: (...args: unknown[]) => getOnboardingState(...args),
				update: vi.fn().mockResolvedValue({ state: {} }),
			},
		},
		projects: {
			shortcuts: (...args: unknown[]) => getProjectShortcuts(...args),
		},
	},
}));

import type { FeatureFlagKey } from "@repo/utils";
import { makeOnboardingStateData } from "@saas/get-started/lib/__tests__/onboarding-state-fixtures";
import { FeatureFlagProvider } from "../FeatureFlagProvider";
import { NavBar } from "../NavBar";

/**
 * `useFeatureFlag` throws outside its provider by design, so every render here
 * must supply one — a forgotten provider would otherwise be indistinguishable
 * from a disabled feature. Both #1694 flags default to off, matching production.
 *
 * `UNIFIED_AGENT_INTERFACE` defaults to ON, also matching production — it is
 * the registry's one default-on entry, a rollback lever rather than an opt-in.
 */
function renderNavBar(flags: Partial<Record<FeatureFlagKey, boolean>> = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	return render(
		<QueryClientProvider client={client}>
			<FeatureFlagProvider
				value={
					{
						PROJECT_SHORTCUTS: false,
						PROJECT_FAVORITES: false,
						UNIFIED_AGENT_INTERFACE: true,
						...flags,
					} as Record<FeatureFlagKey, boolean>
				}
			>
				<NavBar />
			</FeatureFlagProvider>
		</QueryClientProvider>,
	);
}

// jsdom has no layout engine, so `getClientRects()` is always empty and
// `checkVisibility` does not exist — `isAnchorOnScreen` would report every
// anchor off screen. Model "on screen" explicitly; the off-screen cases
// override this per test.
function stubOnScreen() {
	vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
		{ width: 120, height: 24 },
	] as unknown as DOMRectList);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		top: 100,
		left: 0,
		right: 120,
		bottom: 124,
		width: 120,
		height: 24,
	} as DOMRect);
}

beforeEach(() => {
	vi.clearAllMocks();
	stubOnScreen();
	mockIsCollapsed = false;
});

describe("NavBar — guest sidebar hygiene", () => {
	function setupGuestOrgContext() {
		sessionMock.mockReturnValue({
			user: { id: "u-1", email: "guest@example.test", role: "user" },
		});
		orgContextMock.mockReturnValue({
			basePath: "/app/org-1",
			isOrgContext: true,
			organizationId: "org-1",
		});
		guestMock.mockReturnValue(true);
	}

	function setupNonGuestOrgContext() {
		sessionMock.mockReturnValue({
			user: { id: "u-1", email: "member@example.test", role: "user" },
		});
		orgContextMock.mockReturnValue({
			basePath: "/app/org-1",
			isOrgContext: true,
			organizationId: "org-1",
		});
		guestMock.mockReturnValue(false);
	}

	function setupPersonalContext() {
		sessionMock.mockReturnValue({
			user: { id: "u-1", email: "personal@example.test", role: "user" },
		});
		orgContextMock.mockReturnValue({
			basePath: "/app",
			isOrgContext: false,
			organizationId: null,
		});
		guestMock.mockReturnValue(false);
	}

	// Guests get the SAME nav as their personal workspace — the switcher
	// names their OWN organization for them, so every item below it must be
	// personal item rooted at /app, never the host org's basePath.
	it("roots the guest's nav in their OWN org, never the host's", () => {
		setupGuestOrgContext();
		renderNavBar();

		const expectedItems: Array<[RegExp, string]> = [
			[/app\.menu\.start/, "/app/own-org"],
			// The chat entry points at the unified agent interface; Nexus is
			// retired into it and /nexus redirects there (#2040).
			[/app\.menu\.aiChatbot/, "/app/own-org/agents/fabric-ai"],
			[/app\.menu\.prompts/, "/app/own-org/prompts"],
			[/^Projects$/, "/app/own-org/projects"],
			[/AI Agents/, "/app/own-org/agents"],
			[/^Skills$/, "/app/own-org/skills"],
			[/^Templates$/, "/app/own-org/agent-templates"],
			[/^Workflows$/, "/app/own-org/workflows"],
			[/^Integrations$/, "/app/own-org/settings/integrations"],
			[/^Workspaces$/, "/app/own-org/workspaces"],
			[/MCP Servers/, "/app/own-org/mcp-servers"],
			[/^Reports$/, "/app/own-org/report-templates"],
		];
		for (const [name, href] of expectedItems) {
			const links = screen.getAllByRole("link", { name });
			expect(links.length).toBeGreaterThan(0);
			for (const link of links) {
				expect(link).toHaveAttribute("href", href);
			}
		}
	});

	// The guarantee this whole branch exists to protect, asserted directly
	// rather than inferred from the table above: whatever the guest's nav
	// points at, none of it is the organization they are looking at.
	it("puts no host-org link anywhere in the guest's nav", () => {
		setupGuestOrgContext();
		renderNavBar();

		for (const link of screen.getAllByRole("link")) {
			expect(link.getAttribute("href") ?? "").not.toContain("/app/org-1");
		}
	});

	// Guests must never be routed into (or shown) the host org's chrome —
	// their Projects item points at the PERSONAL projects list, which hosts
	// the "Shared with me" section.
	it("points the guest Projects item at their own org's projects route", () => {
		setupGuestOrgContext();
		renderNavBar();

		const projects = screen.getAllByRole("link", { name: /^Projects$/ });
		expect(projects.length).toBeGreaterThan(0);
		for (const link of projects) {
			expect(link).toHaveAttribute("href", "/app/own-org/projects");
		}
	});

	it("keeps the member Projects item org-scoped (regression guard)", () => {
		setupNonGuestOrgContext();
		renderNavBar();

		const projects = screen.getAllByRole("link", { name: /^Projects$/ });
		expect(projects.length).toBeGreaterThan(0);
		for (const link of projects) {
			expect(link).toHaveAttribute("href", "/app/org-1/projects");
		}
	});

	it("shows account settings (not organization settings) for project-only guests in an org", () => {
		setupGuestOrgContext();
		renderNavBar();

		expect(
			screen.queryAllByText("app.menu.organizationSettings"),
		).toHaveLength(0);
		const accountLinks = screen.getAllByRole("link", {
			name: /app\.userMenu\.accountSettings/,
		});
		expect(accountLinks.length).toBeGreaterThan(0);
		for (const link of accountLinks) {
			expect(link).toHaveAttribute(
				"href",
				"/app/own-org/settings/account/profile",
			);
		}
		// Logout is still present
		expect(
			screen.getAllByText("app.userMenu.logout").length,
		).toBeGreaterThan(0);
	});

	it("renders Start, Projects, and Organization settings for non-guest members in an org (regression guard)", () => {
		setupNonGuestOrgContext();
		renderNavBar();

		expect(screen.getAllByText("app.menu.start").length).toBeGreaterThan(0);
		expect(
			screen.getAllByRole("link", { name: /^Projects$/ }).length,
		).toBeGreaterThan(0);
		expect(
			screen.getAllByText("app.menu.organizationSettings").length,
		).toBeGreaterThan(0);
	});

	it("renders the account-settings utility in personal (non-org) context regardless of guest status", () => {
		setupPersonalContext();
		renderNavBar();

		expect(
			screen.getAllByText("app.userMenu.accountSettings").length,
		).toBeGreaterThan(0);
	});
});

describe("NavBar — admin link stays in the current workspace", () => {
	function setupAdminInOrg() {
		sessionMock.mockReturnValue({
			user: { id: "u-1", email: "admin@example.test", role: "admin" },
		});
		orgContextMock.mockReturnValue({
			basePath: "/app/org-1",
			isOrgContext: true,
			organizationId: "org-1",
		});
		guestMock.mockReturnValue(false);
	}

	function setupAdminInPersonal() {
		sessionMock.mockReturnValue({
			user: { id: "u-1", email: "admin@example.test", role: "admin" },
		});
		orgContextMock.mockReturnValue({
			basePath: "/app",
			isOrgContext: false,
			organizationId: null,
		});
		guestMock.mockReturnValue(false);
	}

	// The active workspace is derived purely from the URL slug, so a slug-less
	// `/app/admin` Admin link would flip the selector to "Personal". The link
	// must carry the current workspace base.
	it("points the Admin link at the org-scoped admin route in org context", () => {
		setupAdminInOrg();
		renderNavBar();

		const adminLinks = screen.getAllByRole("link", {
			name: /app\.menu\.admin/,
		});
		expect(adminLinks.length).toBeGreaterThan(0);
		for (const link of adminLinks) {
			expect(link).toHaveAttribute("href", "/app/org-1/admin");
		}
	});

	it("points the Admin link at the caller's own org outside org context", () => {
		setupAdminInPersonal();
		renderNavBar();

		const adminLinks = screen.getAllByRole("link", {
			name: /app\.menu\.admin/,
		});
		expect(adminLinks.length).toBeGreaterThan(0);
		for (const link of adminLinks) {
			expect(link).toHaveAttribute("href", "/app/own-org/admin");
		}
	});

	// A guest's presented workspace IS personal, so even a system admin who
	// is only a guest in the org gets the personal admin route.
	it("points the Admin link at their own org for guest admins in an org", () => {
		sessionMock.mockReturnValue({
			user: { id: "u-1", email: "admin@example.test", role: "admin" },
		});
		orgContextMock.mockReturnValue({
			basePath: "/app/org-1",
			isOrgContext: true,
			organizationId: "org-1",
		});
		guestMock.mockReturnValue(true);
		renderNavBar();

		const adminLinks = screen.getAllByRole("link", {
			name: /app\.menu\.admin/,
		});
		expect(adminLinks.length).toBeGreaterThan(0);
		for (const link of adminLinks) {
			expect(link).toHaveAttribute("href", "/app/own-org/admin");
		}
	});

	it("omits the Admin link entirely for non-admin users", () => {
		sessionMock.mockReturnValue({
			user: { id: "u-2", email: "member@example.test", role: "user" },
		});
		orgContextMock.mockReturnValue({
			basePath: "/app/org-1",
			isOrgContext: true,
			organizationId: "org-1",
		});
		guestMock.mockReturnValue(false);
		renderNavBar();

		expect(
			screen.queryAllByRole("link", { name: /app\.menu\.admin/ }),
		).toHaveLength(0);
	});
});

/**
 * "Get started" launcher pointer — the launcher itself must be
 * untouched (R2) and only it may carry the marker.
 */
describe("NavBar — Get started launcher pointer", () => {
	const MARKER = "onboarding.tour.pointer.badge";
	const LAUNCHER = "onboarding.tour.launcher";

	function setupUser() {
		sessionMock.mockReturnValue({
			user: { id: "u-1", email: "personal@example.test", role: "user" },
		});
		orgContextMock.mockReturnValue({
			basePath: "/app",
			isOrgContext: false,
			organizationId: null,
		});
		guestMock.mockReturnValue(false);
	}

	it("marks the launcher for an eligible user", async () => {
		setupUser();
		getOnboardingState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		renderNavBar();

		expect(await screen.findAllByText(MARKER)).not.toHaveLength(0);
	});

	it("leaves the launcher unmarked for an ineligible user", async () => {
		setupUser();
		getOnboardingState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: false }),
		);
		renderNavBar();

		expect(await screen.findAllByText(LAUNCHER)).not.toHaveLength(0);
		expect(screen.queryByText(MARKER)).not.toBeInTheDocument();
	});

	it("keeps the launcher's own label and click behaviour (R2)", async () => {
		setupUser();
		getOnboardingState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		const onOpen = vi.fn();
		window.addEventListener("get-started:open", onOpen);
		renderNavBar();

		const launchers = await screen.findAllByText(LAUNCHER);
		const button = launchers[0].closest("button");
		expect(button).not.toBeNull();
		button?.click();
		expect(onOpen).toHaveBeenCalled();
		window.removeEventListener("get-started:open", onOpen);
	});

	it("marks only the launcher, not the other account utilities", async () => {
		setupUser();
		getOnboardingState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
		renderNavBar();

		const markers = await screen.findAllByText(MARKER);
		for (const marker of markers) {
			expect(marker.closest("button, a")?.textContent).toContain(
				LAUNCHER,
			);
		}
	});
});

/**
 * The "New" chip has to live in two places: beside the label when there is one,
 * and over the icon when there is not. Overlaying it in the expanded sidebar
 * lands it on top of the label.
 */
describe("NavBar — where the pointer's badge sits", () => {
	const NEW = "onboarding.tour.pointer.newLabel";
	const LAUNCHER = "onboarding.tour.launcher";

	function setupEligible() {
		sessionMock.mockReturnValue({
			user: { id: "u-1", email: "personal@example.test", role: "user" },
		});
		orgContextMock.mockReturnValue({
			basePath: "/app",
			isOrgContext: false,
			organizationId: null,
		});
		guestMock.mockReturnValue(false);
		getOnboardingState.mockResolvedValue(
			makeOnboardingStateData({ eligibleForPointer: true }),
		);
	}

	it("trails the label when the sidebar is expanded", async () => {
		setupEligible();
		renderNavBar();

		const badge = (await screen.findAllByText(NEW))[0];
		const row = badge.closest("button");
		expect(row).not.toBeNull();
		// The label renders, and the badge is not nested inside the icon wrapper.
		expect(row?.textContent).toContain(LAUNCHER);
		expect(badge.closest("span.relative")).toBeNull();
	});

	it("falls back to a dot in the collapsed rail, where the word would be clipped", async () => {
		mockIsCollapsed = true;
		setupEligible();
		renderNavBar();

		// The marker only renders once the onboarding state resolves.
		await waitFor(() => {
			const launcher = screen
				.getAllByRole("button")
				.find((b) =>
					(b.getAttribute("aria-label") || "").includes(LAUNCHER),
				);
			expect(
				launcher?.querySelector("span.rounded-full.bg-primary"),
			).not.toBeNull();
			// The 72px rail is `overflow-hidden` around a centred 19px icon, so
			// a text chip would be cut off at its edge.
			expect(launcher?.textContent).not.toContain(NEW);
		});
	});

	it("keeps the launcher's accessible name in the collapsed rail", async () => {
		mockIsCollapsed = true;
		setupEligible();
		renderNavBar();

		// `aria-label` replaces the name computed from contents when collapsed,
		// so the marker's meaning has to be folded into it.
		await waitFor(() => {
			const labelled = screen
				.getAllByRole("button")
				.filter((b) =>
					(b.getAttribute("aria-label") || "").includes(LAUNCHER),
				);
			expect(labelled.length).toBeGreaterThan(0);
			expect(labelled[0].getAttribute("aria-label")).toContain(
				"onboarding.tour.pointer.badge",
			);
		});
	});
});

// #1694 — quick-access project shortcuts beneath the Projects item.
describe("NavBar — project shortcuts sub-nav", () => {
	function setupMember() {
		sessionMock.mockReturnValue({
			user: { id: "u-1", email: "member@example.test", role: "user" },
		});
		orgContextMock.mockReturnValue({
			basePath: "/app/org-1",
			isOrgContext: true,
			organizationId: "org-1",
		});
		guestMock.mockReturnValue(false);
		getOnboardingState.mockResolvedValue(makeOnboardingStateData());
	}

	function shortcut(
		id: string,
		name: string,
		extra: { isFavorite?: boolean; organizationSlug?: string | null } = {},
	) {
		return {
			id,
			name,
			organizationSlug: extra.organizationSlug ?? "org-1",
			isFavorite: extra.isFavorite ?? false,
		};
	}

	it("renders no shortcuts and issues no request while the flag is off", async () => {
		setupMember();
		getProjectShortcuts.mockResolvedValue({
			shortcuts: [shortcut("p1", "Atlas")],
		});

		renderNavBar();

		await waitFor(() => {
			expect(
				screen.getAllByRole("link", { name: /^Projects$/ }).length,
			).toBeGreaterThan(0);
		});
		expect(screen.queryByRole("link", { name: /Atlas/ })).toBeNull();
		// Gating only the render would still pay for the fetch.
		expect(getProjectShortcuts).not.toHaveBeenCalled();
	});

	it("renders one entry per shortcut when the flag is on", async () => {
		setupMember();
		getProjectShortcuts.mockResolvedValue({
			shortcuts: [
				shortcut("p1", "Atlas"),
				shortcut("p2", "Borealis"),
				shortcut("p3", "Cinder"),
			],
		});

		renderNavBar({ PROJECT_SHORTCUTS: true });

		await waitFor(() => {
			expect(
				screen.getAllByRole("link", { name: /Atlas/ }).length,
			).toBeGreaterThan(0);
		});
		for (const name of [/Atlas/, /Borealis/, /Cinder/]) {
			const links = screen.getAllByRole("link", { name });
			expect(links.length).toBeGreaterThan(0);
			expect(links[0]).toHaveAttribute(
				"href",
				expect.stringContaining("/projects/"),
			);
		}
	});

	it("renders nothing extra when the caller has no shortcuts", async () => {
		setupMember();
		getProjectShortcuts.mockResolvedValue({ shortcuts: [] });

		renderNavBar({ PROJECT_SHORTCUTS: true });

		await waitFor(() => {
			expect(getProjectShortcuts).toHaveBeenCalled();
		});
		const projects = screen.getAllByRole("link", { name: /^Projects$/ });
		expect(projects.length).toBeGreaterThan(0);
	});

	it("keeps the rest of the navigation working when the query fails", async () => {
		setupMember();
		getProjectShortcuts.mockRejectedValue(new Error("boom"));

		renderNavBar({ PROJECT_SHORTCUTS: true });

		// Degrades to absent rather than surfacing an error.
		await waitFor(() => {
			expect(
				screen.getAllByRole("link", { name: /^Workflows$/ }).length,
			).toBeGreaterThan(0);
		});
		expect(
			screen.getAllByRole("link", { name: /^Projects$/ }).length,
		).toBeGreaterThan(0);
	});

	it("renders no shortcut rows while the query is still pending", () => {
		setupMember();
		// Never resolves — models the first paint on an always-visible surface.
		getProjectShortcuts.mockReturnValue(new Promise(() => {}));

		renderNavBar({ PROJECT_SHORTCUTS: true });

		// No skeleton, no reserved space: items below Projects must not shift
		// twice on every page load.
		expect(screen.queryByRole("link", { name: /Atlas/ })).toBeNull();
	});

	it("links a guest-held project into its host organization", async () => {
		setupMember();
		getProjectShortcuts.mockResolvedValue({
			shortcuts: [
				shortcut("p9", "Shared", { organizationSlug: "host-org" }),
			],
		});

		renderNavBar({ PROJECT_SHORTCUTS: true });

		await waitFor(() => {
			expect(
				screen.getAllByRole("link", { name: /Shared/ }).length,
			).toBeGreaterThan(0);
		});
		// Built from the project's own slug, never the nav's base path.
		expect(
			screen.getAllByRole("link", { name: /Shared/ })[0],
		).toHaveAttribute("href", "/app/host-org/projects/p9");
	});

	it("names a favorited entry differently from a recency-filled one", async () => {
		setupMember();
		getProjectShortcuts.mockResolvedValue({
			shortcuts: [
				shortcut("p1", "Atlas", { isFavorite: true }),
				shortcut("p2", "Borealis"),
			],
		});

		renderNavBar({ PROJECT_SHORTCUTS: true });

		await waitFor(() => {
			expect(
				screen.getAllByRole("link", { name: /Atlas/ }).length,
			).toBeGreaterThan(0);
		});
		// The icon is aria-hidden, so the distinction has to be in the name.
		expect(
			screen.getAllByRole("link", { name: /Atlas Favorite/ }).length,
		).toBeGreaterThan(0);
		expect(
			screen.queryByRole("link", { name: /Borealis Favorite/ }),
		).toBeNull();
	});

	it("marks only the open project's shortcut as the current page", async () => {
		setupMember();
		// usePathname is mocked to /app/org-1/projects — no shortcut owns it, so
		// the parent keeps the marker and no child claims it.
		getProjectShortcuts.mockResolvedValue({
			shortcuts: [shortcut("p1", "Atlas")],
		});

		renderNavBar({ PROJECT_SHORTCUTS: true });

		await waitFor(() => {
			expect(
				screen.getAllByRole("link", { name: /Atlas/ }).length,
			).toBeGreaterThan(0);
		});
		expect(
			screen.getAllByRole("link", { name: /Atlas/ })[0],
		).not.toHaveAttribute("aria-current");
	});

	it("renders no shortcuts in the collapsed rail", async () => {
		setupMember();
		mockIsCollapsed = true;
		getProjectShortcuts.mockResolvedValue({
			shortcuts: [shortcut("p1", "Atlas")],
		});

		renderNavBar({ PROJECT_SHORTCUTS: true });

		await waitFor(() => {
			expect(getProjectShortcuts).toHaveBeenCalled();
		});
		// The rail shows icons only; nested items are not part of that shape.
		expect(screen.queryAllByRole("link", { name: /^Atlas$/ })).toHaveLength(
			0,
		);
	});
});

describe("NavBar — unified agent interface rollback", () => {
	// The flag gates a route redirect AND this nav destination. Gating only the
	// route left the sidebar pointing at the new surface while the flag was
	// off, so the rollback restored the old page but nothing could reach it
	// except a hand-typed URL — found by flipping the flag on staging, not by
	// review. These two assertions are what would have caught it.
	function setupPersonal() {
		sessionMock.mockReturnValue({
			user: { id: "u-1", email: "personal@example.test", role: "user" },
		});
		orgContextMock.mockReturnValue({
			basePath: "/app",
			isOrgContext: false,
			organizationId: null,
		});
		guestMock.mockReturnValue(false);
		getOnboardingState.mockResolvedValue(makeOnboardingStateData());
	}

	it("points the chat entry at the unified surface while the flag is on", () => {
		setupPersonal();
		renderNavBar({ UNIFIED_AGENT_INTERFACE: true });

		const link = screen.getByRole("link", {
			name: /app\.menu\.aiChatbot$/,
		});
		expect(link).toHaveAttribute("href", "/app/own-org/agents/fabric-ai");
	});

	it("sends the chat entry back to Nexus when the flag is off", () => {
		setupPersonal();
		renderNavBar({ UNIFIED_AGENT_INTERFACE: false });

		const link = screen.getByRole("link", {
			name: /app\.menu\.aiChatbotLegacy/,
		});
		expect(link).toHaveAttribute("href", "/app/own-org/nexus");
	});
});
