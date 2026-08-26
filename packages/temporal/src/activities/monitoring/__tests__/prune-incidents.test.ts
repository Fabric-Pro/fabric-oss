/**
 * Tests for `pruneIncidents` activity.
 *
 * Verifies:
 *   - Deletes only rows older than the cutoff.
 *   - Cascade delete is the schema's job — we only assert the activity
 *     issues the right `where` clauses (firedAt < cutoff and
 *     startedAt < cutoff).
 *   - Validates the `olderThanDays` input.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteManyErrorRate = vi.fn();
const deleteManyIntegration = vi.fn();

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		errorRateIncident: {
			deleteMany: (args: unknown) => deleteManyErrorRate(args),
		},
		integrationIncident: {
			deleteMany: (args: unknown) => deleteManyIntegration(args),
		},
	},
}));

import { pruneIncidents } from "../prune-incidents";

beforeEach(() => {
	deleteManyErrorRate.mockReset();
	deleteManyIntegration.mockReset();
	deleteManyErrorRate.mockResolvedValue({ count: 7 });
	deleteManyIntegration.mockResolvedValue({ count: 3 });
});

describe("pruneIncidents", () => {
	it("issues deleteMany on both incident tables with firedAt / startedAt filters", async () => {
		const result = await pruneIncidents({ olderThanDays: 365 });

		expect(deleteManyErrorRate).toHaveBeenCalledTimes(1);
		expect(deleteManyIntegration).toHaveBeenCalledTimes(1);
		expect(
			deleteManyErrorRate.mock.calls[0][0].where.firedAt.lt,
		).toBeInstanceOf(Date);
		expect(
			deleteManyIntegration.mock.calls[0][0].where.startedAt.lt,
		).toBeInstanceOf(Date);
		expect(result.errorRateDeleted).toBe(7);
		expect(result.integrationDeleted).toBe(3);
	});

	it("computes the cutoff as now - olderThanDays days", async () => {
		const now = Date.now();
		await pruneIncidents({ olderThanDays: 365 });
		const cutoff = deleteManyErrorRate.mock.calls[0][0].where.firedAt
			.lt as Date;
		const expected = now - 365 * 24 * 60 * 60 * 1000;
		// Allow a generous window for clock skew during the test run.
		expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(2_000);
	});

	it("throws on non-positive olderThanDays", async () => {
		await expect(pruneIncidents({ olderThanDays: 0 })).rejects.toThrow(
			/positive number/,
		);
		await expect(pruneIncidents({ olderThanDays: -1 })).rejects.toThrow(
			/positive number/,
		);
	});
});
