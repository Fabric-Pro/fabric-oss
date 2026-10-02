/**
 * REQUIRES A LIVE POSTGRES with migrations applied. Self-skips via
 * `hasReachableDatabaseUrl()`, which rejects the CI placeholder URL as well as
 * an unset one. Run locally with `pnpm --filter @repo/database test:db`.
 *
 * Company context (Fizzy #2719): a crawled page must belong to the same
 * organization as its parent source. Postgres does not evaluate the parent's
 * row-level-security policy through a foreign key, so this is enforced by the
 * composite key `company_context_url_page_owner_fkey` over
 * (parentSourceId, organizationId). The writes below are RAW SQL on the base
 * client — outside `getTenantDb` and the query helpers — because the claim is
 * that the database refuses them whoever the writer is.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const PAGE_TABLE = "company_context_url_page";
const OWNER_FKEY = "company_context_url_page_owner_fkey";

describe.skipIf(!hasReachableDatabaseUrl())(
	"company context — database-enforced page ownership (real Postgres)",
	() => {
		const RUN = `${Date.now()}-${process.pid}`;
		const ORG_ID = `test-cctx-org-${RUN}`;
		const OTHER_ORG_ID = `test-cctx-other-org-${RUN}`;
		let sourceId: string;
		let pageCounter = 0;

		beforeAll(async () => {
			const now = new Date();
			for (const id of [ORG_ID, OTHER_ORG_ID]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "organization" (id, name, slug, "createdAt")
					VALUES (${id}, ${"Company Context Test Org"}, ${id}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}
			const source = await db.companyContextSource.create({
				data: {
					organizationId: ORG_ID,
					type: "LINK",
					content: "",
					sourceUrl: "https://example.com",
				},
				select: { id: true },
			});
			sourceId = source.id;
		});

		afterAll(async () => {
			// Organizations cascade their sources, which cascade the pages.
			await db.organization
				.deleteMany({ where: { id: { in: [ORG_ID, OTHER_ORG_ID] } } })
				.catch(() => undefined);
		});

		async function insertPageRaw(organizationId: string): Promise<void> {
			pageCounter += 1;
			await db.$executeRawUnsafe(
				`INSERT INTO "${PAGE_TABLE}"
					(id, "parentSourceId", "organizationId", "pageUrl", content,
					 "contentHash", "createdAt", "updatedAt")
				 VALUES ($1, $2, $3, $4, '', '', NOW(), NOW())`,
				`page-${RUN}-${pageCounter}`,
				sourceId,
				organizationId,
				`https://example.com/page-${pageCounter}`,
			);
		}

		it("accepts a page carrying its parent's organization", async () => {
			await expect(insertPageRaw(ORG_ID)).resolves.toBeUndefined();
		});

		it("refuses a page naming a different organization from its parent", async () => {
			let refusal: string | null = null;
			try {
				await insertPageRaw(OTHER_ORG_ID);
			} catch (error) {
				const err = error as Error & { meta?: unknown };
				refusal = `${err.message} ${JSON.stringify(err.meta ?? {})}`;
			}
			// Named, so a refusal for an unrelated reason cannot pass as evidence.
			expect(refusal).toContain(OWNER_FKEY);
		});

		it("deletes a source's pages with it", async () => {
			await db.companyContextSource.deleteMany({
				where: { id: sourceId, organizationId: ORG_ID },
			});
			await expect(
				db.companyContextUrlPage.count({
					where: { parentSourceId: sourceId },
				}),
			).resolves.toBe(0);
		});
	},
);
