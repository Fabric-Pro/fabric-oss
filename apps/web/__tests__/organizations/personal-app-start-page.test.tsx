import { db } from "@repo/database";
import { getOrganizationList, getSession } from "@saas/auth/lib/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn((url: string) => {
	throw new Error(`REDIRECT:${url}`);
});

vi.mock("next/navigation", () => ({
	redirect: redirectMock,
}));

vi.mock("@repo/config", () => ({
	config: {
		organizations: {
			enable: true,
			requireOrganization: false,
		},
		dashboard: { inviteWelcomeWidget: { enabled: true } },
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		projectMember: {
			findFirst: vi.fn(),
		},
		user: {
			findUnique: vi.fn(async () => ({ lastActiveOrganizationId: null })),
		},
	},
	// The page wires this into the guest-landing redirect decision
	// (resolveGuestLandingRedirect). `false` models a user with no personal
	// projects; combined with the projectMember.findFirst mock resolving
	// undefined (no guest membership), the no-org user below still stays on
	// the personal dashboard. The redirect decision matrix itself is covered
	// by modules/saas/start/lib/__tests__/guest-landing-redirect.test.ts.
	hasAnyPersonalProject: vi.fn(async () => false),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: vi.fn(async () => ({
		user: { onboardingComplete: true },
		session: { activeOrganizationId: null },
	})),
	getOrganizationList: vi.fn(async () => [
		{ id: "org-1", slug: "acme", name: "Acme" },
	]),
}));

vi.mock("@saas/shared/components/TopRightControls", () => ({
	TopRightControls: () => null,
}));

vi.mock("@saas/shared/components/PageBreadcrumbs", () => ({
	PageBreadcrumbs: () => null,
}));

vi.mock("@saas/start/UserStart", () => ({
	default: () => null,
}));

describe("personal app start page", () => {
	beforeEach(() => {
		redirectMock.mockClear();
	});

	it("stays on the personal dashboard when organizations are optional", async () => {
		const module = await import("../../app/(saas)/app/(account)/page");
		await expect(module.default()).resolves.toBeTruthy();
		expect(redirectMock).not.toHaveBeenCalled();
	});

	it("does not redirect when user has no organizations", async () => {
		vi.mocked(getOrganizationList).mockResolvedValueOnce([]);

		const module = await import("../../app/(saas)/app/(account)/page");
		await expect(module.default()).resolves.toBeTruthy();
		expect(redirectMock).not.toHaveBeenCalled();
	});

	it("does NOT redirect to the active org on a bare /app load (multi-tab refresh safety)", async () => {
		// Regression guard for the cross-tab redirect bug: session.activeOrganizationId
		// is a single value shared across every browser tab (last-write-wins). A bare
		// /app load — e.g. refreshing a personal tab — must NOT be hijacked into
		// whatever org another tab last activated. It stays on the personal dashboard.
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: "u1", onboardingComplete: true },
			session: { activeOrganizationId: "org-1" },
		} as any);
		vi.mocked(getOrganizationList).mockResolvedValueOnce([
			{ id: "org-1", slug: "acme", name: "Acme" },
		] as any);

		const module = await import("../../app/(saas)/app/(account)/page");
		// Mirror how Next invokes the page: searchParams is always a Promise.
		await expect(
			module.default({ searchParams: Promise.resolve({}) }),
		).resolves.toBeTruthy();
		expect(redirectMock).not.toHaveBeenCalled();
	});

	it("redirects to last-active org on post-login when session has no activeOrganizationId", async () => {
		// Simulates a user whose Better Auth session.activeOrganizationId is null
		// (e.g. they signed in on a new device) but whose DB lastActiveOrganizationId
		// is set — they should be routed back to that org on the post-login hop.
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: "u1", onboardingComplete: true },
			session: { activeOrganizationId: null },
		} as any);
		vi.mocked(getOrganizationList).mockResolvedValueOnce([
			{ id: "org-1", slug: "acme", name: "Acme" },
		] as any);
		vi.mocked(db.user.findUnique).mockResolvedValueOnce({
			lastActiveOrganizationId: "org-1",
		} as any);

		const module = await import("../../app/(saas)/app/(account)/page");
		await module
			.default({ searchParams: Promise.resolve({ postLogin: "1" }) })
			.catch(() => {});
		expect(redirectMock).toHaveBeenCalledWith("/app/acme");
	});

	it("redirects to the active org when arriving straight from sign-in (?postLogin=1)", async () => {
		// One-time post-login dispatch: config.auth.redirectAfterSignIn points at
		// /app?postLogin=1, the only entry that may resume the active org. This is a
		// transient redirect — the tab never rests here, so it can't hijack other tabs.
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: "u1", onboardingComplete: true },
			session: { activeOrganizationId: "org-1" },
		} as any);
		vi.mocked(getOrganizationList).mockResolvedValueOnce([
			{ id: "org-1", slug: "acme", name: "Acme" },
		] as any);

		const module = await import("../../app/(saas)/app/(account)/page");
		// redirect() throws to halt rendering; swallow it and assert the target.
		await module
			.default({ searchParams: Promise.resolve({ postLogin: "1" }) })
			.catch(() => {});
		expect(redirectMock).toHaveBeenCalledWith("/app/acme");
	});
});
