/**
 * Unit tests for the last-active-workspace redirect decision.
 *
 * Run with:
 *   pnpm --filter web test modules/saas/start/lib/__tests__/last-active-workspace-redirect.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { resolveLastActiveWorkspaceRedirect } from "../last-active-workspace-redirect";

const USER_ID = "user-1";
const ORG_ID = "org-abc";
const ORG_SLUG = "acme";

function makeLoader(lastActiveOrganizationId: string | null) {
	return vi.fn().mockResolvedValue(lastActiveOrganizationId);
}

const orgList = [{ id: ORG_ID, slug: ORG_SLUG }];

describe("resolveLastActiveWorkspaceRedirect", () => {
	it("last active org exists in membership list → redirects to it", async () => {
		const loader = makeLoader(ORG_ID);

		const result = await resolveLastActiveWorkspaceRedirect({
			userId: USER_ID,
			organizations: orgList,
			getLastActiveOrganizationId: loader,
		});

		expect(result).toBe(`/app/${ORG_SLUG}`);
		expect(loader).toHaveBeenCalledExactlyOnceWith(USER_ID);
	});

	it("last active org no longer in membership list (deleted/removed) → returns null", async () => {
		const loader = makeLoader("org-deleted");

		const result = await resolveLastActiveWorkspaceRedirect({
			userId: USER_ID,
			organizations: orgList,
			getLastActiveOrganizationId: loader,
		});

		expect(result).toBeNull();
	});

	it("lastActiveOrganizationId is null (personal workspace) → returns null, no redirect", async () => {
		const loader = makeLoader(null);

		const result = await resolveLastActiveWorkspaceRedirect({
			userId: USER_ID,
			organizations: orgList,
			getLastActiveOrganizationId: loader,
		});

		expect(result).toBeNull();
	});

	it("empty org list, last active org set → returns null (user has no memberships)", async () => {
		const loader = makeLoader(ORG_ID);

		const result = await resolveLastActiveWorkspaceRedirect({
			userId: USER_ID,
			organizations: [],
			getLastActiveOrganizationId: loader,
		});

		expect(result).toBeNull();
	});
});
