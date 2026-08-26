/**
 * Real-Postgres integration tests for PM-link handling in `mergeDuplicateStories`
 * (spec 2026-06-02-merge-pm-link-handling §9.1–§9.2) plus the optional-`tx`
 * refactor of `updateStoryDraftingStage` (§5.2).
 *
 * Covered:
 *   - `keep-survivor`: nulls the discarded story's full PM-link cluster (DV-3),
 *     leaves the survivor untouched, retires the duplicate to CLOSED + stamps mergedIntoStoryId.
 *   - `transfer-from-duplicate` (UC1): the survivor INHERITS the discarded's full
 *     cluster incl. sync state (DV-5); the discarded's cluster is nulled.
 *   - `transfer-from-duplicate` (UC3-different): the survivor's own link is
 *     replaced by the discarded's; the null-then-write ordering keeps the partial
 *     unique index `(projectId, externalId)` satisfied (exactly one carrier).
 *   - Tasks re-parent + pending duplicate links resolve, unchanged.
 *   - `updateStoryDraftingStage` optional `tx`: self-transacts without `tx`;
 *     participates in (and rolls back with) the caller's transaction when given.
 *
 * The UC3 same-externalId branch is intentionally NOT covered here: the partial
 * unique index physically forbids two stories in one project sharing a non-null
 * externalId, so the state is unreachable through normal inserts (which is why
 * the production path only logs a defensive warning). Its classification is
 * covered by the `classifyMergeLinkScenario` unit test.
 *
 * No mocks — hits the live Aspire Postgres via the shared Prisma singleton.
 * Self-skips when DATABASE_URL is unset or is the CI placeholder
 * (`hasReachableDatabaseUrl`), mirroring the sibling integration suites.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma } from "../../../client";
import { mergeDuplicateStories } from "../duplicate-links";
import { updateStoryDraftingStage } from "../stories";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-merge-pmlink-org-${RUN_ID}`;
const USER_ID = `test-merge-pmlink-user-${RUN_ID}`;

/** The cluster after nulling — what a discarded story's PM-link fields become. */
const NULLED_CLUSTER = {
	externalId: null,
	externalUrl: null,
	externalMcpServerId: null,
	pmAutoSyncEnabled: false,
	lastSyncedAt: null,
	lastPmSyncStatus: null,
	lastSyncedPmHash: null,
	lastPmSyncAttemptAt: null,
	lastPmSyncError: null,
	lastSyncedStatusId: null,
};

