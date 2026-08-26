/**
 * Adversarial safety tests for `purgeExpiredPmSyncLogRowsActivity`.
 *
 * Modeled exactly on `audit-log-retention-safety.test.ts`. One test per
 * the seven spec §7.3 safety-acceptance criteria.
 *
 * Explicit invariant under test: the cleanup is provably incapable of
 * affecting any table other than `pm_sync_log`, and only deletes rows
 * older than the configured retention.
 *
 * Spec: spec.md §7.3.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	executeRawMock: vi.fn(),
	loggerInfoMock: vi.fn(),
	loggerWarnMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		$executeRaw: (...args: unknown[]) => mocks.executeRawMock(...args),
	},
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfoMock,
		warn: mocks.loggerWarnMock,
		error: vi.fn(),
		log: vi.fn(),
	},
}));

import { purgeExpiredPmSyncLogRowsActivity } from "../pm-sync-log-retention";

const originalEnv = process.env.FABRIC_PM_SYNC_LOG_RETENTION_DAYS;

/**
 * Reconstruct the raw SQL string from the tagged-template arguments that
 * Prisma's `$executeRaw` receives: `(TemplateStringsArray, ...values)`.
 * Joins the static string segments so we can assert on the table name(s)
 * without depending on the interpolated values.
 */
function sqlFromCall(call: unknown[]): string {
	const strings = call[0] as TemplateStringsArray;
	return strings.join(" ");
}

beforeEach(() => {
	mocks.executeRawMock.mockReset();
	mocks.loggerInfoMock.mockReset();
	mocks.loggerWarnMock.mockReset();
});

afterEach(() => {
	if (originalEnv === undefined) {
		delete process.env.FABRIC_PM_SYNC_LOG_RETENTION_DAYS;
	} else {
		process.env.FABRIC_PM_SYNC_LOG_RETENTION_DAYS = originalEnv;
	}
});

