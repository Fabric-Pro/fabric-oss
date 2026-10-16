/**
 * What a published page keeps, against a real Postgres.
 *
 * The unit suite (`frame-page-records.test.ts`) runs the query's predicates over
 * an in-memory table. A table cannot show what these cases pin with real
 * connections: writers to one page queue on the advisory lock, so a version
 * check and the page's limits hold when writers race; the unique key and the
 * page's foreign key are the database's; and the organization policy refuses a
 * row of another organization.
 *
 * Runs against DATABASE_URL (RUN_DB_INTEGRATION=1) after migrations and
 * `pnpm --filter @repo/database apply:rls`.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { FILES_COLLECTION } from "@repo/utils/page-limits";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Prisma, PrismaClient } from "../prisma/generated/client";
import {
	deletePageRecords,
	getPageRecord,
	listPageRecords,
	PAGE_RECORD_LIMITS,
	PageRecordBusyError,
	PageRecordInputError,
	PageRecordLimitError,
	PageRecordVersionConflictError,
	pageFilesUsage,
	setPageRecords,
} from "../prisma/queries/frame-page-records";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";
import { asRlsRole, ensureRlsTestRole } from "./_helpers/rls-role";

const IDS = {
	org: "pgrec-org",
	otherOrg: "pgrec-other-org",
	owner: "pgrec-owner",
	ana: "pgrec-ana",
	frame: "pgrec-frame",
};

function client(): PrismaClient {
	return new PrismaClient({
		adapter: new PrismaPg({
			connectionString: process.env.DATABASE_URL ?? "",
		}),
	});
}

/**
 * Setup opens the first connections and writes the fixtures; on a busy machine
 * that outlasts the 10 s default for a hook.
 */
const HOOK_TIMEOUT_MS = 60_000;

/** Fixture writes and assertions; the statements under test use the shared `db`. */
const fixtures = client();

async function settleAll<T>(promises: Promise<T>[]) {
	const results = await Promise.allSettled(promises);
	return {
		fulfilled: results.filter((r) => r.status === "fulfilled").length,
		rejected: results
			.filter((r): r is PromiseRejectedResult => r.status === "rejected")
			.map((r) => r.reason as unknown),
	};
}

const write = (
	actorUserId: string,
	records: Array<{
		key: string;
		value?: Prisma.InputJsonValue;
		scope?: "shared" | "mine";
		expectedVersion?: number;
	}>,
	collection = "signups",
) =>
	setPageRecords({
		frameId: IDS.frame,
		organizationId: IDS.org,
		actorUserId,
		collection,
		records: records.map((r) => ({ ...r, value: r.value ?? { ok: true } })),
	});

const rowCount = () =>
	fixtures.framePageRecord.count({ where: { frameId: IDS.frame } });

/** Rows as the host writes them into a collection a page cannot write, such as `$files`. */
const seedRecords = (
	collection: string,
	rows: Array<{ key: string; value: Prisma.InputJsonValue }>,
) =>
	fixtures.framePageRecord.createMany({
		data: rows.map(({ key, value }) => ({
			frameId: IDS.frame,
			organizationId: IDS.org,
			collection,
			key,
			value,
			size: JSON.stringify(value).length,
			createdBy: IDS.ana,
			updatedBy: IDS.ana,
		})),
	});

