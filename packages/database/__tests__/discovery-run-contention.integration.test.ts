/**
 * Discovery run: real-Postgres contention between question posting,
 * cancellation and completion (ADR-020; review sprint3 rounds 2–3).
 *
 * The posting activity (`postDiscoveryQuestions` in @repo/temporal) opens a
 * transaction, locks the run row with `SELECT ... FOR UPDATE`, requires it to
 * be CONTRACT_READY, posts the comments and advances the stage, then commits.
 * The API cancel is a compare-and-swap `updateMany` from an active status, and
 * completion (`markContractComplete`) is a compare-and-swap from
 * CONTRACT_READY. This suite drives those three statements against a real
 * database with two connections so the interleavings are real, not mocked:
 *
 *   1. cancel issued while posting holds the lock BLOCKS until posting
 *      commits, then wins (the run ends CANCELLED; nothing was lost);
 *   2. cancel that landed BEFORE the lock leaves the posting read seeing
 *      CANCELLED, so the activity refuses to post;
 *   3. completion behaves like cancel under the lock, and a cancel after
 *      completion matches zero rows (terminal states are sticky).
 *
 * Runs against DATABASE_URL (RUN_DB_INTEGRATION=1). Two Prisma clients are
 * used on purpose: one holds the posting transaction open while the other
 * issues the competing write.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../prisma/generated/client";

const ACTIVE = ["QUEUED", "RUNNING", "CONTRACT_READY"] as const;

const IDS = {
	owner: "disc-cont-owner",
	project: "disc-cont-project",
	status: "disc-cont-status",
	story: "disc-cont-story",
	run: "disc-cont-run",
};

function client(): PrismaClient {
	return new PrismaClient({
		adapter: new PrismaPg({
			connectionString: process.env.DATABASE_URL ?? "",
		}),
	});
}

const a = client(); // holds the posting transaction
const b = client(); // issues the competing write

async function resetRun(status: (typeof ACTIVE)[number] | "COMPLETED") {
	await a.discoveryRun.upsert({
		where: { id: IDS.run },
		update: { status, documentId: null, error: null },
		create: {
			id: IDS.run,
			projectId: IDS.project,
			storyId: IDS.story,
			userId: IDS.owner,
			organizationId: null,
			status,
			sources: { repo: true },
		} as never,
	});
}

async function readStatus(): Promise<string> {
	const row = await a.discoveryRun.findUniqueOrThrow({
		where: { id: IDS.run },
		select: { status: true },
	});
	return row.status;
}

/** The cancel the API issues: CAS from any active status. */
function cancelWith(c: PrismaClient) {
	return c.discoveryRun.updateMany({
		where: { id: IDS.run, status: { in: [...ACTIVE] } },
		data: { status: "CANCELLED" },
	});
}

/** The completion `markContractComplete` issues: CAS from CONTRACT_READY. */
function completeWith(c: PrismaClient) {
	return c.discoveryRun.updateMany({
		where: { id: IDS.run, status: "CONTRACT_READY" },
		data: { status: "COMPLETED" },
	});
}

/**
 * Open the posting transaction the way the activity does: lock the row,
 * read its status, then hold the lock until `release` resolves.
 */
function openPosting(): {
	locked: Promise<string | null>;
	release: () => void;
	done: Promise<void>;
} {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let resolveLocked!: (s: string | null) => void;
	const locked = new Promise<string | null>((r) => {
		resolveLocked = r;
	});
	const done = a
		.$transaction(
			async (tx) => {
				const rows = await tx.$queryRaw<Array<{ status: string }>>`
					SELECT "status" FROM "discovery_run"
					WHERE "id" = ${IDS.run}
					  AND "projectId" = ${IDS.project}
					  AND "storyId" = ${IDS.story}
					FOR UPDATE`;
				resolveLocked(rows[0]?.status ?? null);
				await gate;
			},
			{ maxWait: 10_000, timeout: 60_000 },
		)
		.then(() => undefined);
	return { locked, release, done };
}

