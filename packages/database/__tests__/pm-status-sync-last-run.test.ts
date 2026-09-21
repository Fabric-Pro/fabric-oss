/**
 * The `Project.pmStatusSyncLastRun` contract (Fizzy #2304, spec D2.6): one zod
 * schema every writer builds through and the settings card parses through,
 * and a non-fatal jsonb-merge writer guarded on the switch and the session.
 *
 * The Prisma client is mocked. `$executeRaw` is a tagged template, so the mock
 * receives `(strings, ...values)`: the tests pin the statement text (the
 * joined strings, whitespace-collapsed) and the bound values separately.
 *
 * Run with: pnpm --filter @repo/database exec vitest run __tests__/pm-status-sync-last-run.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	executeRaw: vi.fn(),
	loggerWarn: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: { $executeRaw: mocks.executeRaw },
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: mocks.loggerWarn },
}));

import {
	mergePmStatusSyncLastRun,
	type PmStatusSyncLastRun,
	pmStatusSyncLastRunSchema,
} from "../prisma/queries/pm-status-sync-last-run";

const SESSION_AT = new Date("2026-09-21T09:00:00.000Z");
const AT = "2026-09-21T10:00:04.000Z";

const ZERO_COUNTS = {
	moved: 0,
	unchanged: 0,
	"fabric-ahead": 0,
	"not-mapped": 0,
	ambiguous: 0,
	unverified: 0,
	stale: 0,
	"skipped-conflict": 0,
	raced: 0,
};

const FULL_RUN: PmStatusSyncLastRun = {
	sessionAt: SESSION_AT.toISOString(),
	fetch: {
		at: AT,
		linked: 40,
		fetched: 37,
		failed: 2,
		notFound: 1,
		complete: false,
	},
	failure: {
		at: AT,
		kind: "fetch-failed",
		error: "GitLab request timed out",
	},
	outcome: { at: AT, counts: { ...ZERO_COUNTS, moved: 3, unchanged: 30 } },
};

const EXPECTED_SQL =
	'UPDATE "project" SET "pmStatusSyncLastRun" = CASE WHEN jsonb_typeof("pmStatusSyncLastRun") = \'object\' THEN "pmStatusSyncLastRun" ELSE \'{}\'::jsonb END || ?::jsonb WHERE "id" = ? AND "pmStatusSyncEnabled" = true AND "pmStatusSyncSessionAt" = ?';

function statementOf(call: unknown[]): string {
	const strings = call[0] as readonly string[];
	return strings.join("?").replace(/\s+/g, " ").trim();
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.executeRaw.mockResolvedValue(1);
});

describe("pmStatusSyncLastRunSchema", () => {
	it("accepts a full summary and a session-only one", () => {
		expect(pmStatusSyncLastRunSchema.safeParse(FULL_RUN)).toEqual({
			success: true,
			data: FULL_RUN,
		});
		expect(
			pmStatusSyncLastRunSchema.safeParse({
				sessionAt: SESSION_AT.toISOString(),
			}).success,
		).toBe(true);
	});

	it("accepts a source-not-found failure", () => {
		expect(
			pmStatusSyncLastRunSchema.safeParse({
				sessionAt: SESSION_AT.toISOString(),
				failure: {
					at: AT,
					kind: "source-not-found",
					error: "PM source not found",
				},
			}).success,
		).toBe(true);
	});

	it.each([
		["a missing sessionAt", { fetch: FULL_RUN.fetch }],
		["a non-ISO sessionAt", { sessionAt: "yesterday" }],
		[
			"a negative count",
			{
				sessionAt: SESSION_AT.toISOString(),
				fetch: { ...FULL_RUN.fetch, failed: -1 },
			},
		],
		[
			"a fractional count",
			{
				sessionAt: SESSION_AT.toISOString(),
				fetch: { ...FULL_RUN.fetch, linked: 1.5 },
			},
		],
		[
			"an unknown failure kind",
			{
				sessionAt: SESSION_AT.toISOString(),
				failure: { at: AT, kind: "timeout", error: "x" },
			},
		],
		[
			"outcome counts missing an outcome",
			{
				sessionAt: SESSION_AT.toISOString(),
				outcome: {
					at: AT,
					counts: { ...ZERO_COUNTS, raced: undefined },
				},
			},
		],
	])("rejects %s", (_label, value) => {
		// Positive control: the full summary parses, so a rejection below is
		// about the one field each case breaks.
		expect(pmStatusSyncLastRunSchema.safeParse(FULL_RUN).success).toBe(
			true,
		);
		expect(pmStatusSyncLastRunSchema.safeParse(value).success).toBe(false);
	});
});

describe("mergePmStatusSyncLastRun", () => {
	it("merges the patch into the stored JSON, guarded on the switch and the session", async () => {
		await mergePmStatusSyncLastRun({
			projectId: "proj-1",
			sessionAt: SESSION_AT,
			patch: { fetch: FULL_RUN.fetch },
		});

		expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
		const call = mocks.executeRaw.mock.calls[0];
		expect(statementOf(call)).toBe(EXPECTED_SQL);
		expect(call.slice(1)).toHaveLength(3);
		expect(JSON.parse(call[1] as string)).toEqual({
			sessionAt: SESSION_AT.toISOString(),
			fetch: FULL_RUN.fetch,
		});
		expect(call[2]).toBe("proj-1");
		expect(call[3]).toEqual(SESSION_AT);
		expect(mocks.loggerWarn).not.toHaveBeenCalled();
	});

	it("caps a failure message at 500 characters", async () => {
		await mergePmStatusSyncLastRun({
			projectId: "proj-1",
			sessionAt: SESSION_AT,
			patch: {
				failure: {
					at: AT,
					kind: "fetch-failed",
					error: "x".repeat(2000),
				},
			},
		});
		const written = JSON.parse(mocks.executeRaw.mock.calls[0][1] as string);
		expect(written.failure).toEqual({
			at: AT,
			kind: "fetch-failed",
			error: "x".repeat(500),
		});
	});

	it("swallows a failed write and logs it", async () => {
		mocks.executeRaw.mockRejectedValue(new Error("connection reset"));

		await expect(
			mergePmStatusSyncLastRun({
				projectId: "proj-1",
				sessionAt: SESSION_AT,
				patch: { outcome: FULL_RUN.outcome },
			}),
		).resolves.toBeUndefined();

		expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
		expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
		expect(mocks.loggerWarn.mock.calls[0][0]).toEqual({
			event: "pm_status_sync.last_run_write_failed",
			projectId: "proj-1",
			err: { message: "connection reset", name: "Error" },
		});
	});

	it("drops a patch the schema rejects without writing", async () => {
		// Positive control: a valid patch writes.
		await mergePmStatusSyncLastRun({
			projectId: "proj-1",
			sessionAt: SESSION_AT,
			patch: { fetch: FULL_RUN.fetch },
		});
		expect(mocks.executeRaw).toHaveBeenCalledTimes(1);

		await mergePmStatusSyncLastRun({
			projectId: "proj-1",
			sessionAt: SESSION_AT,
			patch: {
				fetch: {
					...(FULL_RUN.fetch as NonNullable<
						PmStatusSyncLastRun["fetch"]
					>),
					linked: -3,
				},
			},
		});

		expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
		expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
		expect(mocks.loggerWarn.mock.calls[0][0]).toMatchObject({
			event: "pm_status_sync.last_run_rejected",
			projectId: "proj-1",
		});
	});
});