describe.skipIf(!hasReachableDatabaseUrl())(
	"Page records (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			for (const id of [IDS.owner, IDS.ana]) {
				await fixtures.user.upsert({
					where: { id },
					update: {},
					create: {
						id,
						name: id === IDS.ana ? "Ana" : "Olga Owner",
						email: `${id}@example.com`,
						emailVerified: true,
						createdAt: now,
						updatedAt: now,
					},
				});
			}
			for (const id of [IDS.org, IDS.otherOrg]) {
				await fixtures.organization.upsert({
					where: { id },
					update: {},
					create: { id, name: id, slug: id, createdAt: now },
				});
			}
			await fixtures.agentWorkspaceFile.upsert({
				where: { id: IDS.frame },
				update: {},
				create: {
					id: IDS.frame,
					userId: IDS.owner,
					organizationId: IDS.org,
					path: "/frames/pgrec.frame.json",
					name: "pgrec.frame.json",
					content: "{}",
					size: 2,
					fileType: "FRAME",
					status: "COMPLETE",
				},
			});
			await ensureRlsTestRole();
		}, HOOK_TIMEOUT_MS);

		beforeEach(async () => {
			await fixtures.framePageRecord.deleteMany({
				where: { frameId: IDS.frame },
			});
		});

		afterAll(async () => {
			await fixtures.agentWorkspaceFile.deleteMany({
				where: { id: IDS.frame },
			});
			await fixtures.organization.deleteMany({
				where: { id: { in: [IDS.org, IDS.otherOrg] } },
			});
			await fixtures.user.deleteMany({
				where: { id: { in: [IDS.owner, IDS.ana] } },
			});
			await fixtures.$disconnect();
			const { db } = await import("../prisma/client");
			await db.$disconnect();
		}, HOOK_TIMEOUT_MS);

		it("stamps the writer's id and name from the user table", async () => {
			const { records } = await write(IDS.ana, [{ key: "slot-1" }]);

			expect(records[0]).toMatchObject({
				createdBy: { id: IDS.ana, name: "Ana" },
				updatedBy: { id: IDS.ana, name: "Ana" },
				version: 1,
				scope: "shared",
			});
		});

		it("reads back what was written, shared and mine kept apart", async () => {
			await write(IDS.ana, [
				{ key: "k", value: "shared" },
				{ key: "k", value: "private", scope: "mine" },
			]);

			const shared = await getPageRecord({
				frameId: IDS.frame,
				organizationId: IDS.org,
				viewerUserId: IDS.owner,
				collection: "signups",
				key: "k",
				scope: "shared",
			});
			const ownerMine = await listPageRecords({
				frameId: IDS.frame,
				organizationId: IDS.org,
				viewerUserId: IDS.owner,
				collection: "signups",
				scope: "mine",
				limit: 10,
			});
			const anaMine = await listPageRecords({
				frameId: IDS.frame,
				organizationId: IDS.org,
				viewerUserId: IDS.ana,
				collection: "signups",
				scope: "mine",
				limit: 10,
			});

			expect(shared?.value).toBe("shared");
			expect(ownerMine.records).toEqual([]);
			expect(anaMine.records.map((r) => r.value)).toEqual(["private"]);
		});

		it("lets exactly one of many writers holding the same version win", async () => {
			await write(IDS.owner, [{ key: "doc", value: "v1" }]);

			const outcome = await settleAll(
				Array.from({ length: 8 }, (_, i) =>
					write(i % 2 ? IDS.ana : IDS.owner, [
						{ key: "doc", value: `edit-${i}`, expectedVersion: 1 },
					]),
				),
			);

			expect(outcome.fulfilled).toBe(1);
			expect(
				outcome.rejected.every(
					(e) => e instanceof PageRecordVersionConflictError,
				),
			).toBe(true);
			const row = await fixtures.framePageRecord.findFirstOrThrow({
				where: { frameId: IDS.frame, key: "doc" },
			});
			expect(row.version).toBe(2);
		});

		it("keeps one row and counts every write when writers race on one new key", async () => {
			const writers = 8;

			const outcome = await settleAll(
				Array.from({ length: writers }, (_, i) =>
					write(IDS.ana, [{ key: "counter", value: i }]),
				),
			);

			expect(outcome.fulfilled).toBe(writers);
			expect(await rowCount()).toBe(1);
			const row = await fixtures.framePageRecord.findFirstOrThrow({
				where: { frameId: IDS.frame },
			});
			expect(row.version).toBe(writers);
		});

		it("answers a few dozen queued writers with success or a busy error, and counts exactly the successes", async () => {
			const writers = 60;

			const outcome = await settleAll(
				Array.from({ length: writers }, (_, i) =>
					write(i % 2 ? IDS.ana : IDS.owner, [
						{ key: "queue", value: i },
					]),
				),
			);

			// How many queue out of the ten-second window depends on the
			// machine; that every writer gets one of the two typed answers, and
			// that the row counts exactly the writes that were answered "done",
			// does not.
			expect(
				outcome.rejected.every((e) => e instanceof PageRecordBusyError),
			).toBe(true);
			expect(outcome.fulfilled + outcome.rejected.length).toBe(writers);
			expect(outcome.fulfilled).toBeGreaterThanOrEqual(1);
			const row = await fixtures.framePageRecord.findFirstOrThrow({
				where: { frameId: IDS.frame },
			});
			expect(row.version).toBe(outcome.fulfilled);
		}, 60_000);

		it("holds the 2,000 record limit when writers race at the edge", async () => {
			const room = 10;
			await fixtures.framePageRecord.createMany({
				data: Array.from(
					{ length: PAGE_RECORD_LIMITS.maxRecordsPerPage - room },
					(_, i) => ({
						frameId: IDS.frame,
						organizationId: IDS.org,
						collection: "bulk",
						key: `k${i}`,
						value: {},
						size: 2,
						createdBy: IDS.owner,
						updatedBy: IDS.owner,
					}),
				),
			});

			const outcome = await settleAll(
				Array.from({ length: room * 2 }, (_, i) =>
					write(IDS.ana, [{ key: `new-${i}` }], "racers"),
				),
			);

			expect(outcome.fulfilled).toBe(room);
			expect(
				outcome.rejected.every(
					(e) =>
						e instanceof PageRecordLimitError &&
						e.limit === "records",
				),
			).toBe(true);
			expect(await rowCount()).toBe(PAGE_RECORD_LIMITS.maxRecordsPerPage);
		});

		it("sums the bytes of a page's files from each file's own size, not from the bytes of its records", async () => {
			await seedRecords(FILES_COLLECTION, [
				{ key: "one", value: { name: "a.png", size: 3_000_000 } },
				{ key: "two", value: { name: "b.png", size: 1_500_000 } },
			]);
			await seedRecords("signups", [
				{ key: "vote", value: { size: 99_999_999 } },
			]);

			expect(
				await pageFilesUsage({
					frameId: IDS.frame,
					organizationId: IDS.org,
				}),
			).toEqual({ files: 2, bytes: 4_500_000 });
		});

		it("counts no file, and no byte, for a page with none or in another organization", async () => {
			await seedRecords(FILES_COLLECTION, [
				{ key: "one", value: { name: "a.png", size: 10 } },
			]);

			expect(
				await pageFilesUsage({
					frameId: IDS.frame,
					organizationId: IDS.otherOrg,
				}),
			).toEqual({ files: 0, bytes: 0 });
			expect(
				await pageFilesUsage({
					frameId: "pgrec-no-such-frame",
					organizationId: IDS.org,
				}),
			).toEqual({ files: 0, bytes: 0 });
		});

		it("counts a file record without a numeric size as a file of no bytes", async () => {
			await seedRecords(FILES_COLLECTION, [
				{ key: "odd", value: { name: "odd.png", size: "large" } },
				{ key: "fine", value: { name: "fine.png", size: 7 } },
			]);

			expect(
				await pageFilesUsage({
					frameId: IDS.frame,
					organizationId: IDS.org,
				}),
			).toEqual({ files: 2, bytes: 7 });
		});

		it("refuses to write a page into another organization", async () => {
			await expect(
				setPageRecords({
					frameId: IDS.frame,
					organizationId: IDS.otherOrg,
					actorUserId: IDS.ana,
					collection: "signups",
					records: [{ key: "a", value: 1 }],
				}),
			).rejects.toBeInstanceOf(PageRecordInputError);
			expect(await rowCount()).toBe(0);
		});

		it("lets the database refuse a second row for one collection, owner and key", async () => {
			await write(IDS.ana, [{ key: "dup" }]);

			await expect(
				fixtures.framePageRecord.create({
					data: {
						frameId: IDS.frame,
						organizationId: IDS.org,
						collection: "signups",
						key: "dup",
						value: {},
						size: 2,
						createdBy: IDS.ana,
						updatedBy: IDS.ana,
					},
				}),
			).rejects.toThrow();
		});

		it("deletes a person's own records and not another person's", async () => {
			await write(IDS.ana, [{ key: "ana-note" }]);
			await write(IDS.owner, [{ key: "owner-note" }]);

			const anaTriesOwners = await deletePageRecords({
				frameId: IDS.frame,
				organizationId: IDS.org,
				actorUserId: IDS.ana,
				isPageOwner: false,
				collection: "signups",
				keys: ["owner-note"],
			});
			const ownerClears = await deletePageRecords({
				frameId: IDS.frame,
				organizationId: IDS.org,
				actorUserId: IDS.owner,
				isPageOwner: true,
				collection: "signups",
				keys: ["ana-note", "owner-note"],
			});

			expect(anaTriesOwners).toEqual({ deleted: 0 });
			expect(ownerClears).toEqual({ deleted: 2 });
		});

		it("removes a page's records with the page", async () => {
			await fixtures.agentWorkspaceFile.create({
				data: {
					id: "pgrec-frame-doomed",
					userId: IDS.owner,
					organizationId: IDS.org,
					path: "/frames/pgrec-doomed.frame.json",
					name: "doomed",
					content: "{}",
					size: 2,
					fileType: "FRAME",
					status: "COMPLETE",
				},
			});
			await setPageRecords({
				frameId: "pgrec-frame-doomed",
				organizationId: IDS.org,
				actorUserId: IDS.ana,
				collection: "signups",
				records: [{ key: "a", value: 1 }],
			});

			await fixtures.agentWorkspaceFile.delete({
				where: { id: "pgrec-frame-doomed" },
			});

			expect(
				await fixtures.framePageRecord.count({
					where: { frameId: "pgrec-frame-doomed" },
				}),
			).toBe(0);
		});

		describe("the organization policy (needs apply:rls)", () => {
			it("is installed on the table", async () => {
				const policies = await fixtures.$queryRaw<
					Array<{ policyname: string }>
				>`SELECT policyname::text FROM pg_policies WHERE tablename = 'frame_page_record'`;

				expect(
					policies.map((p) => p.policyname),
					"run `pnpm --filter @repo/database apply:rls`",
				).toContain("tenant_isolation");
			});

			it("shows a member the page's rows and a member of another organization none", async () => {
				await write(IDS.ana, [{ key: "a" }]);

				const member = await asRlsRole(
					{
						type: "organization",
						tenantId: IDS.org,
						userId: IDS.ana,
					},
					(tx) => tx.framePageRecord.findMany({}),
				);
				const outsider = await asRlsRole(
					{
						type: "organization",
						tenantId: IDS.otherOrg,
						userId: IDS.ana,
					},
					(tx) => tx.framePageRecord.findMany({}),
				);
				const nobody = await asRlsRole({ type: "none" }, (tx) =>
					tx.framePageRecord.findMany({}),
				);

				expect(member.map((r) => r.key)).toContain("a");
				expect(outsider).toEqual([]);
				expect(nobody).toEqual([]);
			});

			it("refuses a row written under another organization's context", async () => {
				await expect(
					asRlsRole(
						{
							type: "organization",
							tenantId: IDS.otherOrg,
							userId: IDS.ana,
						},
						(tx) =>
							tx.framePageRecord.create({
								data: {
									frameId: IDS.frame,
									organizationId: IDS.org,
									collection: "signups",
									key: "smuggled",
									value: {},
									size: 2,
									createdBy: IDS.ana,
									updatedBy: IDS.ana,
								},
							}),
					),
				).rejects.toThrow();
			});
		});
	},
);