describe.skipIf(!process.env.DATABASE_URL)(
	"Discovery run contention: posting vs cancel vs completion (real Postgres)",
	() => {
		beforeAll(async () => {
			await a.user.upsert({
				where: { id: IDS.owner },
				update: {},
				create: {
					id: IDS.owner,
					name: IDS.owner,
					email: "disc-cont-owner@example.com",
					emailVerified: true,
					onboardingComplete: false,
					createdAt: new Date(),
					updatedAt: new Date(),
				} as never,
			});
			await a.project.upsert({
				where: { id: IDS.project },
				update: {},
				create: {
					id: IDS.project,
					name: "Discovery contention project",
					userId: IDS.owner,
					organizationId: null,
					status: "ACTIVE",
					techStack: [],
					features: [],
					tags: [],
					engagementProfile: "PROPOSAL",
				} as never,
			});
			await a.projectStoryStatus.upsert({
				where: { id: IDS.status },
				update: {},
				create: {
					id: IDS.status,
					projectId: IDS.project,
					name: "Backlog",
					color: "#6B7280",
					order: 0,
					isDefault: true,
				} as never,
			});
			await a.userStory.upsert({
				where: { id: IDS.story },
				update: {},
				create: {
					id: IDS.story,
					projectId: IDS.project,
					statusId: IDS.status,
					identifier: "DISC-001",
					title: "Discovery contention story",
					description: "d",
					acceptanceCriteria: "ac",
					createdById: IDS.owner,
					draftingStage: "PLACEHOLDER",
					deliveryTrack: "DISCOVERY",
					labels: [],
				} as never,
			});
		});

		afterAll(async () => {
			await a.discoveryRun.deleteMany({ where: { id: IDS.run } });
			await a.$disconnect();
			await b.$disconnect();
		});

		it("a cancel issued under the posting lock waits for the commit, then wins", async () => {
			await resetRun("CONTRACT_READY");
			const posting = openPosting();
			expect(await posting.locked).toBe("CONTRACT_READY");

			// Race the cancel against the held lock. It must not resolve
			// while the posting transaction is open.
			let cancelSettled = false;
			const cancel = cancelWith(b).then((r) => {
				cancelSettled = true;
				return r;
			});
			await new Promise((r) => setTimeout(r, 750));
			expect(cancelSettled).toBe(false);
			// Posting still sees its own snapshot: the row is CONTRACT_READY
			// for the whole of the transaction.
			expect(await readStatus()).toBe("CONTRACT_READY");

			posting.release();
			await posting.done;
			const result = await cancel;
			expect(cancelSettled).toBe(true);
			expect(result.count).toBe(1);
			expect(await readStatus()).toBe("CANCELLED");
		});

		it("a cancel that landed before the lock is what the posting read sees", async () => {
			await resetRun("CONTRACT_READY");
			expect((await cancelWith(b)).count).toBe(1);

			const posting = openPosting();
			// The activity refuses to post on anything but CONTRACT_READY.
			expect(await posting.locked).toBe("CANCELLED");
			posting.release();
			await posting.done;
			expect(await readStatus()).toBe("CANCELLED");
		});

		it("completion waits under the lock too, and a later cancel cannot undo it", async () => {
			await resetRun("CONTRACT_READY");
			const posting = openPosting();
			expect(await posting.locked).toBe("CONTRACT_READY");

			let completeSettled = false;
			const completion = completeWith(b).then((r) => {
				completeSettled = true;
				return r;
			});
			await new Promise((r) => setTimeout(r, 750));
			expect(completeSettled).toBe(false);

			posting.release();
			await posting.done;
			expect((await completion).count).toBe(1);
			expect(await readStatus()).toBe("COMPLETED");

			// Terminal states are sticky: the API cancel's CAS matches nothing.
			expect((await cancelWith(b)).count).toBe(0);
			expect(await readStatus()).toBe("COMPLETED");
		});

		it("two posters cannot both hold the row: the second waits for the first", async () => {
			await resetRun("CONTRACT_READY");
			const first = openPosting();
			expect(await first.locked).toBe("CONTRACT_READY");

			let secondLocked = false;
			const second = b
				.$transaction(async (tx) => {
					const rows = await tx.$queryRaw<Array<{ status: string }>>`
						SELECT "status" FROM "discovery_run"
						WHERE "id" = ${IDS.run} FOR UPDATE`;
					secondLocked = true;
					return rows[0]?.status ?? null;
				})
				.then((s) => s);
			await new Promise((r) => setTimeout(r, 750));
			expect(secondLocked).toBe(false);

			first.release();
			await first.done;
			expect(await second).toBe("CONTRACT_READY");
			expect(secondLocked).toBe(true);
		});
	},
);
