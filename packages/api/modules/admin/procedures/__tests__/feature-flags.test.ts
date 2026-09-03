/**
 * Handler-direct tests for admin.featureFlags.list / admin.featureFlags.set.
 *
 * Follows the mocking + invocation pattern established by
 * `list-users.test.ts` (spread-the-actual `@repo/database` mock so the
 * procedure builder's transitive deps keep working) and
 * `list-personal-meetings.test.ts` (`procedure["~orpc"].handler(...)` for
 * direct unit invocation, bypassing the oRPC middleware chain).
 */
import { ORG_SCOPABLE_FLAG_KEYS } from "@repo/utils/feature-flag-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAllFlagsDetailed: vi.fn(),
	setFlagOverride: vi.fn(),
	clearFlagOverride: vi.fn(),
	recordAuditDurable: vi.fn(),
}));

// `importOriginal` lets the procedures' transitive dependencies (tenant
// context helpers, etc.) keep working. We only override the symbols our
// handlers call directly.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getAllFlagsDetailed: mocks.getAllFlagsDetailed,
		setFlagOverride: mocks.setFlagOverride,
		clearFlagOverride: mocks.clearFlagOverride,
		recordAuditDurable: mocks.recordAuditDurable,
	};
});

// `protectedProcedure` imports lazily from `@repo/payments` only on the
// catch path of the AI-usage-limit error mapper, but the procedures module
// re-exports its types eagerly. Stub the whole package so module load
// doesn't blow up (mirrors list-users.test.ts).
vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class {},
}));

import {
	listFeatureFlagsProcedure,
	resetFeatureFlagProcedure,
	setFeatureFlagProcedure,
} from "../feature-flags";

const admin = { id: "user_admin", role: "admin" };

function callHandler(procedure: unknown, input: unknown, user = admin) {
	return (
		procedure as {
			"~orpc": {
				handler: (a: {
					input: unknown;
					context: unknown;
					errors: unknown;
				}) => Promise<unknown>;
			};
		}
	)["~orpc"].handler({ input, context: { user }, errors: {} });
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("admin.featureFlags.list", () => {
	it("returns registry metadata joined with the resolved value", async () => {
		mocks.getAllFlagsDetailed.mockResolvedValue([
			{ key: "PERSONAL_MEETINGS", enabled: true, source: "override" },
		]);

		const result = (await callHandler(listFeatureFlagsProcedure, {})) as {
			flags: Array<Record<string, unknown>>;
		};

		expect(result.flags).toHaveLength(1);
		expect(result.flags[0]).toMatchObject({
			key: "PERSONAL_MEETINGS",
			enabled: true,
			source: "override",
			label: "Personal meetings in Meeting Digest",
			envVar: "FABRIC_FEATURE_PERSONAL_MEETINGS",
		});
	});

	// The registry declares `orgScopable` as an optional `true`, so most
	// entries do not carry the property at all. The wire answer must be a
	// boolean on EVERY flag — a client deciding whether to offer a
	// per-organization control should not have to distinguish `false` from
	// absent.
	it("answers orgScopable as a boolean for a flag that is not scopable", async () => {
		mocks.getAllFlagsDetailed.mockResolvedValue([
			{ key: "PERSONAL_MEETINGS", enabled: true, source: "override" },
		]);

		const result = (await callHandler(listFeatureFlagsProcedure, {})) as {
			flags: Array<Record<string, unknown>>;
		};

		expect(result.flags[0].orgScopable).toBe(false);
	});

	it("answers orgScopable as true for a flag the resolver honours per organization", async () => {
		mocks.getAllFlagsDetailed.mockResolvedValue([
			{
				key: ORG_SCOPABLE_FLAG_KEYS[0],
				enabled: false,
				source: "default",
			},
		]);

		const result = (await callHandler(listFeatureFlagsProcedure, {})) as {
			flags: Array<Record<string, unknown>>;
		};

		expect(result.flags[0].orgScopable).toBe(true);
	});
});

describe("admin.featureFlags.set", () => {
	it("rejects a key that is not in the registry", async () => {
		// Deliberately configure getAllFlagsDetailed to resolve cleanly (as it
		// would in production) rather than leaving it unmocked. If the
		// `isFeatureFlagKey` guard were deleted, an unmocked call would return
		// `undefined`, and `.find` on `undefined` throws a TypeError that would
		// make a bare `.rejects.toThrow()` pass for the wrong reason. With the
		// mock configured, a missing guard lets the handler run to completion
		// (no throw at all), so both assertions below fail as intended —
		// verified by temporarily deleting the guard and re-running this test.
		mocks.getAllFlagsDetailed.mockResolvedValue([
			{ key: "PERSONAL_MEETINGS", enabled: false, source: "default" },
		]);

		await expect(
			callHandler(setFeatureFlagProcedure, {
				key: "NOT_A_REAL_FLAG",
				enabled: true,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.setFlagOverride).not.toHaveBeenCalled();
		expect(mocks.recordAuditDurable).not.toHaveBeenCalled();
	});

	it("writes the override and records a durable audit entry", async () => {
		mocks.getAllFlagsDetailed.mockResolvedValue([
			{ key: "PERSONAL_MEETINGS", enabled: false, source: "default" },
		]);
		mocks.setFlagOverride.mockResolvedValue(undefined);
		mocks.recordAuditDurable.mockResolvedValue(undefined);

		await callHandler(setFeatureFlagProcedure, {
			key: "PERSONAL_MEETINGS",
			enabled: true,
		});

		expect(mocks.setFlagOverride).toHaveBeenCalledWith({
			key: "PERSONAL_MEETINGS",
			enabled: true,
			updatedBy: "user_admin",
		});
		// `AuditActor` has no `id` field (see RecordAuditInput in
		// packages/database/prisma/queries/audit-log.ts) — the actor's
		// identity is carried in `userId`, matching every other caller of
		// recordAudit/recordAuditDurable in the codebase (e.g.
		// backlog/cancel-pending-proposal.ts).
		expect(mocks.recordAuditDurable).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "featureFlag.updated",
				actor: expect.objectContaining({
					type: "user",
					userId: "user_admin",
				}),
				resource: expect.objectContaining({ id: "PERSONAL_MEETINGS" }),
			}),
		);
	});
});

