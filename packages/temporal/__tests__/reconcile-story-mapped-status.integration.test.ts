/**
 * The PM status sync's per-story leaf against REAL Postgres (Fizzy #2304, spec
 * §4.4 and §6 rule 3).
 *
 * Every write the leaf makes is a compare-and-set on the row the poll read:
 * `{ statusId, pmStatusSyncBaseId, pmStatusSyncBaseAt, pmStatusSyncBaseLink,
 * pmStatusSyncBaseFabricId }`. The unit suite pins the WHERE clause it builds;
 * only Postgres can show that the clause refuses a row that moved underneath
 * it. A stale Fabric status, base, ticket clock, link key or base Fabric status
 * each leaves the row untouched, writes no audit event and no sync-log row, and
 * reports `raced`. The CONFLICT dedupe is here for the same reason: whether a
 * second identical cycle adds a row is a question about the rows already in
 * the table.
 *
 * Gated on RUN_DB_INTEGRATION=1 like the other DB-backed suites in this
 * package; `.github/workflows/db-integration.yml` runs it with an exact-count
 * guard.
 */

import { db, Prisma } from "@repo/database";
import { PM_STATUS_SYNC_SENTINEL } from "@repo/integrations/pm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	reconcileStoryMappedStatus,
	STATUS_SYNC_STORY_SELECT,
	type StatusSyncStoryRow,
} from "../src/activities/pm-integration/reconcile-story-mapped-status";

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const RUN = `${Date.now()}-${process.pid}`;
const USER = `pss-leaf-user-${RUN}`;
const ORG = `pss-leaf-org-${RUN}`;
const PROJECT = `pss-leaf-project-${RUN}`;
const ISSUES =
	"https://gitlab.example.com/example-group/example-project/-/issues";
const BASE_AT = new Date("2026-09-20T08:00:00.000Z");
const TICKET_CHANGED = new Date("2026-09-21T09:00:00.000Z");
const LABEL_REVIEW = "workflow::in-review";
const LABEL_BLOCKED = "workflow::blocked";

let backlogId = "";
let reviewId = "";
let blockedId = "";
let nextNumber = 1;

async function seedStory(
	title: string,
	data: {
		statusId?: string;
		baseId?: string | null;
		baseAt?: Date | null;
		baseLink?: string | null;
		baseFabricId?: string | null;
		order?: number;
	} = {},
): Promise<StatusSyncStoryRow> {
	const n = nextNumber++;
	const url = `${ISSUES}/${n}`;
	const statusId = data.statusId ?? backlogId;
	const baseId = data.baseId === undefined ? backlogId : data.baseId;
	return db.userStory.create({
		data: {
			projectId: PROJECT,
			statusId,
			identifier: `PSS-${n}`,
			title,
			createdById: USER,
			order: data.order ?? n,
			externalId: String(n),
			externalUrl: url,
			pmStatusSyncBaseId: baseId,
			pmStatusSyncBaseAt:
				data.baseAt === undefined ? BASE_AT : data.baseAt,
			pmStatusSyncBaseLink:
				data.baseLink === undefined ? url : data.baseLink,
			// As the writers leave it: observed while Fabric showed the base's
			// own status (rows 8/10 and the push stamps write F = P).
			pmStatusSyncBaseFabricId:
				data.baseFabricId === undefined ? baseId : data.baseFabricId,
		},
		select: STATUS_SYNC_STORY_SELECT,
	});
}

function runLeaf(
	story: StatusSyncStoryRow,
	labels: string[],
	stateChangedDate: Date = TICKET_CHANGED,
) {
	return reconcileStoryMappedStatus({
		projectId: PROJECT,
		tenant: { organizationId: ORG, ownerUserId: USER },
		item: {
			externalId: story.externalId ?? "",
			state: "",
			labels,
			stateChangedDate,
			itemUrl: story.externalUrl,
		},
		story,
		config: {
			labelStatusMap: {
				[LABEL_REVIEW]: reviewId,
				[LABEL_BLOCKED]: blockedId,
			},
			statusColumnMap: {},
			projectStatuses: [
				{ id: backlogId, name: "Backlog" },
				{ id: reviewId, name: "In Review" },
				{ id: blockedId, name: "Blocked" },
			],
		},
		source: {
			isRest: true,
			activeServerId: "key:gitlab-official",
			pmToolKey: "gitlab-official",
			pmToolLabel: "GitLab",
			// REST never consults a trusted org (Task 4 contract).
			activeOrg: null,
		},
	});
}

const readStory = (id: string): Promise<StatusSyncStoryRow> =>
	db.userStory.findUniqueOrThrow({
		where: { id },
		select: STATUS_SYNC_STORY_SELECT,
	});

const auditCount = (storyId: string) =>
	db.auditLog.count({
		where: { resourceId: storyId, action: "story.pm_status_synced" },
	});

const pullLogRows = (storyId: string, status: "SUCCESS" | "CONFLICT") =>
	db.pmSyncLog.findMany({
		where: {
			projectId: PROJECT,
			entityId: storyId,
			direction: "pull",
			status,
		},
	});

