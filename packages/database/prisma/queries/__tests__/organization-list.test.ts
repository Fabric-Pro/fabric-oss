import { describe, expect, it, vi } from "vitest";
import { Prisma } from "../../generated/client";

const mocks = vi.hoisted(() => ({
	raw: vi.fn().mockResolvedValue([]),
	count: vi.fn(),
}));
vi.mock("../../client", () => ({
	Prisma,
	db: { $queryRaw: mocks.raw, organization: { count: mocks.count } },
}));

import { countAllOrganizations, getOrganizations } from "../organizations";

describe("organization list queries", () => {
	it.each(["active", "deactivated", "all"] as const)(
		"counts matching search and %s status",
		async (status) => {
			await countAllOrganizations({ query: "example", status });
			expect(mocks.count).toHaveBeenLastCalledWith({
				where: {
					name: { contains: "example", mode: "insensitive" },
					...(status === "all"
						? {}
						: {
								deletedAt:
									status === "active" ? null : { not: null },
							}),
				},
			});
		},
	);
	it.each(["active", "deactivated", "all"] as const)(
		"uses filtered project counts for display and sorting, %s",
		async (status) => {
			await getOrganizations({
				limit: 8,
				offset: 8,
				query: "example",
				status,
				sort: "projects",
				direction: "desc",
			});
			const sql = mocks.raw.mock.lastCall?.[0];
			expect(sql.text).toContain(
				'p."organizationId" = o.id AND p."deletedAt" IS NULL) AS "projectsCount"',
			);
			expect(sql.text).toContain(
				'ORDER BY "projectsCount" DESC, o.id ASC',
			);
			expect(sql.text).toContain(
				status === "all"
					? "WHERE TRUE"
					: status === "active"
						? 'WHERE o."deletedAt" IS NULL'
						: 'WHERE o."deletedAt" IS NOT NULL',
			);
			expect(sql.text).toContain("o.name ILIKE $1");
			expect(sql.values).toEqual(["%example%", 8, 8]);
		},
	);
});
