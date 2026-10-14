/**
 * Unlink & re-create clears only the PM create claim it read.
 *
 * Two recovery requests that read the same row overlap. The first clears the
 * claim (or the link) it read and enqueues a push, and that push takes a new
 * claim before it sends its create. The second must then leave the newer
 * claim alone and enqueue nothing: clearing it would let a second push create
 * a second PM item.
 *
 * `retryPmSyncItem` runs for real with the real `clearPmCreateClaim` and
 * `applyPmUnlink` from @repo/database, over a simulated `user_story` table
 * with Prisma's `where` semantics for the shapes these writes use. Only the
 * enqueue is stubbed; it records each push and stands in for that push
 * taking its claim, as `acquirePmCreateClaim` (@repo/temporal) does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const h = vi.hoisted(() => ({
	stories: new Map<string, Record<string, unknown> & { id: string }>(),
	enqueued: [] as string[],
}));

function matches(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, value]) => {
		const cell = row[key] ?? null;
		if (value && typeof value === "object" && "not" in value) {
			return cell !== (value as { not: unknown }).not;
		}
		// The claim-age condition: SQL `NULL <= x` is not true.
		if (value && typeof value === "object" && "lte" in value) {
			return (
				cell instanceof Date &&
				cell.getTime() <= (value as { lte: Date }).lte.getTime()
			);
		}
		return cell === (value ?? null);
	});
}

const fakeDb = vi.hoisted(() => {
	const updateMany = async ({
		where,
		data,
	}: {
		where: Record<string, unknown>;
		data: Record<string, unknown>;
	}) => {
		let count = 0;
		for (const row of h.stories.values()) {
			if (matches(row, where)) {
				Object.assign(row, data);
				count++;
			}
		}
		return { count };
	};
	const findFirst = async ({ where }: { where: Record<string, unknown> }) =>
		[...h.stories.values()].find((row) => matches(row, where)) ?? null;
	const db = {
		userStory: { updateMany, findFirst },
		// The database clock the claim-age cutoff is read from.
		$queryRaw: async () => [{ now: new Date() }],
		pmTicketMissingStreak: { deleteMany: async () => ({ count: 0 }) },
		pendingPmStateChange: { updateMany: async () => ({ count: 0 }) },
		$transaction: async (fn: (tx: unknown) => unknown) => fn(db),
	};
	return db;
});

// The real query module imports its client relatively; this is that module.
vi.mock("@repo/database/prisma/client", () => ({ db: fakeDb }));

vi.mock("@repo/database", async () => {
	const queries = await vi.importActual<
		typeof import("@repo/database/prisma/queries/apply-pm-unlink")
	>("@repo/database/prisma/queries/apply-pm-unlink");
	return {
		db: fakeDb,
		applyPmUnlink: queries.applyPmUnlink,
		clearPmCreateClaim: queries.clearPmCreateClaim,
	};
});

vi.mock("@repo/temporal", () => ({ getTemporalClient: vi.fn() }));
vi.mock("../resolve-pm-target", () => ({ resolvePmTarget: vi.fn() }));

vi.mock("../enqueue-pm-sync", () => ({
	enqueuePmSync: vi.fn(async ({ itemId }: { itemId: string }) => {
		const push = `push-${h.enqueued.length + 1}`;
		h.enqueued.push(push);
		// The enqueued push takes the row's create claim before its create,
		// on an unlinked, unclaimed row only.
		const row = h.stories.get(itemId);
		if (row && row.externalId == null && row.pmCreateClaimId == null) {
			row.pmCreateClaimId = `claim-of-${push}`;
			row.pmCreateClaimedAt = new Date();
		}
		return { enqueued: true, workflowId: push };
	}),
}));

const { retryPmSyncItem } = await import("../retry-pm-sync-item");

const row = () => h.stories.get("story-1") as Row;

/** Older than PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS: clearable by age. */
const CLAIMED_LONG_AGO = new Date(Date.now() - 60 * 60_000);

/** What the API read for a recovery request, then the call it makes. */
function recovery(read: Row) {
	return () =>
		retryPmSyncItem({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-1",
			unlinkFirst: true,
			externalId: (read.externalId as string | null) ?? null,
			externalMcpServerId:
				(read.externalMcpServerId as string | null) ?? null,
			pmCreateClaimId: (read.pmCreateClaimId as string | null) ?? null,
		});
}

beforeEach(() => {
	h.stories.clear();
	h.enqueued.length = 0;
});

