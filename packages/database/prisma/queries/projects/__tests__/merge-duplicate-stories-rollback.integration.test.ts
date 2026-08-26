/**
 * Real-Postgres rollback test for `mergeDuplicateStories` (FR-14 / DV-6): when
 * any step inside the merge transaction fails, the WHOLE merge rolls back —
 * tasks stay put, neither story's PM-link state changes, and the duplicate stays
 * active.
 *
 * To force a deterministic mid-transaction failure we mock the in-transaction
 * decline (`updateStoryDraftingStage`) to throw; every other write uses the real
 * Prisma client, so the assertions prove the real transaction unwound. Kept in
 * its own file because the module-level mock would otherwise affect the
 * happy-path suite.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma } from "../../../client";

// Force the decline (step 4 of the merge) to throw so the surrounding
// db.$transaction rolls back steps 1-3 (task re-parent + link resolve + PM-link
// writes). Spread the real module so only this one export is replaced.
vi.mock("../stories", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../stories")>();
	return {
		...actual,
		updateStoryDraftingStage: vi.fn(async () => {
			throw new Error("injected decline failure");
		}),
	};
});

// `vi.mock` is hoisted above imports, so this static import already sees the
// mocked `updateStoryDraftingStage` that `mergeDuplicateStories` calls.
import { mergeDuplicateStories } from "../duplicate-links";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-merge-rollback-org-${RUN_ID}`;
const USER_ID = `test-merge-rollback-user-${RUN_ID}`;

describe.skipIf(!hasReachableDatabaseUrl())(
	"mergeDuplicateStories — full rollback on a mid-transaction failure (FR-14)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Merge Rollback User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Merge Rollback Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterEach(async () => {
			await db.userStory.deleteMany({ where: { createdById: USER_ID } });
			await db.projectStoryStatus.deleteMany({
				where: { project: { userId: USER_ID } },
			});
			await db.project.deleteMany({ where: { userId: USER_ID } });
		});

		it("rolls back the whole merge — no tasks moved, neither PM link modified, duplicate still active", async () => {
			const project = await db.project.create({
				data: {
					name: "Rollback Project",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});
			const status = await db.projectStoryStatus.create({
				data: {
					projectId: project.id,
					name: "Backlog",
					color: "#94a3b8",
					order: 0,
					isDefault: true,
				},
			});
			const survivor = await db.userStory.create({
				data: {
					projectId: project.id,
					statusId: status.id,
					createdById: USER_ID,
					identifier: `F-${RUN_ID}-S`,
					title: "Survivor (unlinked)",
				},
			});
			const duplicate = await db.userStory.create({
				data: {
					projectId: project.id,
					statusId: status.id,
					createdById: USER_ID,
					identifier: `F-${RUN_ID}-D`,
					title: "Duplicate (linked)",
					externalId: "999",
					externalUrl: "https://gitlab.com/acme/app/-/issues/999",
					externalMcpServerId: "mcp-999",
					pmAutoSyncEnabled: true,
					lastSyncedAt: new Date("2026-05-01T00:00:00.000Z"),
					lastPmSyncStatus: "SUCCESS",
					lastSyncedPmHash: "hash-999",
				},
			});
			const task = await db.storyTask.create({
				data: {
					storyId: duplicate.id,
					identifier: `TASK-${RUN_ID}`,
					title: "should stay on the duplicate",
					order: 0,
				},
			});

			await expect(
				mergeDuplicateStories({
					projectId: project.id,
					survivorId: survivor.id,
					duplicateId: duplicate.id,
					userId: USER_ID,
					pmLink: "transfer-from-duplicate",
				}),
			).rejects.toThrow(/injected decline failure/);

			const [s, d, t] = await Promise.all([
				db.userStory.findUnique({ where: { id: survivor.id } }),
				db.userStory.findUnique({ where: { id: duplicate.id } }),
				db.storyTask.findUnique({ where: { id: task.id } }),
			]);
			// Nothing partial: survivor never gained the link...
			expect(s?.externalId).toBeNull();
			// ...the duplicate kept its link AND stayed active...
			expect(d?.externalId).toBe("999");
			expect(d?.draftingStage).not.toBe("CLOSED");
			expect(d?.mergedIntoStoryId).toBeNull();
			// ...and its task was not re-parented.
			expect(t?.storyId).toBe(duplicate.id);
		});
	},
);
