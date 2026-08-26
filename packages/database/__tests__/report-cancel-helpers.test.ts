/**
 * Unit tests for the report-cancel race-safety helpers in
 * `prisma/queries/reports.ts`. The important behavior is the exact compare-and-set
 * WHERE clauses, so we mock the Prisma `db` client and assert the query shape + the
 * count→boolean contract deterministically (no Postgres needed).
 *
 * These guard both directions of the cancel race:
 *   - `cancelActiveTemplateInstanceExecution` flips only a PENDING/RUNNING row, so a run
 *     that already went terminal is never clobbered (returns false).
 *   - `finalizeTemplateInstanceExecutionStatus` (used by the execution workflow's own
 *     status writes, U4) refuses to overwrite a CANCELLED row — "CANCELLED wins once set".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUpdateMany = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		templateInstanceExecution: {
			updateMany: (...a: unknown[]) => mockUpdateMany(...a),
		},
	},
}));

import {
	cancelActiveTemplateInstanceExecution,
	finalizeTemplateInstanceExecutionStatus,
} from "../prisma/queries/reports";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("cancelActiveTemplateInstanceExecution — compare-and-set flip", () => {
	it("targets only PENDING/RUNNING rows and returns true when it wins the flip", async () => {
		mockUpdateMany.mockResolvedValue({ count: 1 });

		const won = await cancelActiveTemplateInstanceExecution("e1", {
			cancelledBy: "admin1",
		});

		expect(won).toBe(true);
		const args = mockUpdateMany.mock.calls[0][0] as {
			where: unknown;
			data: Record<string, unknown>;
		};
		expect(args.where).toEqual({
			id: "e1",
			status: { in: ["PENDING", "RUNNING"] },
		});
		expect(args.data).toMatchObject({
			status: "CANCELLED",
			error: "Cancelled by user",
			cancelledBy: "admin1",
		});
		expect(args.data.cancelledAt).toBeInstanceOf(Date);
		expect(args.data.completedAt).toBeInstanceOf(Date);
	});

	it("returns false without clobbering when the run already went terminal (count 0)", async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 });

		expect(
			await cancelActiveTemplateInstanceExecution("e1", {
				cancelledBy: "u1",
			}),
		).toBe(false);
	});
});

describe("finalizeTemplateInstanceExecutionStatus — CANCELLED wins once set", () => {
	it("guards the write with status != CANCELLED and returns true when it lands", async () => {
		mockUpdateMany.mockResolvedValue({ count: 1 });

		const landed = await finalizeTemplateInstanceExecutionStatus("e1", {
			status: "COMPLETED",
			completedAt: new Date(),
		});

		expect(landed).toBe(true);
		const args = mockUpdateMany.mock.calls[0][0] as {
			where: unknown;
			data: Record<string, unknown>;
		};
		expect(args.where).toEqual({ id: "e1", status: { not: "CANCELLED" } });
		expect(args.data).toMatchObject({ status: "COMPLETED" });
	});

	it("is a no-op (returns false) when the row is already CANCELLED (count 0)", async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 });

		expect(
			await finalizeTemplateInstanceExecutionStatus("e1", {
				status: "COMPLETED",
			}),
		).toBe(false);
	});
});