describe.skipIf(!hasReachableDatabaseUrl())(
	"mergeDuplicateStories — PM link handling (real Postgres)",
	() => {
		let storyCounter = 0;

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Merge PMLink User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Merge PMLink Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterEach(async () => {
			// Deleting the stories cascades their tasks, versions, and duplicate
			// links (all onDelete: Cascade). FK order: stories → statuses → project.
			await db.userStory.deleteMany({ where: { createdById: USER_ID } });
			await db.projectStoryStatus.deleteMany({
				where: { project: { userId: USER_ID } },
			});
			await db.project.deleteMany({ where: { userId: USER_ID } });
		});

		async function seedProject() {
			const project = await db.project.create({
				data: {
					name: "Merge PMLink Project",
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
			return { project, statusId: status.id };
		}

		async function seedStory(args: {
			projectId: string;
			statusId: string;
			link?: string; // externalId; omit for an unlinked story
		}) {
			storyCounter += 1;
			const linkData = args.link
				? {
						externalId: args.link,
						externalUrl: `https://gitlab.com/acme/app/-/issues/${args.link}`,
						externalMcpServerId: `mcp-${args.link}`,
						pmAutoSyncEnabled: true,
						lastSyncedAt: new Date("2026-05-01T00:00:00.000Z"),
						lastPmSyncStatus: "SUCCESS" as const,
						lastSyncedPmHash: `hash-${args.link}`,
						lastPmSyncAttemptAt: new Date(
							"2026-05-01T00:00:00.000Z",
						),
						lastPmSyncError: null,
						lastSyncedStatusId: args.statusId,
					}
				: {};
			return db.userStory.create({
				data: {
					projectId: args.projectId,
					statusId: args.statusId,
					createdById: USER_ID,
					identifier: `F-${RUN_ID}-${storyCounter}`,
					title: `Story ${storyCounter}`,
					...linkData,
				},
			});
		}

		it("keep-survivor nulls the discarded's cluster, leaves the survivor untouched, declines the duplicate", async () => {
			const { project, statusId } = await seedProject();
			const survivor = await seedStory({
				projectId: project.id,
				statusId,
			});
			const duplicate = await seedStory({
				projectId: project.id,
				statusId,
				link: "111",
			});

			await mergeDuplicateStories({
				projectId: project.id,
				survivorId: survivor.id,
				duplicateId: duplicate.id,
				userId: USER_ID,
				pmLink: "keep-survivor",
			});

			const [s, d] = await Promise.all([
				db.userStory.findUnique({ where: { id: survivor.id } }),
				db.userStory.findUnique({ where: { id: duplicate.id } }),
			]);
			expect(s?.externalId).toBeNull();
			expect(d).toMatchObject(NULLED_CLUSTER);
			expect(d?.draftingStage).toBe("CLOSED");
			expect(d?.mergedIntoStoryId).toBe(survivor.id);
		});

		it("transfer-from-duplicate (UC1) makes the survivor inherit the full cluster and nulls the discarded", async () => {
			const { project, statusId } = await seedProject();
			const survivor = await seedStory({
				projectId: project.id,
				statusId,
			});
			const duplicate = await seedStory({
				projectId: project.id,
				statusId,
				link: "222",
			});

			const result = await mergeDuplicateStories({
				projectId: project.id,
				survivorId: survivor.id,
				duplicateId: duplicate.id,
				userId: USER_ID,
				pmLink: "transfer-from-duplicate",
			});

			const [s, d] = await Promise.all([
				db.userStory.findUnique({ where: { id: survivor.id } }),
				db.userStory.findUnique({ where: { id: duplicate.id } }),
			]);
			// Survivor inherits the discarded's link + sync state (DV-5).
			expect(result.survivorExternalId).toBe("222");
			expect(s?.externalId).toBe("222");
			expect(s?.externalUrl).toBe(duplicate.externalUrl);
			expect(s?.externalMcpServerId).toBe(duplicate.externalMcpServerId);
			expect(s?.pmAutoSyncEnabled).toBe(true);
			expect(s?.lastSyncedPmHash).toBe(duplicate.lastSyncedPmHash);
			expect(s?.lastPmSyncStatus).toBe("SUCCESS");
			expect(s?.lastSyncedAt?.toISOString()).toBe(
				duplicate.lastSyncedAt?.toISOString(),
			);
			expect(s?.lastSyncedStatusId).toBe(duplicate.lastSyncedStatusId);
			// Discarded cluster nulled; duplicate CLOSED + marked merged.
			expect(d).toMatchObject(NULLED_CLUSTER);
			expect(d?.draftingStage).toBe("CLOSED");
			expect(d?.mergedIntoStoryId).toBe(survivor.id);
		});

		it("transfer-from-duplicate (UC3-different) replaces the survivor's link; ordering keeps the unique index satisfied", async () => {
			const { project, statusId } = await seedProject();
			const survivor = await seedStory({
				projectId: project.id,
				statusId,
				link: "S-1",
			});
			const duplicate = await seedStory({
				projectId: project.id,
				statusId,
				link: "D-2",
			});

			await mergeDuplicateStories({
				projectId: project.id,
				survivorId: survivor.id,
				duplicateId: duplicate.id,
				userId: USER_ID,
				pmLink: "transfer-from-duplicate",
			});

			const s = await db.userStory.findUnique({
				where: { id: survivor.id },
			});
			expect(s?.externalId).toBe("D-2");
			// Null-then-write ordering: exactly one row carries "D-2"; the
			// survivor's old "S-1" is fully discarded.
			expect(
				await db.userStory.count({
					where: { projectId: project.id, externalId: "D-2" },
				}),
			).toBe(1);
			expect(
				await db.userStory.count({
					where: { projectId: project.id, externalId: "S-1" },
				}),
			).toBe(0);
		});

		it("re-parents the duplicate's tasks and resolves the pending duplicate link", async () => {
			const { project, statusId } = await seedProject();
			const survivor = await seedStory({
				projectId: project.id,
				statusId,
			});
			const duplicate = await seedStory({
				projectId: project.id,
				statusId,
				link: "333",
			});
			const task = await db.storyTask.create({
				data: {
					storyId: duplicate.id,
					identifier: `TASK-${RUN_ID}`,
					title: "carried task",
					order: 0,
				},
			});
			// Canonical ordering storyAId < storyBId.
			const [aId, bId] = [survivor.id, duplicate.id].sort();
			const linkRow = await db.storyDuplicateLink.create({
				data: {
					projectId: project.id,
					storyAId: aId,
					storyBId: bId,
					similarity: 0.95,
					confidence: 0.9,
					status: "PENDING",
				},
			});

			await mergeDuplicateStories({
				projectId: project.id,
				survivorId: survivor.id,
				duplicateId: duplicate.id,
				userId: USER_ID,
			});

			const [movedTask, resolvedLink] = await Promise.all([
				db.storyTask.findUnique({ where: { id: task.id } }),
				db.storyDuplicateLink.findUnique({ where: { id: linkRow.id } }),
			]);
			expect(movedTask?.storyId).toBe(survivor.id);
			expect(resolvedLink?.status).toBe("RESOLVED");
			expect(resolvedLink?.resolvedById).toBe(USER_ID);
		});

		describe("updateStoryDraftingStage optional tx", () => {
			it("self-transacts and updates the stage when no tx is given", async () => {
				const { project, statusId } = await seedProject();
				const story = await seedStory({
					projectId: project.id,
					statusId,
				});
				await updateStoryDraftingStage(
					story.id,
					project.id,
					"DECLINED",
					{
						userId: USER_ID,
						changedBy: USER_ID,
						lastEditedSource: "MANUAL",
					},
				);
				const after = await db.userStory.findUnique({
					where: { id: story.id },
				});
				expect(after?.draftingStage).toBe("DECLINED");
			});

			it("participates in the caller's transaction and rolls back with it", async () => {
				const { project, statusId } = await seedProject();
				const story = await seedStory({
					projectId: project.id,
					statusId,
				});
				await expect(
					db.$transaction(async (tx) => {
						await updateStoryDraftingStage(
							story.id,
							project.id,
							"DECLINED",
							{
								userId: USER_ID,
								changedBy: USER_ID,
								lastEditedSource: "MANUAL",
							},
							tx,
						);
						throw new Error("force rollback");
					}),
				).rejects.toThrow(/force rollback/);
				const after = await db.userStory.findUnique({
					where: { id: story.id },
				});
				// The stage change was rolled back with the caller's transaction —
				// proving it ran against `tx`, not a private one.
				expect(after?.draftingStage).not.toBe("DECLINED");
			});
		});
	},
);
