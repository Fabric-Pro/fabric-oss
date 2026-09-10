/**
 * The scheduled newsletter dispatcher must not email about something that has
 * been deleted (Fizzy #2462).
 *
 * This fan-out is the one place in the newsletter path with no session behind
 * it. Every interactive read of a deactivated organization is refused at tenant
 * resolution, but a Temporal schedule has no session to refuse — it walks a
 * CHILD table directly. So the liveness predicates have to be in the query
 * itself, and this test is what stops them being dropped by a later edit that
 * "simplifies" the where clause.
 *
 * Two failure modes, one pre-existing and one that the organization corridor
 * would have introduced:
 *   - a project in its 7-day window kept sending (already true before #2462);
 *   - a deactivated organization would have kept sending for its 7 days, which
 *     means emailing members about an organization they were just told was gone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("../prisma/client", () => ({
	db: { newsletterSettings: { findMany } },
}));

async function load() {
	return await import("../prisma/queries/projects/newsletter");
}

beforeEach(() => {
	vi.clearAllMocks();
	findMany.mockResolvedValue([]);
});

describe("listEnabledNewsletterSettings", () => {
	it("excludes soft-deleted projects and deactivated organizations", async () => {
		const { listEnabledNewsletterSettings } = await load();

		await listEnabledNewsletterSettings();

		expect(findMany).toHaveBeenCalledTimes(1);
		expect(findMany.mock.calls[0]?.[0]?.where).toEqual({
			enabled: true,
			project: {
				deletedAt: null,
				NOT: { organization: { deletedAt: { not: null } } },
			},
		});
	});

	it("does not require an organization to exist", async () => {
		// `organization: { deletedAt: null }` would have been the obvious
		// spelling and would silently drop every project whose organizationId is
		// null — a different behaviour change than the one intended. The
		// negated form excludes only what is actually deleted.
		const { listEnabledNewsletterSettings } = await load();

		await listEnabledNewsletterSettings();

		const where = findMany.mock.calls[0]?.[0]?.where;
		expect(where.project.organization).toBeUndefined();
		expect(where.project.NOT).toEqual({
			organization: { deletedAt: { not: null } },
		});
	});

	it("still filters on enabled", async () => {
		const { listEnabledNewsletterSettings } = await load();

		await listEnabledNewsletterSettings();

		expect(findMany.mock.calls[0]?.[0]?.where.enabled).toBe(true);
	});
});
