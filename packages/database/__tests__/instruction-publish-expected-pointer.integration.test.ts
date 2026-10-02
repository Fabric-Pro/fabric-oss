/**
 * Real-Postgres test for `expectedPublishedSnapshotId` on a manual publish or
 * rollback (`publishInstructionSnapshot` with `allowRollback`).
 *
 * History shows which version is published and offers to publish or roll back
 * to another. Two people looking at the same page both see version 1 as the
 * published one; the first publishes version 2, and the second then rolls back
 * to version 3 believing they replace version 1. Without a check they silently
 * replace version 2, which they never saw. The caller therefore says which
 * pointer it saw, and the write refuses, under the project row lock, when the
 * pointer is no longer that one. A mocked transaction cannot show the refusal
 * is made against the committed pointer, so this runs against a real database.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database exec dotenv -c -e ../../.env.local -- vitest run __tests__/instruction-publish-expected-pointer.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, publishInstructionSnapshot } from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `expected-pointer-org-${RUN_ID}`;
const USER_ID = `expected-pointer-user-${RUN_ID}`;
let projectId = "";
const ids: Record<1 | 2 | 3, string> = { 1: "", 2: "", 3: "" };

function publish(
	version: 1 | 2 | 3,
	expectedPublishedSnapshotId?: string | null,
) {
	return publishInstructionSnapshot({
		snapshotId: ids[version],
		projectId,
		organizationId: ORGANIZATION_ID,
		allowRollback: true,
		...(expectedPublishedSnapshotId === undefined
			? {}
			: { expectedPublishedSnapshotId }),
	});
}

async function pointer() {
	const row = await db.project.findUniqueOrThrow({
		where: { id: projectId },
		select: { publishedInstructionSnapshotId: true },
	});
	return row.publishedInstructionSnapshotId;
}

async function setPointer(version: 1 | 2 | 3 | null) {
	await db.project.update({
		where: { id: projectId },
		data: {
			publishedInstructionSnapshotId:
				version === null ? null : ids[version],
		},
	});
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"publishing against the pointer the caller saw (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: USER_ID,
					name: "Expected Pointer",
					email: `${USER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Expected Pointer",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Expected Pointer",
					userId: USER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			projectId = project.id;
			for (const version of [1, 2, 3] as const) {
				const row = await db.projectInstructionSnapshot.create({
					data: {
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: USER_ID,
						version,
						source: "UPLOAD",
						status: "READY",
						settingsFrozen: {},
						digest: String(version).repeat(64),
					},
					select: { id: true },
				});
				ids[version] = row.id;
			}
		});

		afterAll(async () => {
			if (projectId) {
				await db.project.updateMany({
					where: { id: projectId },
					data: { publishedInstructionSnapshotId: null },
				});
				await db.projectInstructionSnapshot.deleteMany({
					where: { projectId },
				});
				await db.project.deleteMany({ where: { id: projectId } });
			}
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({ where: { id: USER_ID } });
			await db.$disconnect();
		});

		it("publishes when the pointer is still the one the caller saw", async () => {
			await setPointer(1);

			expect(await publish(2, ids[1])).toMatchObject({
				published: true,
				changed: true,
			});
			expect(await pointer()).toBe(ids[2]);
		});

		it("refuses, and writes nothing, when somebody else moved the pointer since", async () => {
			await setPointer(2);

			expect(await publish(3, ids[1])).toEqual({
				published: false,
				changed: false,
				reason: "published_changed",
				currentPublishedVersion: 2,
			});
			expect(await pointer()).toBe(ids[2]);
		});

		it("refuses a rollback made from a stale view the same way", async () => {
			await setPointer(3);

			expect(await publish(1, ids[2])).toMatchObject({
				published: false,
				reason: "published_changed",
				currentPublishedVersion: 3,
			});
			expect(await pointer()).toBe(ids[3]);
		});

		it("treats null as 'nothing was published', refusing once something is", async () => {
			await setPointer(null);
			expect(await publish(1, null)).toMatchObject({
				published: true,
				changed: true,
			});

			expect(await publish(2, null)).toMatchObject({
				published: false,
				reason: "published_changed",
				currentPublishedVersion: 1,
			});
			expect(await pointer()).toBe(ids[1]);
		});

		it("answers a stale view of a version that is already the pointer as unchanged, not as a conflict", async () => {
			await setPointer(2);

			expect(await publish(2, ids[1])).toMatchObject({
				published: true,
				changed: false,
			});
			expect(await pointer()).toBe(ids[2]);
		});

		it("keeps today's behaviour for a caller that does not say what it saw", async () => {
			await setPointer(1);

			expect(await publish(3)).toMatchObject({
				published: true,
				changed: true,
			});
			expect(await pointer()).toBe(ids[3]);
		});

		it("lets exactly one of two callers holding the same stale view win", async () => {
			await setPointer(1);

			const results = await Promise.all([
				publish(2, ids[1]),
				publish(3, ids[1]),
			]);

			const winners = results.filter((r) => r.published);
			const refused = results.filter((r) => !r.published);
			expect(winners).toHaveLength(1);
			expect(refused).toEqual([
				expect.objectContaining({ reason: "published_changed" }),
			]);
		});
	},
);
