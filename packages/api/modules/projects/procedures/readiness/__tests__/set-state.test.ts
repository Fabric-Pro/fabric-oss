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

const { mockDb, mockIsFeatureEnabled, mockGather, mockBuildMailto } =
	vi.hoisted(() => ({
		mockDb: {
			projectReadinessItemState: {
				upsert: vi.fn(),
				deleteMany: vi.fn(),
				findFirst: vi.fn(),
				create: vi.fn(),
				update: vi.fn(),
				updateMany: vi.fn(),
			},
			// The organization-role read behind the CLI row's settle
			// constraint (Fizzy #2457).
			member: { findFirst: vi.fn() },
		},
		mockIsFeatureEnabled: vi.fn(),
		mockGather: vi.fn(),
		mockBuildMailto: vi.fn(),
	}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	db: mockDb,
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

vi.mock("../../../lib/readiness/evidence", () => ({
	gatherReadinessEvidence: (...args: unknown[]) => mockGather(...args),
}));

vi.mock("../../../lib/readiness/help-request", () => ({
	buildReadinessHelpMailto: (...args: unknown[]) => mockBuildMailto(...args),
}));

import {
	requestReadinessHelpProcedure,
	setReadinessItemNotApplicableProcedure,
	snoozeReadinessItemProcedure,
} from "../set-state";

const CONTEXT = {
	user: { id: "user-1", name: "Alex Doe", email: "alex@example.com" },
	session: {},
};
/** A key that exists in the registry — an unknown one is rejected up front. */
const ITEM_KEY = "feature-snapshot";
const MAILTO = "mailto:help@example.com?subject=Help";

function call(
	procedure: unknown,
	input: Record<string, unknown>,
	/** Merged over the default context — pass `{ user: {...} }` to vary the caller. */
	context: Record<string, unknown> = {},
) {
	const handler = (
		procedure as {
			"~orpc": { handler: (opts: unknown) => Promise<unknown> };
		}
	)["~orpc"].handler;
	return handler({ input, context: { ...CONTEXT, ...context } });
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
	mockDb.projectReadinessItemState.updateMany.mockResolvedValue({ count: 0 });
	mockDb.member.findFirst.mockResolvedValue(null);
	mockBuildMailto.mockResolvedValue(MAILTO);
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

describe("request help", () => {
	it("passes the asker on, so the draft says who is asking", async () => {
		const result = await call(requestReadinessHelpProcedure, {
			projectId: "p1",
			itemKey: ITEM_KEY,
			organizationId: null,
		});

		expect(result).toEqual({ ok: true, mailto: MAILTO });
		const delivered = mockBuildMailto.mock.calls[0][0];
		expect(delivered.projectId).toBe("p1");
		expect(delivered.itemKey).toBe(ITEM_KEY);
		expect(delivered.requesterEmail).toBe("alex@example.com");
		expect(delivered.requesterName).toBe("Alex Doe");
	});

	it("still records the request when there is no draft to open", async () => {
		mockBuildMailto.mockResolvedValue(null);

		const result = await call(requestReadinessHelpProcedure, {
			projectId: "p1",
			itemKey: ITEM_KEY,
			organizationId: null,
		});

		// The honest answer, and the flag written anyway: an unconfigured
		// deployment records the friction even though it has no inbox to
		// address a draft to.
		expect(result).toEqual({ ok: true, mailto: null });
		const args = mockDb.projectReadinessItemState.create.mock.calls[0][0];
		expect(args.data.state).toBe("HELP_REQUESTED");
		expect(args.data.everHelpRequested).toBe(true);
	});

	it("falls back to the address when the account has no name", async () => {
		await call(
			requestReadinessHelpProcedure,
			{ projectId: "p1", itemKey: ITEM_KEY, organizationId: null },
			{ user: { id: "user-1", name: null, email: "alex@example.com" } },
		);

		expect(mockBuildMailto.mock.calls[0][0].requesterName).toBe(
			"alex@example.com",
		);
	});
});

/**
 * The "API Key for CLI" row's second gate (Fizzy #2457, R29).
 *
 * Marking that one row not applicable stops the connection prompt for everyone
 * in the organization, so it must not be reachable by someone the prompt itself
 * would never target. `PROJECT_UPDATE` alone does not express that: a guest —
 * a `ProjectMember` row with no membership of the host organization — holding a
 * project-editor role passes it today. Every OTHER row keeps the panel's
 * existing project-role gate exactly as it was, which is what the last test
 * here pins.
 */
describe("not applicable — the CLI row", () => {
	const CLI_KEY = "api-key-for-cli";

	beforeEach(() => {
		mockGather.mockResolvedValue({
			evidence: {},
			tenant: { userId: "owner-1", organizationId: "org-1" },
		});
	});

	it("refuses a guest, whatever their project role says", async () => {
		mockDb.member.findFirst.mockResolvedValue(null);

		await expect(
			call(setReadinessItemNotApplicableProcedure, {
				projectId: "p1",
				itemKey: CLI_KEY,
				notApplicable: true,
				organizationId: "org-1",
			}),
		).rejects.toThrow();
		expect(mockDb.projectReadinessItemState.create).not.toHaveBeenCalled();
	});

	it("refuses an organization viewer, who could never mint the key either", async () => {
		mockDb.member.findFirst.mockResolvedValue({ role: "viewer" });

		await expect(
			call(setReadinessItemNotApplicableProcedure, {
				projectId: "p1",
				itemKey: CLI_KEY,
				notApplicable: true,
				organizationId: "org-1",
			}),
		).rejects.toThrow();
	});

	it("allows a member whose organization role carries key creation", async () => {
		mockDb.member.findFirst.mockResolvedValue({ role: "member" });

		await call(setReadinessItemNotApplicableProcedure, {
			projectId: "p1",
			itemKey: CLI_KEY,
			notApplicable: true,
			organizationId: "org-1",
		});

		const args = mockDb.projectReadinessItemState.create.mock.calls[0][0];
		expect(args.data.itemKey).toBe(CLI_KEY);
		expect(args.data.state).toBe("NOT_APPLICABLE");
		expect(mockDb.member.findFirst.mock.calls[0][0]).toMatchObject({
			where: { organizationId: "org-1", userId: "user-1" },
		});
	});

	it("refuses the CLEAR as well, since the row's control is one toggle", async () => {
		mockDb.member.findFirst.mockResolvedValue(null);

		await expect(
			call(setReadinessItemNotApplicableProcedure, {
				projectId: "p1",
				itemKey: CLI_KEY,
				notApplicable: false,
				organizationId: "org-1",
			}),
		).rejects.toThrow();
		expect(
			mockDb.projectReadinessItemState.deleteMany,
		).not.toHaveBeenCalled();
	});

	it("leaves every other row on the gate it already had", async () => {
		mockDb.member.findFirst.mockResolvedValue(null);

		await call(setReadinessItemNotApplicableProcedure, {
			projectId: "p1",
			itemKey: ITEM_KEY,
			notApplicable: true,
			organizationId: "org-1",
		});

		expect(mockDb.projectReadinessItemState.create).toHaveBeenCalled();
		// Not even asked: the constraint is scoped to the one row that carries
		// organization-wide consequences.
		expect(mockDb.member.findFirst).not.toHaveBeenCalled();
	});
});
