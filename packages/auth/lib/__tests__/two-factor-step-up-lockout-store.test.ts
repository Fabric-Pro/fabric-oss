/**
 * Query-shape tests for `createPrismaStepUpLockoutStore()`
 * (../two-factor-step-up-lockout.ts).
 *
 * The step-up lockout's soundness under concurrency is not a property of the
 * hook logic — it is a property of the SQL these five methods emit. The
 * behavioral suite runs against an in-memory store and cannot observe that, and
 * these tests have no Postgres, so what they pin is the shape:
 *
 *  - the failure count moves via a single `update` with Prisma's `increment`
 *    (one `SET col = col + 1 ... RETURNING` under the row lock), never a
 *    read-then-write — the lost-update bug in Better Auth's generic emulated
 *    `incrementOne` fallback (which only adapters lacking a native
 *    implementation hit; the installed Prisma adapter ships a native atomic
 *    `incrementOne` and takes the same single-UPDATE shape pinned here);
 *  - the lock, the reset, the expired-lock clear and the restore are all
 *    `updateMany` with their guard IN THE WHERE CLAUSE, so a concurrent writer
 *    that changed the row between read and write causes the write to match
 *    nothing rather than to overwrite;
 *  - both reset boundaries bump `stepUpEpoch`, and the restore is guarded on
 *    the epoch it reserved under, so a reservation returned across a reset is
 *    discarded;
 *  - the row is located with `findFirst`, since `two_factor.userId` carries no
 *    unique constraint.
 *
 * Run with: pnpm --filter @repo/auth test lib/__tests__/two-factor-step-up-lockout-store.test.ts
 */

import { describe, expect, it, vi } from "vitest";
import {
	createPrismaStepUpLockoutStore,
	type StepUpLockoutPrismaClient,
} from "../two-factor-step-up-lockout";

function createClient(overrides?: {
	findFirst?: () => Promise<unknown>;
	update?: () => Promise<unknown>;
	updateMany?: () => Promise<unknown>;
}) {
	const findFirst = vi.fn(overrides?.findFirst ?? (async () => null));
	const update = vi.fn(
		overrides?.update ??
			(async () => ({ stepUpFailedCount: 1, stepUpEpoch: 0 })),
	);
	const updateMany = vi.fn(
		overrides?.updateMany ?? (async () => ({ count: 1 })),
	);
	const client = {
		twoFactor: { findFirst, update, updateMany },
	} as unknown as StepUpLockoutPrismaClient;
	return { client, findFirst, update, updateMany };
}

