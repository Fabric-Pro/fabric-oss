/**
 * The organization purge removes the organization's agent files, against a
 * real Postgres.
 *
 * `agent_workspace_file` has an `organizationId` column but no foreign key to
 * the organization, so the cascade that takes the rest of the tenant never
 * reached it: a purged organization's pages, their records and comments
 * survived. The unit suite (`agent-pages-purge.test.ts`) runs the query over an
 * in-memory fake; only a database shows that the real cascade, the page records'
 * own cascade from their frame and the transaction's rollback behave.
 *
 * Runs against DATABASE_URL (RUN_DB_INTEGRATION=1) after migrations.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../prisma/generated/client";
import { permanentDeleteOrganization } from "../prisma/queries/organizations/deletion";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const IDS = {
	owner: "orgpurge-owner",
	purged: "orgpurge-org-purged",
	restored: "orgpurge-org-restored",
	other: "orgpurge-org-other",
};

const HOOK_TIMEOUT_MS = 60_000;

const fixtures = new PrismaClient({
	adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }),
});

/** One page and one record on it, in `organizationId`. */
async function seedPage(organizationId: string) {
	const frameId = `${organizationId}-page`;
	await fixtures.agentWorkspaceFile.create({
		data: {
			id: frameId,
			userId: IDS.owner,
			organizationId,
			path: `/frames/${frameId}.frame.json`,
			name: `${frameId}.frame.json`,
			content: "{}",
			size: 2,
			fileType: "FRAME",
			status: "COMPLETE",
		},
	});
	await fixtures.framePageRecord.create({
		data: {
			frameId,
			organizationId,
			collection: "$comments",
			key: "c-1",
			value: { text: "kept until the purge" },
			size: 30,
			createdBy: IDS.owner,
			updatedBy: IDS.owner,
		},
	});
	return frameId;
}

const pagesOf = (organizationId: string) =>
	fixtures.agentWorkspaceFile.count({ where: { organizationId } });
const recordsOf = (organizationId: string) =>
	fixtures.framePageRecord.count({ where: { organizationId } });

async function cleanUp() {
	const orgIds = [IDS.purged, IDS.restored, IDS.other];
	await fixtures.agentWorkspaceFile.deleteMany({
		where: { organizationId: { in: orgIds } },
	});
	await fixtures.organization.deleteMany({ where: { id: { in: orgIds } } });
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"Organization purge and agent files (real Postgres)",
	() => {
		beforeEach(async () => {
			await cleanUp();
			const now = new Date();
			await fixtures.user.upsert({
				where: { id: IDS.owner },
				update: {},
				create: {
					id: IDS.owner,
					name: "Owner",
					email: `${IDS.owner}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			for (const [id, deletedAt] of [
				[IDS.purged, now],
				[IDS.restored, null],
				[IDS.other, null],
			] as const) {
				await fixtures.organization.create({
					data: { id, name: id, slug: id, createdAt: now, deletedAt },
				});
				await seedPage(id);
			}
		}, HOOK_TIMEOUT_MS);

		afterAll(async () => {
			await cleanUp();
			await fixtures.user.deleteMany({ where: { id: IDS.owner } });
			await fixtures.$disconnect();
			const { db } = await import("../prisma/client");
			await db.$disconnect();
		}, HOOK_TIMEOUT_MS);

		it("deletes the purged organization's pages and, through them, their records", async () => {
			await permanentDeleteOrganization(IDS.purged);

			expect(
				await fixtures.organization.count({
					where: { id: IDS.purged },
				}),
			).toBe(0);
			expect(await pagesOf(IDS.purged)).toBe(0);
			expect(await recordsOf(IDS.purged)).toBe(0);
		});

		it("leaves another organization's pages and records alone", async () => {
			await permanentDeleteOrganization(IDS.purged);

			expect(await pagesOf(IDS.other)).toBe(1);
			expect(await recordsOf(IDS.other)).toBe(1);
		});

		it("deletes nothing of an organization restored before the purge reached it", async () => {
			await expect(
				permanentDeleteOrganization(IDS.restored),
			).rejects.toThrow();

			expect(
				await fixtures.organization.count({
					where: { id: IDS.restored },
				}),
			).toBe(1);
			expect(await pagesOf(IDS.restored)).toBe(1);
			expect(await recordsOf(IDS.restored)).toBe(1);
		});
	},
);
