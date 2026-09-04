/**
 * Unit tests for the last-active-workspace decision.
 *
 * Run with:
 *   pnpm --filter web test modules/saas/start/lib/__tests__/last-active-workspace.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { resolveLastActiveWorkspace } from "../last-active-workspace";

const USER_ID = "user-1";
const ORG_ID = "org-abc";
const ORG_SLUG = "acme";

function makeLoader(lastActiveOrganizationId: string | null) {
	return vi.fn().mockResolvedValue(lastActiveOrganizationId);
}

const orgList = [{ id: ORG_ID, slug: ORG_SLUG }];

describe("resolveLastActiveWorkspace", () => {
	it("last active org exists in membership list → returns that membership", async () => {
		const loader = makeLoader(ORG_ID);

		const result = await resolveLastActiveWorkspace({
			userId: USER_ID,
			organizations: orgList,
			getLastActiveOrganizationId: loader,
		});

		expect(result).toEqual({ id: ORG_ID, slug: ORG_SLUG });
		expect(loader).toHaveBeenCalledExactlyOnceWith(USER_ID);
	});

	/**
	 * The caller aligns the session with whatever this returns, so it needs the
	 * id and not only the slug. Asserted separately from the equality above
	 * because that check would still pass if the function ever went back to
	 * handing out a formatted path.
	 */
	it("returns the membership object itself, not a formatted path", async () => {
		const result = await resolveLastActiveWorkspace({
			userId: USER_ID,
			organizations: orgList,
			getLastActiveOrganizationId: makeLoader(ORG_ID),
		});

		expect(result).toBe(orgList[0]);
		expect(typeof result).not.toBe("string");
	});

	it("carries through fields the caller added to its membership list", async () => {
		const richList = [{ id: ORG_ID, slug: ORG_SLUG, name: "Acme" }];

		const result = await resolveLastActiveWorkspace({
			userId: USER_ID,
			organizations: richList,
			getLastActiveOrganizationId: makeLoader(ORG_ID),
		});

		expect(result?.name).toBe("Acme");
	});

	it("last active org no longer in membership list (deleted/removed) → returns null", async () => {
		const loader = makeLoader("org-deleted");

		const result = await resolveLastActiveWorkspace({
			userId: USER_ID,
			organizations: orgList,
			getLastActiveOrganizationId: loader,
		});

		expect(result).toBeNull();
	});

	it("no last-active record → returns null", async () => {
		const loader = makeLoader(null);

		const result = await resolveLastActiveWorkspace({
			userId: USER_ID,
			organizations: orgList,
			getLastActiveOrganizationId: loader,
		});

		expect(result).toBeNull();
	});

	it("empty org list, last active org set → returns null (user has no memberships)", async () => {
		const loader = makeLoader(ORG_ID);

		const result = await resolveLastActiveWorkspace({
			userId: USER_ID,
			organizations: [],
			getLastActiveOrganizationId: loader,
		});

		expect(result).toBeNull();
	});
});
