/**
 * The manual readiness actions, and specifically how they are UNDONE
 * (Fizzy #2165).
 *
 * Setting a state was covered by the level tests, which take manual states as
 * input. What those cannot see is reach: a snooze belongs to one person and
 * lifting it must not touch anyone else's, while Not Applicable speaks for the
 * project and clearing it must remove the single project-wide row. Both are
 * expressed only in a `where` clause, so they are asserted here directly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockIsFeatureEnabled, mockGather } = vi.hoisted(() => ({
	mockDb: {
		projectReadinessItemState: {
			upsert: vi.fn(),
			deleteMany: vi.fn(),
			findFirst: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
	},
	mockIsFeatureEnabled: vi.fn(),
	mockGather: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	db: mockDb,
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

vi.mock("../../../lib/readiness/evidence", () => ({
	gatherReadinessEvidence: (...args: unknown[]) => mockGather(...args),
}));

import {
	setReadinessItemNotApplicableProcedure,
	snoozeReadinessItemProcedure,
} from "../set-state";

const CONTEXT = { user: { id: "user-1" }, session: {} };
/** A key that exists in the registry — an unknown one is rejected up front. */
const ITEM_KEY = "feature-snapshot";

function call(procedure: unknown, input: Record<string, unknown>) {
	const handler = (
		procedure as {
			"~orpc": { handler: (opts: unknown) => Promise<unknown> };
		}
	)["~orpc"].handler;
	return handler({ input, context: CONTEXT });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockIsFeatureEnabled.mockResolvedValue(true);
	mockGather.mockResolvedValue({
		evidence: {},
		tenant: { userId: "owner-1", organizationId: null },
	});
	mockDb.projectReadinessItemState.upsert.mockResolvedValue({});
	mockDb.projectReadinessItemState.deleteMany.mockResolvedValue({ count: 1 });
	mockDb.projectReadinessItemState.findFirst.mockResolvedValue(null);
	mockDb.projectReadinessItemState.create.mockResolvedValue({});
});

describe("snooze", () => {
	it("records the chosen date against the caller, not the project", async () => {
		const until = new Date("2026-09-01T00:00:00Z");

		await call(snoozeReadinessItemProcedure, {
			projectId: "p1",
			itemKey: ITEM_KEY,
			until,
			organizationId: null,
		});

		const args = mockDb.projectReadinessItemState.upsert.mock.calls[0][0];
		expect(args.create.personalForUserId).toBe("user-1");
		expect(args.create.snoozeUntil).toBe(until);
		expect(args.update.snoozeUntil).toBe(until);
	});

	it("lifts the snooze when `until` is null", async () => {
		await call(snoozeReadinessItemProcedure, {
			projectId: "p1",
			itemKey: ITEM_KEY,
			until: null,
			organizationId: null,
		});

		expect(
			mockDb.projectReadinessItemState.deleteMany,
		).toHaveBeenCalledTimes(1);
		// Removing the row, not writing a "cleared" state: the item goes back to
		// being judged on its detection alone.
		expect(mockDb.projectReadinessItemState.upsert).not.toHaveBeenCalled();
	});

	it("only ever lifts the caller's own snooze", async () => {
		await call(snoozeReadinessItemProcedure, {
			projectId: "p1",
			itemKey: ITEM_KEY,
			until: null,
			organizationId: null,
		});

		const { where } =
			mockDb.projectReadinessItemState.deleteMany.mock.calls[0][0];
		// Without this, one person un-snoozing would silently un-snooze the item
		// for every teammate who had also snoozed it.
		expect(where.personalForUserId).toBe("user-1");
		expect(where.state).toBe("SNOOZED");
		expect(where.projectId).toBe("p1");
		expect(where.itemKey).toBe(ITEM_KEY);
	});

	it("refuses an item that is not in the registry", async () => {
		await expect(
			call(snoozeReadinessItemProcedure, {
				projectId: "p1",
				itemKey: "not-a-real-item",
				until: new Date(),
				organizationId: null,
			}),
		).rejects.toThrow();
	});
});

describe("not applicable", () => {
	it("clears the project-wide row and nobody's personal one", async () => {
		await call(setReadinessItemNotApplicableProcedure, {
			projectId: "p1",
			itemKey: ITEM_KEY,
			notApplicable: false,
			organizationId: null,
		});

		const { where } =
			mockDb.projectReadinessItemState.deleteMany.mock.calls[0][0];
		// `null` is the project-wide row. Clearing must not reach a teammate's
		// snooze, which lives in a row for the same item with a user id set.
		expect(where.personalForUserId).toBeNull();
		expect(where.state).toBe("NOT_APPLICABLE");
	});

	it("writes the project-wide row when setting it", async () => {
		await call(setReadinessItemNotApplicableProcedure, {
			projectId: "p1",
			itemKey: ITEM_KEY,
			notApplicable: true,
			organizationId: null,
		});

		const args = mockDb.projectReadinessItemState.create.mock.calls[0][0];
		expect(args.data.personalForUserId).toBeNull();
		expect(args.data.state).toBe("NOT_APPLICABLE");
	});
});
