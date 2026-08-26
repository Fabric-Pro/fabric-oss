/**
 * Real-Postgres regression tests for the "no invisible duplicates" invariant
 * and the incremental duplicate-scan support queries.
 *
 * Invariant: a story is eligible for duplicate detection / can carry a
 * "Possible duplicate" chip IFF it is in the roadmap's DEFAULT-visible set —
 * `draftingStage notIn INACTIVE_STAGES` ([DECLINED, CLOSED]). This must mirror
 * the roadmap's `visibleStories` rule in
 * `apps/web/modules/saas/projects/components/stories/StoriesRoadmap.tsx`
 * (`draftingStage !== "DECLINED" && (showClosed || draftingStage !== "CLOSED")`).
 * Status-lane completion (`ProjectStoryStatus.isFinal`, e.g. a "Done" lane) is
 * intentionally NOT a filter: final-lane items still render on the roadmap, so
 * they stay scannable and countable. If either side of that pairing changes
 * without the other, these tests are meant to break — that drift is exactly
 * what would let a duplicate surface on an item the user cannot see.
 *
 * Also covers `countItemsWithPendingDuplicateLinks` (the completion modal's
 * headline count must equal the roadmap "Possible duplicates" filter's item
 * set) and the `StoryDuplicateEmbedding` cache round-trip used by the
 * incremental scan.
 *
 * No mocks — hits the live Postgres via the shared Prisma singleton.
 * Self-skips when DATABASE_URL is unset or is the CI placeholder
 * (`hasReachableDatabaseUrl`), mirroring the sibling integration suites.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { TERMINAL_DRAFTING_STAGES } from "../../../../utils";
import { db, FeatureDraftingStage, Prisma } from "../../../client";
import {
	listStoryDuplicateEmbeddingMetadata,
	listStoryDuplicateEmbeddings,
	setProjectLastDuplicateScanAt,
	upsertStoryDuplicateEmbeddings,
} from "../duplicate-embeddings";
import {
	countItemsWithPendingDuplicateLinks,
	INACTIVE_STAGES,
	listActiveStoriesForDetection,
	listPendingDuplicateLinks,
} from "../duplicate-links";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-dup-visibility-org-${RUN_ID}`;
const USER_ID = `test-dup-visibility-user-${RUN_ID}`;

const ALL_STAGES = Object.values(FeatureDraftingStage);
const ACTIVE_STAGES = ALL_STAGES.filter(
	(stage) => !INACTIVE_STAGES.includes(stage),
);

// Pure pin — runs everywhere, including CI without a database. WIDENING
// INACTIVE_STAGES is the dangerous direction: adding a stage the roadmap still
// displays (e.g. a mid-pipeline stage) would silently make visible items
// undetectable AND hide their existing chips, breaking the invariant from the
// other side. Update this only together with the roadmap's default-visibility
// rule (`StoriesRoadmap.visibleStories`).
describe("INACTIVE_STAGES — exact membership pin", () => {
	it("is exactly the roadmap's hidden-by-default stages", () => {
		expect(INACTIVE_STAGES).toEqual(["DECLINED", "CLOSED"]);
	});

	it("is sourced from the shared TERMINAL_DRAFTING_STAGES predicate set", () => {
		// The AI-Update apply gate (`applyBacklogChanges`) and the AI-Update dedup
		// index share this exact terminal set via `isTerminalWorkItemState`, so the
		// duplicate-detection scan can never drift from them on what "terminal"
		// means. (Reference identity — `INACTIVE_STAGES = TERMINAL_DRAFTING_STAGES`.)
		expect(INACTIVE_STAGES).toBe(TERMINAL_DRAFTING_STAGES);
	});
});

describe.skipIf(!hasReachableDatabaseUrl())(
	"duplicate detection visibility invariant (real Postgres)",
	() => {
		let storyCounter = 0;

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Dup Visibility User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Dup Visibility Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterEach(async () => {
			// Story deletes cascade duplicate links and embedding-cache rows
			// (onDelete: Cascade). FK order: stories → statuses → project.
			await db.userStory.deleteMany({ where: { createdById: USER_ID } });
			await db.projectStoryStatus.deleteMany({
				where: { project: { userId: USER_ID } },
			});
			await db.project.deleteMany({ where: { userId: USER_ID } });
		});

		async function seedProject() {
			const project = await db.project.create({
				data: {
					name: "Dup Visibility Project",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});
			const backlog = await db.projectStoryStatus.create({
				data: {
					projectId: project.id,
					name: "Backlog",
					color: "#94a3b8",
					order: 0,
					isDefault: true,
				},
			});
			const done = await db.projectStoryStatus.create({
				data: {
					projectId: project.id,
					name: "Done",
					color: "#22c55e",
					order: 1,
					isFinal: true,
				},
			});
			return { project, backlogId: backlog.id, doneId: done.id };
		}

		async function seedStory(args: {
			projectId: string;
			statusId: string;
			draftingStage: FeatureDraftingStage;
			title?: string;
		}) {
			storyCounter += 1;
			return db.userStory.create({
				data: {
					projectId: args.projectId,
					statusId: args.statusId,
					createdById: USER_ID,
					identifier: `F-${RUN_ID}-${storyCounter}`,
					title: args.title ?? `Story ${storyCounter}`,
					draftingStage: args.draftingStage,
				},
			});
		}

		async function seedPendingLink(
			projectId: string,
			first: string,
			second: string,
			status: "PENDING" | "DISMISSED" = "PENDING",
		) {
			const [storyAId, storyBId] =
				first < second ? [first, second] : [second, first];
			return db.storyDuplicateLink.create({
				data: {
					projectId,
					storyAId,
					storyBId,
					similarity: 0.91,
					confidence: 0.88,
					status,
				},
			});
		}

		it("listActiveStoriesForDetection returns exactly the roadmap default-visible set (isFinal lane included)", async () => {
			const { project, backlogId, doneId } = await seedProject();

			// One story per drafting stage…
			const byStage = new Map<FeatureDraftingStage, string>();
			for (const stage of ALL_STAGES) {
				const story = await seedStory({
					projectId: project.id,
					statusId: backlogId,
					draftingStage: stage,
				});
				byStage.set(stage, story.id);
			}
			// …plus an active-stage story parked in the FINAL ("Done") lane.
			// It is still visible on the roadmap, so it MUST stay detectable.
			const doneLaneStory = await seedStory({
				projectId: project.id,
				statusId: doneId,
				draftingStage: "PUBLISHED",
			});

			const detectable = await listActiveStoriesForDetection(project.id);
			const detectableIds = new Set(detectable.map((s) => s.id));

			// Exactly the non-DECLINED/CLOSED stages + the final-lane story.
			expect(detectableIds).toEqual(
				new Set([
					...ACTIVE_STAGES.map((stage) => byStage.get(stage)),
					doneLaneStory.id,
				]),
			);
			for (const stage of INACTIVE_STAGES) {
				expect(detectableIds.has(byStage.get(stage) as string)).toBe(
					false,
				);
			}
		});

		it("listPendingDuplicateLinks omits any link with a DECLINED or CLOSED side (no chip on a hidden item)", async () => {
			const { project, backlogId, doneId } = await seedProject();
			const active = await seedStory({
				projectId: project.id,
				statusId: backlogId,
				draftingStage: "DRAFT",
			});
			const finalLane = await seedStory({
				projectId: project.id,
				statusId: doneId,
				draftingStage: "PUBLISHED",
			});
			const declined = await seedStory({
				projectId: project.id,
				statusId: backlogId,
				draftingStage: "DECLINED",
			});
			const closed = await seedStory({
				projectId: project.id,
				statusId: backlogId,
				draftingStage: "CLOSED",
			});

			// Visible pair (one side in the final lane — still visible),
			// plus one link against each hidden stage.
			const visibleLink = await seedPendingLink(
				project.id,
				active.id,
				finalLane.id,
			);
			await seedPendingLink(project.id, active.id, declined.id);
			await seedPendingLink(project.id, finalLane.id, closed.id);

			const links = await listPendingDuplicateLinks(project.id);

			expect(links.map((l) => l.id)).toEqual([visibleLink.id]);
		});

		it("countItemsWithPendingDuplicateLinks counts distinct ACTIVE members of PENDING links only", async () => {
			const { project, backlogId } = await seedProject();
			const a = await seedStory({
				projectId: project.id,
				statusId: backlogId,
				draftingStage: "DRAFT",
			});
			const b = await seedStory({
				projectId: project.id,
				statusId: backlogId,
				draftingStage: "PUBLISHED",
			});
			const c = await seedStory({
				projectId: project.id,
				statusId: backlogId,
				draftingStage: "DRAFT",
			});
			const declined = await seedStory({
				projectId: project.id,
				statusId: backlogId,
				draftingStage: "DECLINED",
			});

			await seedPendingLink(project.id, a.id, b.id); // counts a + b
			await seedPendingLink(project.id, a.id, c.id); // adds c (a is distinct)
			await seedPendingLink(project.id, b.id, declined.id); // hidden side — ignored
			await seedPendingLink(project.id, b.id, c.id, "DISMISSED"); // not PENDING — ignored

			// {a, b, c} — the same set the roadmap "Possible duplicates"
			// filter would show, so the completion modal headline matches it.
			await expect(
				countItemsWithPendingDuplicateLinks(project.id),
			).resolves.toBe(3);
		});

		it("embedding cache round-trips number[] vectors and overwrites on re-upsert", async () => {
			const { project, backlogId } = await seedProject();
			const story = await seedStory({
				projectId: project.id,
				statusId: backlogId,
				draftingStage: "DRAFT",
			});

			await upsertStoryDuplicateEmbeddings(project.id, [
				{
					storyId: story.id,
					contentHash: "hash-v1",
					model: "text-embedding-3-small",
					embedding: [0.1, 0.2, 0.3],
				},
			]);

			const first = await listStoryDuplicateEmbeddings(project.id);
			expect(first).toEqual([
				{
					storyId: story.id,
					contentHash: "hash-v1",
					model: "text-embedding-3-small",
					embedding: [0.1, 0.2, 0.3],
				},
			]);

			// The staleness fast path reads the same rows WITHOUT the vector
			// column — same metadata, no `embedding` key.
			const meta = await listStoryDuplicateEmbeddingMetadata(project.id);
			expect(meta).toEqual([
				{
					storyId: story.id,
					contentHash: "hash-v1",
					model: "text-embedding-3-small",
				},
			]);

			// Re-upsert after a content edit: same storyId row, new hash+vector.
			await upsertStoryDuplicateEmbeddings(project.id, [
				{
					storyId: story.id,
					contentHash: "hash-v2",
					model: "text-embedding-3-small",
					embedding: [0.4, 0.5],
				},
			]);

			const second = await listStoryDuplicateEmbeddings(project.id);
			expect(second).toHaveLength(1);
			expect(second[0]).toMatchObject({
				contentHash: "hash-v2",
				embedding: [0.4, 0.5],
			});
		});

		it("setProjectLastDuplicateScanAt stamps the project", async () => {
			const { project } = await seedProject();
			expect(project.lastDuplicateScanAt).toBeNull();

			const when = new Date("2026-01-02T03:04:05.000Z");
			await setProjectLastDuplicateScanAt(project.id, when);

			const reloaded = await db.project.findUnique({
				where: { id: project.id },
				select: { lastDuplicateScanAt: true },
			});
			expect(reloaded?.lastDuplicateScanAt?.toISOString()).toBe(
				when.toISOString(),
			);
		});
	},
);
