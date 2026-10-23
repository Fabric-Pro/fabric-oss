import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	findUnique: vi.fn(),
	updateMany: vi.fn(),
	update: vi.fn(),
	count: vi.fn(),
}));
vi.mock("../prisma/client", () => ({ db: { pendingBacklogProposal: mocks } }));

import * as queries from "../prisma/queries/projects/pending-backlog-proposals";

const cutoff = new Date("2026-10-21T12:00:00Z");
const old = new Date("2026-10-21T11:00:00Z");
const fresh = new Date("2026-10-21T12:01:00Z");
const staleWhere = {
	OR: [
		{ status: "PENDING", applyStartedAt: { not: null, lt: cutoff } },
		{
			status: { in: ["APPROVED", "APPLYING"] },
			AND: [
				{
					OR: [
						{ applyStartedAt: null },
						{ applyStartedAt: { lt: cutoff } },
					],
				},
				{
					OR: [
						{ reviewedAt: { lt: cutoff } },
						{ reviewedAt: null, createdAt: { lt: cutoff } },
					],
				},
			],
		},
	],
};

// Evaluate the emitted Prisma subset against fixtures; this is query-shaping
// coverage, not proof of Postgres concurrency or SQL execution.
function matches(
	row: Record<string, unknown>,
	where: Record<string, unknown>,
): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (key === "OR") {
			return (value as Record<string, unknown>[]).some((w) =>
				matches(row, w),
			);
		}
		if (key === "AND") {
			return (value as Record<string, unknown>[]).every((w) =>
				matches(row, w),
			);
		}
		if (
			value !== null &&
			typeof value === "object" &&
			!(value instanceof Date)
		) {
			const filter = value as {
				in?: unknown[];
				not?: unknown;
				lt?: Date;
			};
			return (
				(!filter.in || filter.in.includes(row[key])) &&
				(!("not" in filter) || row[key] !== filter.not) &&
				(!filter.lt ||
					(row[key] instanceof Date &&
						(row[key] as Date) < filter.lt))
			);
		}
		return row[key] === value;
	});
}

beforeEach(() => {
	vi.resetAllMocks();
});
describe("stale apply recovery queries", () => {
	it.each([
		["APPROVED", null, null, old, true],
		["APPROVED", null, old, old, true],
		["APPLYING", old, old, old, true],
		["APPLYING", null, null, old, true],
		["APPLYING", null, null, fresh, false],
		["APPLYING", fresh, null, old, false],
		["APPLYING", old, fresh, old, false],
		["APPROVED", fresh, old, old, false],
		["APPROVED", null, null, fresh, false],
		["PENDING", old, fresh, old, true],
		["PENDING", null, old, old, false],
		["FAILED", old, old, old, false],
		["APPLYING", old, cutoff, old, false],
	])(
		"finds %s dispatch=%s review=%s created=%s: %s",
		async (status, applyStartedAt, reviewedAt, createdAt, expected) => {
			const row = {
				id: "example-proposal",
				status,
				applyStartedAt,
				reviewedAt,
				createdAt,
			};
			mocks.findMany.mockImplementation(async ({ where }) =>
				matches(row, where) ? [row] : [],
			);
			const rows = await queries.findStaleApplyingProposals({
				cutoff,
				limit: 25,
			});
			expect(rows).toHaveLength(expected ? 1 : 0);
			expect(mocks.findMany.mock.calls[0][0]).toMatchObject({
				select: { reviewedAt: true, createdAt: true },
				take: 25,
			});
		},
	);

	it("atomically rechecks the complete stale predicate and writes FAILED fields", async () => {
		mocks.updateMany.mockResolvedValue({ count: 1 });
		expect(
			await queries.timeOutStaleApply({
				proposalId: "example-proposal",
				cutoff,
				errorClass: "TimedOut",
				errorMessage: "Example timeout",
			}),
		).toBe(1);
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "example-proposal", ...staleWhere },
			data: {
				status: "FAILED",
				errorClass: "TimedOut",
				errorMessage: "Example timeout",
				applyError: "Example timeout",
				failedAt: expect.any(Date),
			},
		});
	});

	it.each([
		["APPROVED", null, old, 1],
		["PENDING", null, old, 0],
		["APPLYING", old, fresh, 0],
		["APPLIED", old, old, 0],
		["FAILED", old, old, 0],
	])(
		"guards timeout after a concurrent transition to %s",
		async (status, applyStartedAt, reviewedAt, expected) => {
			const row = {
				id: "example-proposal",
				status,
				applyStartedAt,
				reviewedAt,
				createdAt: old,
			};
			mocks.updateMany.mockImplementation(async ({ where }) => ({
				count: matches(row, where) ? 1 : 0,
			}));
			expect(
				await queries.timeOutStaleApply({
					proposalId: "example-proposal",
					cutoff,
					errorClass: "TimedOut",
					errorMessage: "Example timeout",
				}),
			).toBe(expected);
		},
	);
});

