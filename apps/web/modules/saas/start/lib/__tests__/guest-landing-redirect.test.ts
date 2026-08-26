/**
 * Unit tests for the `/app` guest landing redirect decision matrix.
 *
 * The decision logic is extracted into `resolveGuestLandingRedirect`
 * (data access injected) precisely so this matrix is testable without
 * booting the `app/(saas)/app/(account)/page.tsx` server component.
 *
 * Run with:
 *   pnpm --filter web test modules/saas/start/lib/__tests__/guest-landing-redirect.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { resolveGuestLandingRedirect } from "../guest-landing-redirect";

const USER_ID = "user-1";
const GUEST_TARGET = "/app/acme/projects/proj-1";

function makeLoaders({
	hasPersonalProject = false,
	guestTarget = null as string | null,
} = {}) {
	return {
		hasAnyPersonalProject: vi.fn().mockResolvedValue(hasPersonalProject),
		findGuestLandingTarget: vi.fn().mockResolvedValue(guestTarget),
	};
}

describe("resolveGuestLandingRedirect", () => {
	it("zero orgs + zero personal projects + guest membership → redirects to the guest target", async () => {
		const loaders = makeLoaders({ guestTarget: GUEST_TARGET });

		const target = await resolveGuestLandingRedirect({
			organizationCount: 0,
			userId: USER_ID,
			isPostLogin: true,
			...loaders,
		});

		expect(target).toBe(GUEST_TARGET);
		expect(loaders.hasAnyPersonalProject).toHaveBeenCalledExactlyOnceWith(
			USER_ID,
		);
		expect(loaders.findGuestLandingTarget).toHaveBeenCalledExactlyOnceWith(
			USER_ID,
		);
	});

	it("zero orgs + zero personal projects + no guest membership → no redirect (personal dashboard)", async () => {
		const loaders = makeLoaders({ guestTarget: null });

		const target = await resolveGuestLandingRedirect({
			organizationCount: 0,
			userId: USER_ID,
			isPostLogin: true,
			...loaders,
		});

		expect(target).toBeNull();
	});

	it("any personal project → no redirect, guest lookup never consulted", async () => {
		const loaders = makeLoaders({
			hasPersonalProject: true,
			guestTarget: GUEST_TARGET, // would redirect if the guard failed
		});

		const target = await resolveGuestLandingRedirect({
			organizationCount: 0,
			userId: USER_ID,
			isPostLogin: true,
			...loaders,
		});

		expect(target).toBeNull();
		expect(loaders.findGuestLandingTarget).not.toHaveBeenCalled();
	});

	it("any org membership → no redirect, neither loader consulted (existing org-redirect branches win)", async () => {
		const loaders = makeLoaders({ guestTarget: GUEST_TARGET });

		const target = await resolveGuestLandingRedirect({
			organizationCount: 2,
			userId: USER_ID,
			isPostLogin: true,
			...loaders,
		});

		expect(target).toBeNull();
		expect(loaders.hasAnyPersonalProject).not.toHaveBeenCalled();
		expect(loaders.findGuestLandingTarget).not.toHaveBeenCalled();
	});

	it("single org membership also short-circuits (boundary: count === 1)", async () => {
		const loaders = makeLoaders({ guestTarget: GUEST_TARGET });

		const target = await resolveGuestLandingRedirect({
			organizationCount: 1,
			userId: USER_ID,
			isPostLogin: true,
			...loaders,
		});

		expect(target).toBeNull();
		expect(loaders.hasAnyPersonalProject).not.toHaveBeenCalled();
	});

	it("isPostLogin false → never redirects, regardless of guest target", async () => {
		const loaders = makeLoaders({ guestTarget: GUEST_TARGET });
		const target = await resolveGuestLandingRedirect({
			organizationCount: 0,
			userId: USER_ID,
			isPostLogin: false,
			...loaders,
		});
		expect(target).toBeNull();
		expect(loaders.findGuestLandingTarget).not.toHaveBeenCalled();
	});

	it("isPostLogin true preserves the guest redirect", async () => {
		const loaders = makeLoaders({ guestTarget: GUEST_TARGET });
		const target = await resolveGuestLandingRedirect({
			organizationCount: 0,
			userId: USER_ID,
			isPostLogin: true,
			...loaders,
		});
		expect(target).toBe(GUEST_TARGET);
	});
});
