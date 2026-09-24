/**
 * Real-Postgres tests for the instruction reaper's candidate claim
 * (`claimStrandedInstructionSyncRunReceipts`, Fizzy #2672).
 *
 * The contract is the SQL, so a mocked `$queryRaw` cannot hold it: which
 * unfinished receipts a tick takes, and that taking them stamps
 * `reapCheckedAt` so the next tick moves on. The reaper completes only the
 * receipts whose run has ended; one whose run is still RUNNING (a parent can
 * stay open for weeks settling a child), or whose describe went unanswered,
 * stays unfinished. Taken oldest first with no stamp, a full batch of those
 * was re-selected every tick and a later receipt whose run HAD ended was
 * never examined.
 *
 * The claim is unscoped by design, so every row here starts in 2000 and
 * every tick's age bound sits in 2000 too: no real receipt can match, and a
 * foreign row in a result fails the exact-id assertions instead of being
 * stamped quietly.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database exec dotenv -c -e ../../.env.local -- vitest run __tests__/instruction-sync-receipt-claim.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { claimStrandedInstructionSyncRunReceipts, db } from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `sync-receipt-claim-org-${RUN_ID}`;
const USER_ID = `sync-receipt-claim-user-${RUN_ID}`;
const SYNC_ID = `sync-receipt-claim-sync-${RUN_ID}`;
let projectId = "";

const MINUTE = 60 * 1000;
/** The reaper's age bound and recheck interval, as the activity passes them. */
const AGE_MS = 15 * MINUTE;
const RECHECK_MS = 50 * MINUTE;
/** The reaper's schedule: one tick an hour. */
const TICK_MS = 60 * MINUTE;
const T0 = new Date("2000-01-01T00:00:00.000Z");
const FIRST_TICK = new Date(T0.getTime() + 24 * 60 * MINUTE);

const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const key = (runId: string) => `${SYNC_ID}:${runId}`;

function claimAt(tick: Date, limit: number) {
	return claimStrandedInstructionSyncRunReceipts({
		startedBefore: at(tick, -AGE_MS),
		checkedBefore: at(tick, -RECHECK_MS),
		checkedAt: tick,
		limit,
	});
}

async function seed(
	rows: Array<{ id: string; startedAt: Date; finishedAt?: Date }>,
) {
	await db.projectInstructionRepositorySyncRun.createMany({
		data: rows.map((row) => ({
			id: row.id,
			syncId: SYNC_ID,
			projectId,
			organizationId: ORGANIZATION_ID,
			userId: USER_ID,
			generation: 1,
			trigger: "POLL" as const,
			startedAt: row.startedAt,
			finishedAt: row.finishedAt ?? null,
			status: row.finishedAt ? ("SUCCEEDED" as const) : null,
		})),
	});
}

async function checkedAtOf(id: string) {
	const row = await db.projectInstructionRepositorySyncRun.findUnique({
		where: { id },
		select: { reapCheckedAt: true },
	});
	return row?.reapCheckedAt ?? null;
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"claimStrandedInstructionSyncRunReceipts (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: USER_ID,
					name: "Sync Receipt Claim",
					email: `${USER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Sync Receipt Claim",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Sync Receipt Claim",
					userId: USER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			projectId = project.id;
		});

		afterEach(async () => {
			await db.projectInstructionRepositorySyncRun.deleteMany({
				where: { projectId },
			});
		});

		afterAll(async () => {
			// Delete by the exact ids this run created, never by pattern.
			if (projectId) {
				await db.project.deleteMany({ where: { id: projectId } });
			}
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({ where: { id: USER_ID } });
			await db.$disconnect();
		});

		it("moves past a full batch whose runs stay open to a later receipt whose run has ended", async () => {
			await seed([
				{ id: key("run-a1"), startedAt: at(T0, 1 * MINUTE) },
				{ id: key("run-a2"), startedAt: at(T0, 2 * MINUTE) },
				{ id: key("run-b"), startedAt: at(T0, 3 * MINUTE) },
			]);

			// Tick 1 takes the oldest full batch. Both runs are still RUNNING (or
			// their describe went unanswered), so the reaper completes neither.
			const first = await claimAt(FIRST_TICK, 2);
			expect(first.map((r) => r.id)).toEqual([
				key("run-a1"),
				key("run-a2"),
			]);

			// Tick 2 reaches the later receipt, never checked, ahead of the batch
			// it has already asked about.
			const secondTick = at(FIRST_TICK, TICK_MS);
			const second = await claimAt(secondTick, 2);
			expect(second.map((r) => r.id)).toEqual([
				key("run-b"),
				key("run-a1"),
			]);

			// Its run had ended, so the reaper completes it; tick 3 carries on
			// with the open batch, least recently checked first.
			await db.projectInstructionRepositorySyncRun.update({
				where: { id: key("run-b") },
				data: { finishedAt: secondTick, status: "FAILED" },
			});
			const third = await claimAt(at(secondTick, TICK_MS), 2);
			expect(third.map((r) => r.id)).toEqual([
				key("run-a2"),
				key("run-a1"),
			]);
		});

		it("examines a stamped, still-open receipt again once the recheck interval has passed", async () => {
			await seed([
				{ id: key("run-open"), startedAt: at(T0, 1 * MINUTE) },
			]);

			const first = await claimAt(FIRST_TICK, 100);
			expect(first).toEqual([
				{
					id: key("run-open"),
					syncId: SYNC_ID,
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: USER_ID,
					generation: 1,
					trigger: "POLL",
				},
			]);
			expect(await checkedAtOf(key("run-open"))).toEqual(FIRST_TICK);

			// Inside the interval: not taken, and the stamp is left alone.
			expect(await claimAt(at(FIRST_TICK, 10 * MINUTE), 100)).toEqual([]);
			expect(await checkedAtOf(key("run-open"))).toEqual(FIRST_TICK);

			// The next tick: taken again and re-stamped.
			const nextTick = at(FIRST_TICK, TICK_MS);
			const again = await claimAt(nextTick, 100);
			expect(again.map((r) => r.id)).toEqual([key("run-open")]);
			expect(await checkedAtOf(key("run-open"))).toEqual(nextTick);
		});

		it("never takes, or stamps, a finished receipt, a poll receipt, or one inside the age bound", async () => {
			await seed([
				{ id: key("run-eligible"), startedAt: at(T0, 1 * MINUTE) },
				{
					id: key("run-finished"),
					startedAt: at(T0, 1 * MINUTE),
					finishedAt: at(T0, 2 * MINUTE),
				},
				// A poll receipt: three segments, excluded by shape.
				{ id: key("poll-1:7"), startedAt: at(T0, 1 * MINUTE) },
				// Begun five minutes before the tick: its run may still be starting.
				{
					id: key("run-young"),
					startedAt: at(FIRST_TICK, -5 * MINUTE),
				},
			]);

			const claimed = await claimAt(FIRST_TICK, 100);
			expect(claimed.map((r) => r.id)).toEqual([key("run-eligible")]);
			expect(await checkedAtOf(key("run-eligible"))).toEqual(FIRST_TICK);
			for (const id of [
				key("run-finished"),
				key("poll-1:7"),
				key("run-young"),
			]) {
				expect(await checkedAtOf(id)).toBeNull();
			}
		});
	},
);