describe("createPrismaStepUpLockoutStore()", () => {
	it("locates the row with findFirst by userId, selecting the step-up columns plus the verified pre-state", async () => {
		const { client, findFirst } = createClient();
		await createPrismaStepUpLockoutStore(client).findRowByUserId("user-1");

		expect(findFirst).toHaveBeenCalledWith({
			where: { userId: "user-1" },
			select: {
				id: true,
				stepUpFailedCount: true,
				stepUpLockedUntil: true,
				stepUpEpoch: true,
				// Not the lockout's own state: this read is the only one that sees
				// the enrolment row before the endpoint can flip it to verified, so
				// the value rides along for the after-hook consumers (the step-up
				// grant and the audit emitter). Dropping it from the select would
				// silently make both read `undefined` and do nothing.
				verified: true,
			},
		});
	});

	it("reserves in one atomic statement and returns the post-increment count with its epoch", async () => {
		const { client, update } = createClient({
			update: async () => ({ stepUpFailedCount: 7, stepUpEpoch: 3 }),
		});

		const result =
			await createPrismaStepUpLockoutStore(client).incrementFailure(
				"row-1",
			);

		expect(result).toEqual({ count: 7, epoch: 3 });
		expect(update).toHaveBeenCalledWith({
			where: { id: "row-1" },
			// The atomicity contract: Prisma's `increment` compiles to
			// `col = col + 1`. A read-then-write here would let concurrent
			// failures overwrite each other and never reach the threshold.
			data: { stepUpFailedCount: { increment: 1 } },
			// The epoch comes back with the count so the reservation knows which
			// budget it belongs to.
			select: { stepUpFailedCount: true, stepUpEpoch: true },
		});
	});

	it("reports a vanished row as null rather than throwing, so a replaced row is not charged", async () => {
		const notFound = Object.assign(new Error("record not found"), {
			code: "P2025",
		});
		const { client } = createClient({
			update: async () => {
				throw notFound;
			},
		});

		await expect(
			createPrismaStepUpLockoutStore(client).incrementFailure("row-1"),
		).resolves.toBeNull();
	});

	it("propagates any store error that is not a missing row", async () => {
		const { client } = createClient({
			update: async () => {
				throw new Error("connection terminated");
			},
		});

		await expect(
			createPrismaStepUpLockoutStore(client).incrementFailure("row-1"),
		).rejects.toThrow("connection terminated");
	});

	it("gives a reservation back with one atomic decrement, guarded on the reserving epoch", async () => {
		const { client, updateMany } = createClient();

		await createPrismaStepUpLockoutStore(client).restoreReservation(
			"row-1",
			4,
		);

		// A shape assertion, so what it pins is the predicate — the behaviour it
		// enables (a restore stranded across a reset no-ops instead of erasing a
		// later genuine failure) is pinned in the behavioral suite.
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: "row-1",
				// Without this the decrement would land on whatever budget is
				// current, refunding an attempt a reset already cleared.
				stepUpEpoch: 4,
				// And without this a double restore could go negative.
				stepUpFailedCount: { gt: 0 },
			},
			data: { stepUpFailedCount: { decrement: 1 } },
		});
	});

	it("writes the lock conditionally on the observed count and on no lock standing", async () => {
		const { client, updateMany } = createClient();
		const lockedUntil = new Date("2026-08-16T12:15:00.000Z");

		const wrote = await createPrismaStepUpLockoutStore(
			client,
		).lockConditionally("row-1", 10, lockedUntil);

		expect(wrote).toBe(true);
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: "row-1",
				// Both guards matter: `gte` means a success that reset the count
				// between the increment and this write wins, and the null check
				// means an existing lock is never silently extended.
				stepUpFailedCount: { gte: 10 },
				stepUpLockedUntil: null,
			},
			data: { stepUpLockedUntil: lockedUntil },
		});
	});

	it("reports that it did not write the lock when the guard matched nothing", async () => {
		const { client } = createClient({
			updateMany: async () => ({ count: 0 }),
		});

		await expect(
			createPrismaStepUpLockoutStore(client).lockConditionally(
				"row-1",
				10,
				new Date(),
			),
		).resolves.toBe(false);
	});

	it("clears an expired lock only while it is still expired, resetting the count with it", async () => {
		const { client, updateMany } = createClient();
		const now = new Date("2026-08-16T12:00:00.000Z");

		await createPrismaStepUpLockoutStore(client).clearExpiredLock(
			"row-1",
			now,
		);

		expect(updateMany).toHaveBeenCalledWith({
			// Guarded on expiry so a lock re-armed by a concurrent failure is not
			// wiped; both fields clear together so the next attempt after expiry
			// does not instantly re-lock at the threshold.
			where: { id: "row-1", stepUpLockedUntil: { lte: now } },
			data: {
				stepUpFailedCount: 0,
				stepUpLockedUntil: null,
				// Clearing the budget is a reset boundary, so reservations taken
				// under the old one must not refund against the new one.
				stepUpEpoch: { increment: 1 },
			},
		});
	});

	it("resets only a row that actually carries state, clearing both fields", async () => {
		const { client, updateMany } = createClient();

		await createPrismaStepUpLockoutStore(client).resetOnSuccess("row-1");

		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: "row-1",
				OR: [
					{ stepUpFailedCount: { gt: 0 } },
					{ stepUpLockedUntil: { not: null } },
				],
			},
			data: {
				stepUpFailedCount: 0,
				stepUpLockedUntil: null,
				// The other reset boundary, guarded the same way.
				stepUpEpoch: { increment: 1 },
			},
		});
	});
});
