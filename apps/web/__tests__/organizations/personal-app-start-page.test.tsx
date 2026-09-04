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

vi.mock("@repo/logs", () => ({
	logger: {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
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
		// The post-login hop aligns session.activeOrganizationId with the org it
		// redirects into, so the oRPC tenant context and the URL never disagree.
		session: {
			update: vi.fn(),
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
		user: { id: "u1", onboardingComplete: true },
		session: { id: "sess-1", activeOrganizationId: null },
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

/** Two memberships, so "which org?" is a question with a wrong answer. */
const TWO_ORGS = [
	{ id: "org-1", slug: "acme", name: "Acme" },
	{ id: "org-2", slug: "example-org", name: "Example Org" },
];

describe("personal app start page", () => {
	beforeEach(() => {
		redirectMock.mockClear();
		vi.mocked(db.session.update).mockReset();
		vi.mocked(db.projectMember.findFirst).mockReset();
		// Full reset, not mockClear: a test that asserts findUnique is never
		// called would otherwise leave its queued `...Once` value behind for
		// whichever test calls it next.
		vi.mocked(db.user.findUnique).mockReset();
		vi.mocked(db.user.findUnique).mockResolvedValue({
			lastActiveOrganizationId: null,
		} as any);
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
			session: { id: "sess-1", activeOrganizationId: "org-1" },
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

	it("does NOT consult the last-active org — or touch the session — on a bare /app load", async () => {
		// The reordering must stay inside the ?postLogin=1 guard (#1477). A bare
		// /app load reads neither source and writes nothing: no redirect, no
		// lastActiveOrganizationId lookup, no session alignment.
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: "u1", onboardingComplete: true },
			session: { id: "sess-1", activeOrganizationId: "org-1" },
		} as any);
		vi.mocked(getOrganizationList).mockResolvedValueOnce(TWO_ORGS as any);
		vi.mocked(db.user.findUnique).mockResolvedValueOnce({
			lastActiveOrganizationId: "org-2",
		} as any);

		const module = await import("../../app/(saas)/app/(account)/page");
		await expect(
			module.default({ searchParams: Promise.resolve({}) }),
		).resolves.toBeTruthy();
		expect(redirectMock).not.toHaveBeenCalled();
		expect(db.user.findUnique).not.toHaveBeenCalled();
		expect(db.session.update).not.toHaveBeenCalled();
	});

	it("redirects to last-active org on post-login when session has no activeOrganizationId", async () => {
		// Simulates a user whose Better Auth session.activeOrganizationId is null
		// (e.g. they signed in on a new device) but whose DB lastActiveOrganizationId
		// is set — they should be routed back to that org on the post-login hop.
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: "u1", onboardingComplete: true },
			session: { id: "sess-1", activeOrganizationId: null },
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

	it("prefers the last-active org over the session's active org on post-login", async () => {
		// The bug this ordering fixes: a session left over from an earlier visit
		// still names org-1, but the user's durable last-active record says they
		// were working in org-2. The durable record wins — and org-2 is not
		// organizations[0] either, so neither of the old branches could produce it.
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: "u1", onboardingComplete: true },
			session: { id: "sess-1", activeOrganizationId: "org-1" },
		} as any);
		vi.mocked(getOrganizationList).mockResolvedValueOnce(TWO_ORGS as any);
		vi.mocked(db.user.findUnique).mockResolvedValueOnce({
			lastActiveOrganizationId: "org-2",
		} as any);

		const module = await import("../../app/(saas)/app/(account)/page");
		await module
			.default({ searchParams: Promise.resolve({ postLogin: "1" }) })
			.catch(() => {});
		expect(redirectMock).toHaveBeenCalledWith("/app/example-org");
		expect(redirectMock).not.toHaveBeenCalledWith("/app/acme");
	});

	it("aligns session.activeOrganizationId with the org it redirects into", async () => {
		// Tenant-alignment invariant: every oRPC call derives its tenant context
		// from session.activeOrganizationId. Redirecting to /app/example-org while
		// the session still says org-1 would run the whole page against the wrong
		// organization, so the session is written before the hand-off.
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: "u1", onboardingComplete: true },
			session: { id: "sess-1", activeOrganizationId: "org-1" },
		} as any);
		vi.mocked(getOrganizationList).mockResolvedValueOnce(TWO_ORGS as any);
		vi.mocked(db.user.findUnique).mockResolvedValueOnce({
			lastActiveOrganizationId: "org-2",
		} as any);

		const module = await import("../../app/(saas)/app/(account)/page");
		await module
			.default({ searchParams: Promise.resolve({ postLogin: "1" }) })
			.catch(() => {});
		expect(db.session.update).toHaveBeenCalledWith({
			where: { id: "sess-1" },
			data: { activeOrganizationId: "org-2" },
		});
		expect(redirectMock).toHaveBeenCalledWith("/app/example-org");
	});

	it("issues no alignment write when the session already names the target org", async () => {
		// The common path: session and last-active agree. No pointless UPDATE.
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: "u1", onboardingComplete: true },
			session: { id: "sess-1", activeOrganizationId: "org-2" },
		} as any);
		vi.mocked(getOrganizationList).mockResolvedValueOnce(TWO_ORGS as any);
		vi.mocked(db.user.findUnique).mockResolvedValueOnce({
			lastActiveOrganizationId: "org-2",
		} as any);

		const module = await import("../../app/(saas)/app/(account)/page");
		await module
			.default({ searchParams: Promise.resolve({ postLogin: "1" }) })
			.catch(() => {});
		expect(db.session.update).not.toHaveBeenCalled();
		expect(redirectMock).toHaveBeenCalledWith("/app/example-org");
	});

	it("still redirects when the alignment write fails", async () => {
		// Best-effort by design: a failed UPDATE must not turn a sign-in into an
		// error page. The URL still names the right organization.
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: "u1", onboardingComplete: true },
			session: { id: "sess-1", activeOrganizationId: "org-1" },
		} as any);
		vi.mocked(getOrganizationList).mockResolvedValueOnce(TWO_ORGS as any);
		vi.mocked(db.user.findUnique).mockResolvedValueOnce({
			lastActiveOrganizationId: "org-2",
		} as any);
		vi.mocked(db.session.update).mockRejectedValueOnce(
			new Error("connection lost"),
		);

		const module = await import("../../app/(saas)/app/(account)/page");
		await module
			.default({ searchParams: Promise.resolve({ postLogin: "1" }) })
			.catch(() => {});
		expect(redirectMock).toHaveBeenCalledWith("/app/example-org");
	});

	it("falls back to the session's active org when there is no last-active org", async () => {
		// Nothing durable recorded yet (a first sign-in): the session value is the
		// only signal left, and it still beats organizations[0].
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: "u1", onboardingComplete: true },
			session: { id: "sess-1", activeOrganizationId: "org-2" },
		} as any);
		vi.mocked(getOrganizationList).mockResolvedValueOnce(TWO_ORGS as any);
		vi.mocked(db.user.findUnique).mockResolvedValueOnce({
			lastActiveOrganizationId: null,
		} as any);

		const module = await import("../../app/(saas)/app/(account)/page");
		await module
			.default({ searchParams: Promise.resolve({ postLogin: "1" }) })
			.catch(() => {});
		expect(redirectMock).toHaveBeenCalledWith("/app/example-org");
	});

	it("falls back to the session's active org when the last-active org is no longer a membership", async () => {
		// The user was removed from org-3 since they last worked there, so
		// resolveLastActiveWorkspace returns null rather than a membership they
		// can no longer enter.
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: "u1", onboardingComplete: true },
			session: { id: "sess-1", activeOrganizationId: "org-2" },
		} as any);
		vi.mocked(getOrganizationList).mockResolvedValueOnce(TWO_ORGS as any);
		vi.mocked(db.user.findUnique).mockResolvedValueOnce({
			lastActiveOrganizationId: "org-3",
		} as any);

		const module = await import("../../app/(saas)/app/(account)/page");
		await module
			.default({ searchParams: Promise.resolve({ postLogin: "1" }) })
			.catch(() => {});
		expect(redirectMock).toHaveBeenCalledWith("/app/example-org");
		expect(redirectMock).not.toHaveBeenCalledWith("/app/acme");
	});

	it("redirects to the active org when arriving straight from sign-in (?postLogin=1)", async () => {
		// One-time post-login dispatch: config.auth.redirectAfterSignIn points at
		// /app?postLogin=1, the only entry that may resume an org. This is a
		// transient redirect — the tab never rests here, so it can't hijack other tabs.
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: "u1", onboardingComplete: true },
			session: { id: "sess-1", activeOrganizationId: "org-1" },
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

	it("keeps a single-org user on their only organization", async () => {
		// Unchanged behaviour: one membership, and the durable record names it.
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: "u1", onboardingComplete: true },
			session: { id: "sess-1", activeOrganizationId: "org-1" },
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
		expect(db.session.update).not.toHaveBeenCalled();
	});

	it("picks the lowest-id membership when neither source names one", async () => {
		// Neither the durable record nor the session resolves, so the last
		// resort fires. Better Auth's listOrganizations does an unsorted
		// findMany, so the list arrives in arbitrary order — this one is
		// deliberately reversed. The landing must not depend on that order, or
		// two sign-ins with no data change between them can go to different
		// places. Ascending id matches resolveUserOrganization's own tiebreak.
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: "u1", onboardingComplete: true },
			session: { id: "sess-1", activeOrganizationId: null },
		} as any);
		vi.mocked(getOrganizationList).mockResolvedValueOnce([
			{ id: "org-2", slug: "globex", name: "Globex" },
			{ id: "org-1", slug: "acme", name: "Acme" },
		] as any);
		vi.mocked(db.user.findUnique).mockResolvedValueOnce({
			lastActiveOrganizationId: null,
		} as any);

		const module = await import("../../app/(saas)/app/(account)/page");
		await module
			.default({ searchParams: Promise.resolve({ postLogin: "1" }) })
			.catch(() => {});
		expect(redirectMock).toHaveBeenCalledWith("/app/acme");
	});

	it("does not push a guest with no memberships into any organization", async () => {
		// Zero org memberships: neither source can name one, and the
		// organizations[0] last resort has nothing to offer either. The guest
		// landing path below still runs and takes them to their invited project.
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: "u1", onboardingComplete: true },
			session: { id: "sess-1", activeOrganizationId: "org-1" },
		} as any);
		vi.mocked(getOrganizationList).mockResolvedValueOnce([]);
		vi.mocked(db.user.findUnique).mockResolvedValueOnce({
			lastActiveOrganizationId: "org-1",
		} as any);
		vi.mocked(db.projectMember.findFirst).mockResolvedValueOnce({
			projectId: "project-1",
			project: { organization: { slug: "example-org" } },
		} as any);

		const module = await import("../../app/(saas)/app/(account)/page");
		await module
			.default({ searchParams: Promise.resolve({ postLogin: "1" }) })
			.catch(() => {});
		expect(redirectMock).toHaveBeenCalledWith(
			"/app/example-org/projects/project-1",
		);
		expect(redirectMock).not.toHaveBeenCalledWith("/app/example-org");
		expect(db.session.update).not.toHaveBeenCalled();
	});
});