describe("overlapping Unlink & re-create requests", () => {
	it("on an unlinked row: the second keeps the claim the first one's push took, and enqueues nothing", async () => {
		h.stories.set("story-1", {
			id: "story-1",
			projectId: "project-1",
			externalId: null,
			externalMcpServerId: null,
			pmCreateClaimId: "claim-orphaned",
			pmCreateClaimedAt: CLAIMED_LONG_AGO,
		});
		// Both requests read the row before either acts.
		const first = recovery({ ...row() });
		const second = recovery({ ...row() });

		const a = await first();
		const b = await second();

		expect(a).toMatchObject({ enqueued: true });
		expect(b).toEqual({ enqueued: false, reason: "pm-recovery-stale" });
		expect(h.enqueued).toEqual(["push-1"]);
		expect(row().pmCreateClaimId).toBe("claim-of-push-1");
	});

	it.each([
		["a minute old", new Date(Date.now() - 60_000)],
		["with no timestamp", null],
	])(
		"a held claim %s is too recent to clear: nothing is cleared or enqueued, and the time is reported",
		async (_label, claimedAt) => {
			h.stories.set("story-1", {
				id: "story-1",
				projectId: "project-1",
				externalId: null,
				pmCreateClaimId: "claim-held",
				pmCreateClaimedAt: claimedAt,
			});

			const result = await recovery({ ...row() })();

			expect(result).toEqual({
				enqueued: false,
				reason: "pm-recovery-too-recent",
				recoverableAt: claimedAt
					? new Date(claimedAt.getTime() + 5 * 60_000)
					: null,
			});
			expect(h.enqueued).toEqual([]);
			expect(row().pmCreateClaimId).toBe("claim-held");
		},
	);

	it("on a linked row: the second finds the link gone, keeps the new claim, and enqueues nothing", async () => {
		h.stories.set("story-1", {
			id: "story-1",
			projectId: "project-1",
			externalId: "77",
			externalMcpServerId: "srv-1",
			pmCreateClaimId: null,
		});
		const first = recovery({ ...row() });
		const second = recovery({ ...row() });

		const a = await first();
		const b = await second();

		expect(a).toMatchObject({ enqueued: true });
		expect(b).toEqual({ enqueued: false, reason: "pm-recovery-stale" });
		expect(h.enqueued).toEqual(["push-1"]);
		expect(row()).toMatchObject({
			externalId: null,
			pmCreateClaimId: "claim-of-push-1",
		});
	});

	it("a linked row's unlink clears the claim it read and only that one", async () => {
		h.stories.set("story-1", {
			id: "story-1",
			projectId: "project-1",
			externalId: "77",
			externalMcpServerId: "srv-1",
			pmCreateClaimId: "claim-read",
			pmCreateClaimedAt: CLAIMED_LONG_AGO,
		});
		const stale = recovery({ ...row() });
		// A claim taken after the read.
		row().pmCreateClaimId = "claim-newer";

		expect(await stale()).toEqual({
			enqueued: false,
			reason: "pm-recovery-stale",
		});
		expect(row()).toMatchObject({
			externalId: "77",
			pmCreateClaimId: "claim-newer",
			pmCreateClaimedAt: CLAIMED_LONG_AGO,
		});
		expect(h.enqueued).toEqual([]);
	});

	it("a request that read no claim still enqueues, and leaves a claim taken since to block that push's create", async () => {
		h.stories.set("story-1", {
			id: "story-1",
			projectId: "project-1",
			externalId: null,
			externalMcpServerId: null,
			pmCreateClaimId: null,
		});
		const request = recovery({ ...row() });
		// Another push took the claim after the read.
		row().pmCreateClaimId = "claim-newer";

		expect(await request()).toMatchObject({ enqueued: true });
		expect(h.enqueued).toEqual(["push-1"]);
		// Not cleared: the enqueued push cannot take it, so it does not
		// create (acquirePmCreateClaim needs an unclaimed row).
		expect(row().pmCreateClaimId).toBe("claim-newer");
	});

	it("a request alone clears the claim it read and enqueues one push", async () => {
		h.stories.set("story-1", {
			id: "story-1",
			projectId: "project-1",
			externalId: null,
			externalMcpServerId: null,
			pmCreateClaimId: "claim-orphaned",
			pmCreateClaimedAt: CLAIMED_LONG_AGO,
		});

		expect(await recovery({ ...row() })()).toMatchObject({
			enqueued: true,
		});
		expect(h.enqueued).toEqual(["push-1"]);
	});

	it("does not touch a story in another project", async () => {
		h.stories.set("story-1", {
			id: "story-1",
			projectId: "project-2",
			externalId: null,
			externalMcpServerId: null,
			pmCreateClaimId: "claim-orphaned",
			pmCreateClaimedAt: CLAIMED_LONG_AGO,
		});

		expect(await recovery({ ...row() })()).toEqual({
			enqueued: false,
			reason: "pm-recovery-stale",
		});
		expect(row().pmCreateClaimId).toBe("claim-orphaned");
		expect(h.enqueued).toEqual([]);
	});
});