describe("purgeExpiredPmSyncLogRowsActivity (safety §7.3)", () => {
	// ---- Criterion 1: single-table only ------------------------------------
	it('(1) executes SQL that targets ONLY "pm_sync_log" — provably cannot mutate another table', async () => {
		process.env.FABRIC_PM_SYNC_LOG_RETENTION_DAYS = "90";
		mocks.executeRawMock.mockResolvedValueOnce(0);

		await purgeExpiredPmSyncLogRowsActivity();

		expect(mocks.executeRawMock).toHaveBeenCalledTimes(1);
		const firstCall = (mocks.executeRawMock.mock.calls as unknown[][])[0];
		expect(firstCall).toBeDefined();
		const sql = sqlFromCall(firstCall as unknown[]);
		// The only table named anywhere in the statement is pm_sync_log.
		const quotedTables = sql.match(/"[a-z_]+"/g) ?? [];
		const tableTokens = quotedTables.filter((t) => t === '"pm_sync_log"');
		expect(tableTokens.length).toBeGreaterThan(0);
		// No other snake_case table identifier appears: every quoted
		// identifier is either the table or a column (id/createdAt).
		const everyQuoted = sql.match(/"[A-Za-z_]+"/g) ?? [];
		const otherTables = everyQuoted.filter(
			(t) => t !== '"pm_sync_log"' && t !== '"id"' && t !== '"createdAt"',
		);
		expect(otherTables).toEqual([]);
		// Must be a DELETE FROM the one table.
		expect(sql).toMatch(/DELETE FROM\s+"pm_sync_log"/);
	});

	// ---- Criterion 2: no cascade reachability ------------------------------
	it("(2) PmSyncLog has ZERO inbound FK relations from other tables — deleting a row cannot cascade outward", () => {
		// Resolve the canonical Prisma schema from the @repo/database package.
		const schemaPath = require.resolve(
			"@repo/database/prisma/schema.prisma",
		);
		const schema = readFileSync(schemaPath, "utf8");

		// Locate the PmSyncLog model block.
		const modelMatch = schema.match(/model PmSyncLog \{([\s\S]*?)\n\}/);
		expect(modelMatch).not.toBeNull();
		const body = modelMatch?.[1] ?? "";

		// PmSyncLog's own relations are OUTBOUND FKs (it holds userId /
		// organizationId / projectId and references the parents). Deleting a
		// PmSyncLog row therefore touches nothing — the onDelete behaviors on
		// these relations fire when the PARENT is deleted, not the child.
		// The cascade-reachability risk would be an INBOUND FK: another model
		// declaring `@relation(fields: [...], references: [...])` whose target
		// TYPE is PmSyncLog. Assert no such relation exists anywhere in the
		// schema.
		const inboundFkToPmSyncLog =
			/\w+\s+PmSyncLog\b[^\n]*@relation\([^)]*fields:/g;
		const inbound = schema.match(inboundFkToPmSyncLog) ?? [];
		expect(inbound).toEqual([]);

		// The only references to PmSyncLog OUTSIDE its own model are the inverse
		// list back-relations (`pmSyncLogs PmSyncLog[]`), which carry no
		// `fields:` clause and create no cascade path out of a pm_sync_log row.
		const backRelations = schema.match(/pmSyncLogs\s+PmSyncLog\[\]/g) ?? [];
		expect(backRelations.length).toBeGreaterThan(0);
		for (const rel of backRelations) {
			expect(rel).not.toContain("fields:");
		}

		// Sanity: PmSyncLog's own outbound relations are SetNull/Cascade on the
		// parent side and do not delete the parent when the child is removed.
		expect(body).toContain("onDelete: SetNull");
		expect(body).toContain("onDelete: Cascade");
	});

	// ---- Criterion 3: cutoff determinism -----------------------------------
	it("(3) uses ONE cutoffAt value for every batch (window does NOT drift mid-run)", async () => {
		process.env.FABRIC_PM_SYNC_LOG_RETENTION_DAYS = "30";
		// Return 5000 twice, then 0 — three calls total.
		mocks.executeRawMock
			.mockResolvedValueOnce(5_000)
			.mockResolvedValueOnce(5_000)
			.mockResolvedValueOnce(0);

		await purgeExpiredPmSyncLogRowsActivity();

		const calls = mocks.executeRawMock.mock.calls as Array<unknown[]>;
		expect(calls.length).toBe(3);
		// The cutoff is the first interpolated value (index 1, after the
		// tagged-template strings array). Every batch must carry the SAME
		// timestamp — the cutoff is computed once at activity start.
		const cutoffs = calls.map((call) => call[1] as Date);
		expect(cutoffs[0]?.getTime()).toBe(cutoffs[1]?.getTime());
		expect(cutoffs[1]?.getTime()).toBe(cutoffs[2]?.getTime());
	});

	// ---- Criterion 4: only deletes rows older than retention ---------------
	it("(4) the cutoff is exactly now - retentionDays*24h and the predicate is strictly older-than", async () => {
		const FIXED_NOW = new Date("2026-05-26T00:00:00.000Z").getTime();
		vi.useFakeTimers();
		vi.setSystemTime(FIXED_NOW);
		try {
			process.env.FABRIC_PM_SYNC_LOG_RETENTION_DAYS = "30";
			mocks.executeRawMock.mockResolvedValueOnce(0);

			await purgeExpiredPmSyncLogRowsActivity();

			const call = (mocks.executeRawMock.mock.calls as unknown[][])[0];
			expect(call).toBeDefined();
			const resolvedCall = call as unknown[];
			const cutoff = resolvedCall[1] as Date;
			// Cutoff is exactly 30 days before the frozen now. Rows AT or NEWER
			// than this instant are excluded by the strict `<` predicate.
			const expected = FIXED_NOW - 30 * 24 * 60 * 60 * 1000;
			expect(cutoff.getTime()).toBe(expected);

			const sql = sqlFromCall(resolvedCall);
			// Strictly-older-than: a `<` comparison, never `<=`.
			expect(sql).toContain('"createdAt" <');
			expect(sql).not.toContain('"createdAt" <=');
		} finally {
			vi.useRealTimers();
		}
	});

	// ---- Criterion 5: batch + hard-cap behavior ----------------------------
	it("(5) deletes in 5k batches; the 1,000-batch cap fires safely and logs safety_cap_hit without erroring", async () => {
		process.env.FABRIC_PM_SYNC_LOG_RETENTION_DAYS = "30";
		// Every batch returns a full 5,000 → the loop runs to the hard cap.
		mocks.executeRawMock.mockResolvedValue(5_000);

		const result = await purgeExpiredPmSyncLogRowsActivity();

		// 1,000 batches × 5,000 rows = the 5M hard cap.
		expect(mocks.executeRawMock).toHaveBeenCalledTimes(1_000);
		expect(result.deletedCount).toBe(5_000 * 1_000);
		expect(result.hitSafetyCap).toBe(true);
		// Logged, not thrown — the workflow is not errored.
		expect(mocks.loggerWarnMock).toHaveBeenCalledTimes(1);
		expect(mocks.loggerWarnMock.mock.calls[0]?.[0]).toMatchObject({
			event: "pm_sync_log.retention.safety_cap_hit",
		});
	});

	// ---- Criterion 6: opt-out short-circuit --------------------------------
	it("(6) when retention is disabled/zero, returns { deletedCount: 0 }, deletes nothing, emits no purge event", async () => {
		process.env.FABRIC_PM_SYNC_LOG_RETENTION_DAYS = "0";

		const result = await purgeExpiredPmSyncLogRowsActivity();

		expect(result.deletedCount).toBe(0);
		expect(result.retentionDays).toBe(0);
		expect(mocks.executeRawMock).not.toHaveBeenCalled();
		// No "purged" self-event on the opt-out path. The "skipped" log is
		// expected and fine.
		const purgedEvents = (
			mocks.loggerInfoMock.mock.calls as unknown[][]
		).filter(
			(c) =>
				(c[0] as { event?: string } | undefined)?.event ===
				"pm_sync_log.retention.purged",
		);
		expect(purgedEvents).toEqual([]);
		const skippedEvents = (
			mocks.loggerInfoMock.mock.calls as unknown[][]
		).filter(
			(c) =>
				(c[0] as { event?: string } | undefined)?.event ===
				"pm_sync_log.retention.skipped",
		);
		expect(skippedEvents.length).toBe(1);
	});

	// ---- Criterion 7: non-destructive to the actual sync write path --------
	it("(7) is wholly separate from the sync write path — touches NO story/epic/feature/task table", async () => {
		process.env.FABRIC_PM_SYNC_LOG_RETENTION_DAYS = "90";
		// Two batches then drain, to inspect every emitted statement.
		mocks.executeRawMock
			.mockResolvedValueOnce(5_000)
			.mockResolvedValueOnce(0);

		await purgeExpiredPmSyncLogRowsActivity();

		const forbiddenTables = [
			'"user_story"',
			'"epic"',
			'"feature"',
			'"story_task"',
			'"project_story_status"',
			'"pending_pm_state_change"',
		];
		for (const call of mocks.executeRawMock.mock.calls as unknown[][]) {
			const sql = sqlFromCall(call);
			for (const table of forbiddenTables) {
				expect(sql).not.toContain(table);
			}
			expect(sql).toContain('"pm_sync_log"');
		}
	});
});