describe("admin.featureFlags.reset", () => {
	it("rejects a key that is not in the registry", async () => {
		// Same guard-integrity setup as the set test: configure the read so a
		// deleted `isFeatureFlagKey` guard would let the handler run to
		// completion (no throw), failing both assertions as intended rather
		// than throwing a coincidental TypeError.
		mocks.getAllFlagsDetailed.mockResolvedValue([
			{ key: "PERSONAL_MEETINGS", enabled: false, source: "default" },
		]);

		await expect(
			callHandler(resetFeatureFlagProcedure, { key: "NOT_A_REAL_FLAG" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.clearFlagOverride).not.toHaveBeenCalled();
		expect(mocks.recordAuditDurable).not.toHaveBeenCalled();
	});

	it("clears the override and records a durable reset audit entry", async () => {
		// getAllFlagsDetailed is called twice: before the clear (override/true)
		// and after (the re-resolved default/false). Return the before-state
		// first, then the after-state.
		mocks.getAllFlagsDetailed
			.mockResolvedValueOnce([
				{ key: "PERSONAL_MEETINGS", enabled: true, source: "override" },
			])
			.mockResolvedValueOnce([
				{ key: "PERSONAL_MEETINGS", enabled: false, source: "default" },
			]);
		mocks.clearFlagOverride.mockResolvedValue(undefined);
		mocks.recordAuditDurable.mockResolvedValue(undefined);

		const result = (await callHandler(resetFeatureFlagProcedure, {
			key: "PERSONAL_MEETINGS",
		})) as { success: boolean; enabled: boolean; source: string };

		// Returns the authoritative post-reset resolved value for the UI to
		// patch with (no refetch → no multi-replica flap).
		expect(result).toMatchObject({
			success: true,
			enabled: false,
			source: "default",
		});
		expect(mocks.clearFlagOverride).toHaveBeenCalledWith(
			"PERSONAL_MEETINGS",
		);
		expect(mocks.recordAuditDurable).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "featureFlag.reset",
				actor: expect.objectContaining({
					type: "user",
					userId: "user_admin",
				}),
				resource: expect.objectContaining({ id: "PERSONAL_MEETINGS" }),
				metadata: expect.objectContaining({
					previousValue: true,
					previousSource: "override",
					newValue: false,
					newSource: "default",
				}),
			}),
		);
	});
});