/** A fresh story the leaf must move — the positive control every stale case runs first. */
async function expectMovedControl(title: string) {
	const control = await seedStory(title);
	await expect(runLeaf(control, [LABEL_REVIEW])).resolves.toEqual({
		outcome: "moved",
	});
	expect((await readStory(control.id)).statusId).toBe(reviewId);
	await vi.waitFor(
		async () => {
			expect(await auditCount(control.id)).toBe(1);
		},
		{ timeout: 5_000, interval: 100 },
	);
}

/** The leaf decides `moved` from `snapshot`, but the row no longer matches it. */
async function expectRaced(snapshot: StatusSyncStoryRow) {
	const before = await readStory(snapshot.id);
	await expect(runLeaf(snapshot, [LABEL_REVIEW])).resolves.toEqual({
		outcome: "raced",
	});
	expect(await readStory(snapshot.id)).toEqual(before);
	expect(await pullLogRows(snapshot.id, "SUCCESS")).toHaveLength(0);
	expect(await auditCount(snapshot.id)).toBe(0);
}

describe.skipIf(!RUN_DB)("reconcileStoryMappedStatus (real Postgres)", () => {
	beforeAll(async () => {
		const now = new Date();
		await db.$executeRaw(Prisma.sql`
			INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
			VALUES (${USER}, ${"Status Sync Leaf"}, ${`${USER}@example.com`}, true, true, ${now}, ${now})
			ON CONFLICT (id) DO NOTHING
		`);
		await db.$executeRaw(Prisma.sql`
			INSERT INTO "organization" (id, name, slug, "createdAt")
			VALUES (${ORG}, ${"Status Sync Leaf Org"}, ${ORG}, ${now})
			ON CONFLICT (id) DO NOTHING
		`);
		await db.project.create({
			data: {
				id: PROJECT,
				name: `Status sync leaf ${RUN}`,
				userId: USER,
				organizationId: ORG,
				projectManagementMcpServerId: "key:gitlab-official",
				projectManagementContainerId: "4711",
				pmStatusSyncEnabled: true,
				pmStatusSyncSessionAt: BASE_AT,
			},
		});
		const make = (name: string, order: number, isDefault = false) =>
			db.projectStoryStatus.create({
				data: {
					projectId: PROJECT,
					name,
					color: "#94a3b8",
					order,
					isDefault,
				},
			});
		backlogId = (await make("Backlog", 0, true)).id;
		reviewId = (await make("In Review", 1)).id;
		blockedId = (await make("Blocked", 2)).id;
	});

	afterAll(async () => {
		await db.pmSyncLog.deleteMany({ where: { projectId: PROJECT } });
		await db.userStory.deleteMany({ where: { projectId: PROJECT } });
		await db.projectStoryStatus.deleteMany({
			where: { projectId: PROJECT },
		});
		await db.project.deleteMany({ where: { id: PROJECT } });
	});

	it("moves a story whose ticket's mapped status changed, appends it to the column, and records the move once", async () => {
		const occupant = await seedStory("Already in review", {
			statusId: reviewId,
			baseId: reviewId,
			order: 50,
		});
		const story = await seedStory("Checkout flow");

		await expect(
			runLeaf(story, [LABEL_REVIEW, "priority::high"]),
		).resolves.toEqual({ outcome: "moved" });

		const after = await db.userStory.findUniqueOrThrow({
			where: { id: story.id },
			select: {
				statusId: true,
				order: true,
				pmStatusSyncBaseId: true,
				pmStatusSyncBaseAt: true,
				pmStatusSyncBaseLink: true,
				pmStatusSyncBaseFabricId: true,
				lastEditedAt: true,
				lastEditedSource: true,
				lastEditedByName: true,
			},
		});
		expect(after.statusId).toBe(reviewId);
		expect(after.order).toBeGreaterThan(occupant.order);
		expect(after.pmStatusSyncBaseId).toBe(reviewId);
		expect(after.pmStatusSyncBaseAt).toEqual(TICKET_CHANGED);
		expect(after.pmStatusSyncBaseLink).toBe(story.externalUrl);
		expect(after.pmStatusSyncBaseFabricId).toBe(reviewId);
		expect(after.lastEditedSource).toBe("PM_PULL");
		expect(after.lastEditedByName).toBeNull();
		expect(after.lastEditedAt).not.toBeNull();

		const success = await pullLogRows(story.id, "SUCCESS");
		expect(success).toHaveLength(1);
		expect(success[0]).toMatchObject({ organizationId: ORG, userId: null });

		await vi.waitFor(
			async () => {
				expect(await auditCount(story.id)).toBe(1);
			},
			{ timeout: 5_000, interval: 100 },
		);
		const audits = await db.auditLog.findMany({
			where: { resourceId: story.id, action: "story.pm_status_synced" },
			select: {
				actorType: true,
				resourceName: true,
				organizationId: true,
				projectId: true,
				metadata: true,
			},
		});
		expect(audits).toEqual([
			{
				actorType: "system",
				resourceName: "Checkout flow",
				organizationId: ORG,
				projectId: PROJECT,
				metadata: {
					fromStatus: backlogId,
					toStatus: reviewId,
					statusName: "In Review",
					source: "PM_STATUS_SYNC",
					pmTool: "GitLab",
				},
			},
		]);

		// The next poll reads the row the leaf just wrote: nothing left to do.
		await expect(
			runLeaf(await readStory(story.id), [
				LABEL_REVIEW,
				"priority::high",
			]),
		).resolves.toEqual({ outcome: "unchanged" });
		expect(await pullLogRows(story.id, "SUCCESS")).toHaveLength(1);
		expect(await auditCount(story.id)).toBe(1);
	});

	it("refuses the write when Fabric's status moved after the poll read the row (stale L)", async () => {
		await expectMovedControl("Control for a stale status");
		const snapshot = await seedStory("Moved in Fabric meanwhile");
		await db.userStory.update({
			where: { id: snapshot.id },
			data: { statusId: blockedId },
		});
		await expectRaced(snapshot);
	});

	it("refuses the write when the base status changed after the read (stale P)", async () => {
		await expectMovedControl("Control for a stale base");
		const snapshot = await seedStory("Stamped by a push meanwhile");
		await db.userStory.update({
			where: { id: snapshot.id },
			data: { pmStatusSyncBaseId: PM_STATUS_SYNC_SENTINEL.NONE },
		});
		await expectRaced(snapshot);
	});

	it("refuses the write when the ticket clock changed after the read (stale T)", async () => {
		await expectMovedControl("Control for a stale clock");
		const snapshot = await seedStory("Clock moved meanwhile");
		await db.userStory.update({
			where: { id: snapshot.id },
			data: { pmStatusSyncBaseAt: new Date(BASE_AT.getTime() + 60_000) },
		});
		await expectRaced(snapshot);
	});

	it("refuses the write when the base link changed after the read (stale link)", async () => {
		await expectMovedControl("Control for a stale link");
		const snapshot = await seedStory("Relinked meanwhile");
		await db.userStory.update({
			where: { id: snapshot.id },
			data: { pmStatusSyncBaseLink: `${ISSUES}/9999` },
		});
		await expectRaced(snapshot);
	});

	it("refuses the write when the base's Fabric status changed after the read (stale F)", async () => {
		await expectMovedControl("Control for a stale base Fabric status");
		const snapshot = await seedStory("Re-observed by a poll meanwhile");
		await db.userStory.update({
			where: { id: snapshot.id },
			data: { pmStatusSyncBaseFabricId: blockedId },
		});
		await expectRaced(snapshot);
	});

	it("writes one CONFLICT row per ambiguous observation, and another only when the ticket changes again", async () => {
		const seeded = await seedStory("Two status labels");
		// Positive control (Pin 7): seed a non-CONFLICT value explicitly —
		// never rely on the column's NULL default — and read it back before
		// the cycle runs, so a later write to CONFLICT is detectable rather
		// than merely "still whatever it started as".
		await db.userStory.update({
			where: { id: seeded.id },
			data: { lastPmSyncStatus: "SUCCESS" },
		});
		const story = await readStory(seeded.id);
		expect(story.lastPmSyncStatus).toBe("SUCCESS");
		const ambiguous = [LABEL_REVIEW, LABEL_BLOCKED];

		await expect(runLeaf(story, ambiguous)).resolves.toEqual({
			outcome: "ambiguous",
		});
		expect(await pullLogRows(story.id, "CONFLICT")).toHaveLength(1);
		const observed = await readStory(story.id);
		expect(observed).toMatchObject({
			statusId: backlogId,
			pmStatusSyncBaseId: PM_STATUS_SYNC_SENTINEL.AMBIGUOUS,
			pmStatusSyncBaseAt: TICKET_CHANGED,
		});
		// Pin 7 — a status-sync CONFLICT row never touches
		// story.lastPmSyncStatus; otherwise §4.4 row 4 would suppress the
		// next cycle. Still SUCCESS from seeding: the ambiguous CONFLICT
		// write left it alone.
		expect(observed.lastPmSyncStatus).toBe("SUCCESS");

		// The identical cycle an hour later: same labels, same ticket date.
		await expect(runLeaf(observed, ambiguous)).resolves.toEqual({
			outcome: "ambiguous",
		});
		expect(await pullLogRows(story.id, "CONFLICT")).toHaveLength(1);

		// The ticket changes again (a new changed-date), still ambiguous.
		const later = new Date(TICKET_CHANGED.getTime() + 3_600_000);
		await expect(
			runLeaf(await readStory(story.id), ambiguous, later),
		).resolves.toEqual({ outcome: "ambiguous" });
		expect(await pullLogRows(story.id, "CONFLICT")).toHaveLength(2);

		// Nothing moved at any point.
		expect((await readStory(story.id)).statusId).toBe(backlogId);
	});
});
