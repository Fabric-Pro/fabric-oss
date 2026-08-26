import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockListInherit,
	mockListNeedNext,
	mockNormalize,
	mockParseStored,
	mockSetSchedule,
	mockComputeNext,
} = vi.hoisted(() => ({
	mockListInherit: vi.fn(),
	mockListNeedNext: vi.fn(),
	mockNormalize: vi.fn(),
	mockParseStored: vi.fn(),
	mockSetSchedule: vi.fn(),
	mockComputeNext: vi.fn(),
}));

// heartbeat() throws outside a real activity context — no-op it.
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

vi.mock("@repo/database", () => ({
	listInstancesNeedingScheduleInheritance: (...a: unknown[]) =>
		mockListInherit(...a),
	listInstancesNeedingNextRunAt: (...a: unknown[]) => mockListNeedNext(...a),
	normalizeReportSchedule: (...a: unknown[]) => mockNormalize(...a),
	parseStoredReportSchedule: (...a: unknown[]) => mockParseStored(...a),
	setInstanceSchedule: (...a: unknown[]) => mockSetSchedule(...a),
	computeNextRunAt: (...a: unknown[]) => mockComputeNext(...a),
}));

import { reconcileScheduledReportInstancesActivity } from "../reconcile-scheduled-report-instances";

const normalized = (anchorAt: string) => ({
	frequency: "weekly",
	dayOfWeek: 1,
	hour: 9,
	minute: 0,
	timezone: "UTC",
	anchorAt,
});

// Distinct from any anchorAt in the tests, so assertions prove the activity uses
// computeNextRunAt(now) (next FUTURE occurrence) rather than the frozen anchorAt (H2).
const NEXT_FUTURE = new Date("2026-12-31T09:00:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
	mockListInherit.mockResolvedValue([]);
	mockListNeedNext.mockResolvedValue([]);
	mockSetSchedule.mockResolvedValue(undefined);
	mockComputeNext.mockReturnValue(NEXT_FUTURE);
});

describe("reconcileScheduledReportInstancesActivity", () => {
	it("inherits a template schedule onto a NULL-schedule instance (normalized + nextRunAt)", async () => {
		mockListInherit.mockResolvedValue([
			{
				id: "i1",
				userId: "u1",
				organizationId: null,
				templateSchedule: { frequency: "weekly" },
			},
		]);
		mockNormalize.mockReturnValue(normalized("2026-06-29T09:00:00.000Z"));

		const r = await reconcileScheduledReportInstancesActivity({
			batchSize: 100,
		});

		expect(r.inherited).toBe(1);
		expect(mockSetSchedule).toHaveBeenCalledWith(
			"i1",
			expect.objectContaining({ anchorAt: "2026-06-29T09:00:00.000Z" }),
			NEXT_FUTURE, // computeNextRunAt(now), not the raw anchorAt
		);
	});

	it("skips an instance whose template schedule is malformed (normalize → null)", async () => {
		mockListInherit.mockResolvedValue([
			{
				id: "i1",
				userId: "u1",
				organizationId: null,
				templateSchedule: { bad: true },
			},
		]);
		mockNormalize.mockReturnValue(null);

		const r = await reconcileScheduledReportInstancesActivity({
			batchSize: 100,
		});

		expect(r.inherited).toBe(0);
		expect(mockSetSchedule).not.toHaveBeenCalled();
	});

	it("computes a FUTURE nextRunAt for a stale stored anchor (restored instance, H2 regression)", async () => {
		// A restored instance reuses an old schedule whose anchorAt is in the PAST.
		mockListNeedNext.mockResolvedValue([
			{ id: "i2", schedule: normalized("2026-01-01T09:00:00.000Z") },
		]);
		mockParseStored.mockReturnValue(normalized("2026-01-01T09:00:00.000Z"));

		const r = await reconcileScheduledReportInstancesActivity({
			batchSize: 100,
		});

		expect(r.computed).toBe(1);
		expect(mockNormalize).not.toHaveBeenCalled(); // parseStored hit → no re-normalize
		// Must NOT use the past anchorAt (would fire immediately); uses computeNextRunAt(now).
		expect(mockSetSchedule).toHaveBeenCalledWith(
			"i2",
			expect.objectContaining({ anchorAt: "2026-01-01T09:00:00.000Z" }),
			NEXT_FUTURE,
		);
	});

	it("normalizes a legacy {frequency}-only schedule that has no anchor", async () => {
		mockListNeedNext.mockResolvedValue([
			{ id: "i3", schedule: { frequency: "weekly" } },
		]);
		mockParseStored.mockReturnValue(null); // legacy, not yet normalized
		mockNormalize.mockReturnValue(normalized("2026-06-29T09:00:00.000Z"));

		const r = await reconcileScheduledReportInstancesActivity({
			batchSize: 100,
		});

		expect(r.computed).toBe(1);
		expect(mockNormalize).toHaveBeenCalled();
		expect(mockSetSchedule).toHaveBeenCalledWith(
			"i3",
			expect.objectContaining({ anchorAt: "2026-06-29T09:00:00.000Z" }),
			NEXT_FUTURE,
		);
	});
});
