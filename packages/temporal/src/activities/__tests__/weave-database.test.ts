/**
 * Unit tests for `updateWeaveExecutionActivity`'s terminal-status guard.
 *
 * The completion phase marks a run COMPLETED via this activity. It must NOT
 * be able to overwrite a run that already reached a non-success terminal
 * state (CANCELLED by the cancel procedure, FAILED, or TERMINATED_STALE) —
 * otherwise a cancelled run that the execution phase reported as success is
 * silently re-labelled COMPLETED. Every other transition (including the
 * FAILED -> RUNNING retry-from-step path) is unaffected, and non-status
 * field updates always apply.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	update: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		weaveExecution: {
			findFirst: (...args: unknown[]) => mocks.findFirst(...args),
			update: (...args: unknown[]) => mocks.update(...args),
		},
	},
}));

import { updateWeaveExecutionActivity } from "../weave/database";

const BASE = {
	executionId: "wexec-1",
	userId: "user-1",
	organizationId: "org-1" as string | null,
};

beforeEach(() => {
	mocks.findFirst.mockReset();
	mocks.update.mockReset();
	mocks.update.mockResolvedValue({});
});

afterEach(() => {
	vi.clearAllMocks();
});

function dataOf() {
	return mocks.update.mock.calls[0][0].data as Record<string, unknown>;
}

describe("updateWeaveExecutionActivity — terminal-status guard", () => {
	it.each(["CANCELLED", "FAILED", "TERMINATED_STALE"])(
		"drops a COMPLETED status when the row is already %s, but still writes other fields",
		async (currentStatus) => {
			mocks.findFirst.mockResolvedValue({
				id: "wexec-1",
				status: currentStatus,
			});

			await updateWeaveExecutionActivity({
				...BASE,
				status: "COMPLETED",
				completedAt: new Date("2026-06-05T00:00:00.000Z"),
			});

			expect(mocks.update).toHaveBeenCalledTimes(1);
			const data = dataOf();
			expect(data.status).toBeUndefined();
			// non-status field still applied
			expect(data.completedAt).toBeInstanceOf(Date);
		},
	);

	it("allows COMPLETED when the row is still RUNNING (normal happy-path completion)", async () => {
		mocks.findFirst.mockResolvedValue({ id: "wexec-1", status: "RUNNING" });

		await updateWeaveExecutionActivity({ ...BASE, status: "COMPLETED" });

		expect(dataOf().status).toBe("COMPLETED");
	});

	it("allows CANCELLED to be written onto a RUNNING row", async () => {
		mocks.findFirst.mockResolvedValue({ id: "wexec-1", status: "RUNNING" });

		await updateWeaveExecutionActivity({ ...BASE, status: "CANCELLED" });

		expect(dataOf().status).toBe("CANCELLED");
	});

	it("allows FAILED -> RUNNING (retry-from-step resumes a failed run)", async () => {
		mocks.findFirst.mockResolvedValue({ id: "wexec-1", status: "FAILED" });

		await updateWeaveExecutionActivity({ ...BASE, status: "RUNNING" });

		// Only COMPLETED is blocked on a terminal row — RUNNING is allowed.
		expect(dataOf().status).toBe("RUNNING");
	});

	it("throws when the execution is not found / not owned (tenant isolation)", async () => {
		mocks.findFirst.mockResolvedValue(null);

		await expect(
			updateWeaveExecutionActivity({ ...BASE, status: "COMPLETED" }),
		).rejects.toThrow(/not found or access denied/);
		expect(mocks.update).not.toHaveBeenCalled();
	});
});