describe("dispatch and review defaults", () => {
	it("counts the review-inbox statuses when no status is passed", async () => {
		mocks.count.mockResolvedValue(2);
		expect(
			await queries.countPendingBacklogProposals("example-project"),
		).toBe(2);
		expect(mocks.count).toHaveBeenCalledWith({
			where: {
				projectId: "example-project",
				status: { in: ["PENDING", "APPROVED", "APPLYING", "FAILED"] },
			},
		});
	});
	it.each([
		["APPROVED", null, 1],
		["APPROVED", "example-workflow", 1],
		["APPROVED", "example-other-workflow", 0],
		["PENDING", null, 0],
		["APPLIED", null, 0],
		["APPLYING", "example-workflow", 0],
	])(
		"stamps approved mode for status %s workflow %s: %i",
		async (status, applyWorkflowId, count) => {
			const row: Record<string, unknown> = {
				id: "example-proposal",
				status,
				applyWorkflowId,
				applyStartedAt: null,
			};
			mocks.updateMany.mockImplementation(async ({ where, data }) => {
				if (!matches(row, where)) {
					return { count: 0 };
				}
				Object.assign(row, data);
				return { count: 1 };
			});
			expect(
				await queries.markProposalApplyDispatched({
					proposalId: "example-proposal",
					applyWorkflowId: "example-workflow",
					mode: "approved",
				}),
			).toBe(count);
			expect(row.applyStartedAt).toEqual(count ? expect.any(Date) : null);
			expect(row.applyWorkflowId).toBe(
				count ? "example-workflow" : applyWorkflowId,
			);
		},
	);
});

describe("claimed failure timestamp", () => {
	it.each([null, old])(
		"stamps failedAt when the normal claimed finalizer fails (previous %s)",
		async (previous) => {
			const now = new Date("2026-10-21T12:20:00Z");
			vi.useFakeTimers();
			vi.setSystemTime(now);
			try {
				const row: Record<string, unknown> = {
					id: "example-proposal",
					source: "AI_UPDATE_SIDEBAR",
					status: "APPLYING",
					applyWorkflowId: "example-workflow",
					failedAt: previous,
				};
				mocks.findUnique.mockResolvedValue(row);
				mocks.updateMany.mockImplementation(async ({ where, data }) => {
					if (!matches(row, where)) {
						return { count: 0 };
					}
					Object.assign(row, data);
					return { count: 1 };
				});
				expect(
					await queries.finalizeClaimedProposal({
						proposalId: "example-proposal",
						applyWorkflowId: "example-workflow",
						outcome: "failed",
						errorMessage: "Example failure",
					}),
				).toBe(true);
				expect(row).toMatchObject({ status: "FAILED", failedAt: now });
			} finally {
				vi.useRealTimers();
			}
		},
	);
});

describe("approval claim clock", () => {
	it("clears an earlier dispatch when assigning the Slack approval workflow", async () => {
		const row = {
			status: "FAILED",
			applyWorkflowId: "example-old-workflow",
			applyStartedAt: old,
			reviewedAt: old,
		};
		mocks.update.mockImplementation(async ({ data }) =>
			Object.assign(row, data),
		);
		await queries.markPendingProposalApproved({
			proposalId: "example-proposal",
			reviewedBy: "example-user",
			applyWorkflowId: "example-new-workflow",
		});
		expect(row).toMatchObject({
			status: "APPROVED",
			applyWorkflowId: "example-new-workflow",
			applyStartedAt: null,
			reviewedAt: expect.any(Date),
		});
	});
});
