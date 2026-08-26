/**
 * Real-Postgres proof of the separation this change exists for.
 *
 * The reported bug: opening a feature seeds its Logic Summary and scan hashes,
 * those writes land on the `user_story` row, and because `updatedAt` is
 * `@updatedAt` the timestamp the UI presented as the human "Updated" time moved
 * without anyone editing anything.
 *
 * A mocked unit test cannot show this, because the thing that moves `updatedAt`
 * is Postgres applying Prisma's `@updatedAt` on a real write. So these hit the
 * live Aspire Postgres through the production query layer, no mocks.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder, mirroring the
 * sibling integration suites.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import {
	type BackfillClient,
	backfillLastEditedAt,
} from "../../../../scripts/backfill-last-edited-at";
import { db, Prisma } from "../../../client";
import {
	setLastQuestionScanHash,
	setLastSummaryHash,
	setSummaryDigest,
} from "../../feature-maturation";
import { writePmSyncItemContent } from "../pm-sync-resolve";
import { updateStory } from "../stories";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-last-edit-org-${RUN_ID}`;
const USER_ID = `test-last-edit-user-${RUN_ID}`;

describe.skipIf(!hasReachableDatabaseUrl())(
	"the semantic edit clock vs the row-write clock (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Last Edit User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Last Edit Org"}, ${ORG_ID}, ${now})
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

		async function seedStory() {
			const project = await db.project.create({
				data: {
					name: "Last Edit Project",
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
			const story = await db.userStory.create({
				data: {
					projectId: project.id,
					statusId: status.id,
					identifier: "1",
					title: "Original title",
					createdById: USER_ID,
				},
			});
			return { projectId: project.id, storyId: story.id };
		}

		function readClocks(storyId: string) {
			return db.userStory.findUniqueOrThrow({
				where: { id: storyId },
				select: {
					updatedAt: true,
					lastEditedAt: true,
					lastEditedByName: true,
					lastEditedSource: true,
				},
			});
		}

		it("seeding a summary moves the row clock and leaves the edit event untouched", async () => {
			const { projectId, storyId } = await seedStory();
			const before = await readClocks(storyId);
			expect(before.lastEditedAt).toBeNull();

			// Exactly what opening a feature triggers.
			await setSummaryDigest({
				userStoryId: storyId,
				projectId,
				summaryDigest: "a generated summary",
			});
			await setLastSummaryHash({
				userStoryId: storyId,
				projectId,
				hash: "summary-hash",
			});
			await setLastQuestionScanHash({
				userStoryId: storyId,
				projectId,
				hash: "scan-hash",
			});

			const after = await readClocks(storyId);
			// The row clock moved — this is the write that used to be presented
			// to the user as "Updated".
			expect(after.updatedAt.getTime()).toBeGreaterThan(
				before.updatedAt.getTime(),
			);
			// The edit event did not. Nobody edited anything.
			expect(after.lastEditedAt).toBeNull();
			expect(after.lastEditedByName).toBeNull();
			expect(after.lastEditedSource).toBeNull();
		});

		it("a real edit moves the edit event, with who and where from", async () => {
			const { projectId, storyId } = await seedStory();

			await updateStory(
				storyId,
				projectId,
				{ title: "A genuinely new title" },
				{
					userId: USER_ID,
					lastEditedByName: "Ada Lovelace",
					lastEditedSource: "MANUAL",
				},
			);

			const after = await readClocks(storyId);
			expect(after.lastEditedAt).toBeInstanceOf(Date);
			expect(after.lastEditedByName).toBe("Ada Lovelace");
			expect(after.lastEditedSource).toBe("MANUAL");
		});

		it("re-submitting the same title is not an edit", async () => {
			const { projectId, storyId } = await seedStory();
			await updateStory(
				storyId,
				projectId,
				{ title: "Settled title" },
				{
					lastEditedByName: "Ada Lovelace",
					lastEditedSource: "MANUAL",
				},
			);
			const afterFirst = await readClocks(storyId);

			await updateStory(
				storyId,
				projectId,
				{ title: "Settled title" },
				{
					lastEditedByName: "Someone Else",
					lastEditedSource: "MANUAL",
				},
			);
			const afterSecond = await readClocks(storyId);

			expect(afterSecond.lastEditedAt?.getTime()).toBe(
				afterFirst.lastEditedAt?.getTime(),
			);
			expect(afterSecond.lastEditedByName).toBe("Ada Lovelace");
		});

		it("refuses to record a genuine edit with no attribution", async () => {
			const { projectId, storyId } = await seedStory();

			await expect(
				updateStory(storyId, projectId, { title: "Unattributed" }),
			).rejects.toThrow(/require last-edit context/i);

			const after = await readClocks(storyId);
			expect(after.lastEditedAt).toBeNull();
		});

		// PM tools do not guarantee a stable label order between polls. Treating
		// a reorder as an edit would let a sync that changed nothing stamp the
		// clock — the exact thing this change exists to prevent.
		it("does not count a label reorder as an edit", async () => {
			const { projectId, storyId } = await seedStory();
			await updateStory(
				storyId,
				projectId,
				{ labels: ["backend", "urgent"] },
				{
					lastEditedByName: "Ada Lovelace",
					lastEditedSource: "MANUAL",
				},
			);
			const first = await readClocks(storyId);

			await updateStory(
				storyId,
				projectId,
				{ labels: ["urgent", "backend"] },
				{
					lastEditedByName: "Someone Else",
					lastEditedSource: "PM_PULL",
				},
			);
			const second = await readClocks(storyId);

			expect(second.lastEditedAt?.getTime()).toBe(
				first.lastEditedAt?.getTime(),
			);
			expect(second.lastEditedByName).toBe("Ada Lovelace");
		});

		// A derived write moves `updatedAt`. If that were the concurrency token,
		// background seeding landing mid-edit would fail a legitimate save.
		it("survives a derived write landing between read and write", async () => {
			const { projectId, storyId } = await seedStory();
			await setSummaryDigest({
				userStoryId: storyId,
				projectId,
				summaryDigest: "seeded before the edit",
			});

			await expect(
				updateStory(
					storyId,
					projectId,
					{ priority: "P1_HIGH" },
					{
						lastEditedByName: "Ada Lovelace",
						lastEditedSource: "MANUAL",
					},
				),
			).resolves.toBeDefined();

			const after = await readClocks(storyId);
			expect(after.lastEditedByName).toBe("Ada Lovelace");
		});

		// The optimistic-concurrency token must actually be able to FAIL.
		// `version` could not: nothing on this write path advances it, so two
		// concurrent edits both matched and one was silently lost.
		it("rejects a second write holding a stale edit clock", async () => {
			const { projectId, storyId } = await seedStory();
			await updateStory(
				storyId,
				projectId,
				{ priority: "P1_HIGH" },
				{ lastEditedByName: "First", lastEditedSource: "MANUAL" },
			);
			const afterFirst = await readClocks(storyId);

			// Simulate a writer that read the row before the first edit landed.
			const stale = await db.userStory.updateMany({
				where: { id: storyId, projectId, lastEditedAt: null },
				data: { priority: "P3_LOW" },
			});
			expect(stale.count).toBe(0);

			// The current token still matches, so a well-formed write proceeds.
			const current = await db.userStory.updateMany({
				where: {
					id: storyId,
					projectId,
					lastEditedAt: afterFirst.lastEditedAt,
				},
				data: { priority: "P3_LOW" },
			});
			expect(current.count).toBe(1);
		});

		// The requirement named this path explicitly: a human resolving a PM
		// conflict is an edit, and it is theirs.
		it("credits the human who resolves a PM sync conflict", async () => {
			const { projectId, storyId } = await seedStory();

			await writePmSyncItemContent({
				itemType: "story",
				itemId: storyId,
				projectId,
				title: "Resolved from the PM side",
				lastEditedByName: "Grace Hopper",
				lastEditedSource: "CONFLICT_RESOLUTION",
			});

			const after = await readClocks(storyId);
			expect(after.lastEditedAt).toBeInstanceOf(Date);
			expect(after.lastEditedByName).toBe("Grace Hopper");
			expect(after.lastEditedSource).toBe("CONFLICT_RESOLUTION");
		});

		it("does not count a conflict write that changes nothing", async () => {
			const { projectId, storyId } = await seedStory();
			await writePmSyncItemContent({
				itemType: "story",
				itemId: storyId,
				projectId,
				title: "Settled by resolution",
				lastEditedByName: "Grace Hopper",
				lastEditedSource: "CONFLICT_RESOLUTION",
			});
			const first = await readClocks(storyId);

			// Same content again — the resolve dialog re-submitting must not
			// invent a second edit event.
			await writePmSyncItemContent({
				itemType: "story",
				itemId: storyId,
				projectId,
				title: "Settled by resolution",
				lastEditedByName: "Someone Else",
				lastEditedSource: "CONFLICT_RESOLUTION",
			});
			const second = await readClocks(storyId);

			expect(second.lastEditedAt?.getTime()).toBe(
				first.lastEditedAt?.getTime(),
			);
			expect(second.lastEditedByName).toBe("Grace Hopper");
		});
	},
);

describe.skipIf(!hasReachableDatabaseUrl())(
	"the historical backfill (real Postgres)",
	() => {
		const RUN = `${Date.now()}-${process.pid}-bf`;
		const USER = `test-bf-user-${RUN}`;

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER}, ${"Backfill User"}, ${`${USER}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});
		afterEach(async () => {
			await db.userStory.deleteMany({ where: { createdById: USER } });
			await db.projectStoryStatus.deleteMany({
				where: { project: { userId: USER } },
			});
			await db.project.deleteMany({ where: { userId: USER } });
		});

		async function seedRow(fields: {
			lastEditedAt?: Date | null;
			lastEditedByName?: string | null;
			priorityChangedAt?: Date | null;
		}) {
			const project = await db.project.create({
				data: { name: "Backfill Project", userId: USER },
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
			const story = await db.userStory.create({
				data: {
					projectId: project.id,
					statusId: status.id,
					identifier: "1",
					title: "Backfill subject",
					createdById: USER,
					// Older than every stamp below: the job refuses to claim an
					// edit that predates the row, so a just-created row would be
					// skipped and prove nothing.
					createdAt: new Date(Date.now() - 90 * 86_400_000),
					lastEditedAt: fields.lastEditedAt ?? null,
					lastEditedByName: fields.lastEditedByName ?? null,
					lastEditedSource: fields.lastEditedByName ? "MANUAL" : null,
					priorityChangedAt: fields.priorityChangedAt ?? null,
				},
			});
			return story.id;
		}

		it("fills a clock from a priority move and refuses to credit the old author for it", async () => {
			const priorityAt = new Date(Date.now() - 10 * 86_400_000);
			const id = await seedRow({
				lastEditedAt: null,
				lastEditedByName: "Author Of An Earlier Text Edit",
				priorityChangedAt: priorityAt,
			});

			await backfillLastEditedAt({ apply: true });

			const row = await db.userStory.findUniqueOrThrow({
				where: { id },
				select: {
					lastEditedAt: true,
					lastEditedByName: true,
					lastEditedSource: true,
				},
			});
			expect(row.lastEditedAt?.getTime()).toBe(priorityAt.getTime());
			// The name described a title/description edit, not this priority
			// move — crediting it here would name the wrong person.
			expect(row.lastEditedByName).toBeNull();
			expect(row.lastEditedSource).toBeNull();
		});

		// The job must never touch a row it did not write. A real edit to a
		// field that creates no version snapshot (priority, status, labels,
		// assignee, size, points, maturation status, needs-more-info) is
		// indistinguishable from a backfilled row by timing alone — which is
		// why this job has no repair pass.
		it("leaves a genuine non-version edit completely alone", async () => {
			const editedAt = new Date(Date.now() - 10 * 86_400_000);
			const id = await seedRow({
				lastEditedAt: editedAt,
				lastEditedByName: "Real Editor",
			});

			await backfillLastEditedAt({ apply: true });

			const row = await db.userStory.findUniqueOrThrow({
				where: { id },
				select: { lastEditedAt: true, lastEditedByName: true },
			});
			expect(row.lastEditedAt?.getTime()).toBe(editedAt.getTime());
			expect(row.lastEditedByName).toBe("Real Editor");
		});

		// The failure this guards against reached production. The first version
		// of the job issued one UPDATE per row inside a single `$transaction`;
		// against a backlog bigger than the one it was written on, the first
		// batch of 500 exceeded Prisma's 5s transaction timeout, failed the
		// seed step and took the whole release down with it. Every test above
		// uses a handful of rows and passes happily on either implementation —
		// only crossing a batch boundary tells them apart.
		//
		// This also pins the loop's termination. The job no longer carries a
		// cursor: it relies on each pass setting the very column it filters on,
		// so a mistake there is an infinite loop rather than a wrong value.
		it("fills a backlog larger than one batch, at a fixed cost, and terminates", async () => {
			const ROWS = 1_200; // > 2 batches at BATCH_SIZE 500
			const createdAt = new Date(Date.now() - 90 * 86_400_000);
			const priorityAt = new Date(Date.now() - 10 * 86_400_000);

			const project = await db.project.create({
				data: { name: "Backfill Scale Project", userId: USER },
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

			// One statement — creating 1200 rows through the client would make
			// the fixture slower than the thing under test.
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user_story"
					(id, "projectId", "statusId", identifier, title, "createdById",
					 "createdAt", "updatedAt", "priorityChangedAt",
					 "lastEditedAt", "lastEditedByName", "lastEditedSource")
				SELECT
					'scale-' || ${RUN_ID}::text || '-' || g::text,
					${project.id}, ${status.id}, g::text, 'Scale subject', ${USER},
					${createdAt}, ${createdAt}, ${priorityAt},
					NULL,
					-- Half carry a stale author, so both CASE branches of the
					-- set-based update are exercised inside the same statement.
					CASE WHEN g % 2 = 0 THEN 'Author Of An Earlier Text Edit' END,
					CASE WHEN g % 2 = 0 THEN 'MANUAL'::"LastEditSource" END
				FROM generate_series(1, ${ROWS}) AS g
			`);

			// Counting the round trips is what separates the two implementations
			// on a local database. Correctness alone does not: the per-row
			// version filled these rows perfectly too, just 1200 round trips at
			// a time, which only a remote database punishes.
			let writes = 0;
			const counting: BackfillClient = {
				$executeRaw: (query, ...values) => {
					writes++;
					return db.$executeRaw(query, ...values);
				},
				$queryRaw: (query, ...values) => db.$queryRaw(query, ...values),
				// Only the writes need counting; the reads pass straight through.
				userStory: db.userStory,
			};

			const { filled } = await backfillLastEditedAt({
				apply: true,
				client: counting,
			});
			expect(filled).toBeGreaterThanOrEqual(ROWS);

			// 1200 rows is 3 batches of 500 plus the pass that returns 0 and
			// ends the loop. Anything proportional to ROWS is the regression.
			expect(writes).toBeLessThanOrEqual(6);

			const stillNull = await db.userStory.count({
				where: { projectId: project.id, lastEditedAt: null },
			});
			expect(stillNull).toBe(0);

			// A priority stamp is not a content edit, so no row keeps its author
			// — including the ones seeded with one.
			const stillAttributed = await db.userStory.count({
				where: {
					projectId: project.id,
					lastEditedByName: { not: null },
				},
			});
			expect(stillAttributed).toBe(0);

			const sample = await db.userStory.findFirstOrThrow({
				where: { projectId: project.id },
				select: { lastEditedAt: true },
			});
			expect(sample.lastEditedAt?.getTime()).toBe(priorityAt.getTime());
		}, 60_000);
	},
);
