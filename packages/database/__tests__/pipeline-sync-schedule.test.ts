/**
 * When a project is due for an automatic pipeline-result sync (spec F1).
 *
 * The interval is a FLOOR, not a cadence: the sweep keeps ticking at its own
 * fixed rate and this decides whether a given project is due yet. That is what
 * lets per-project intervals exist without a Temporal schedule per project —
 * which would need reconciling as projects come and go.
 *
 * The boundaries ARE the behaviour, so they are what get asserted.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_PIPELINE_SYNC_INTERVAL_MINUTES,
	isPipelineSyncDue,
	normalisePipelineSyncInterval,
	PIPELINE_SYNC_INTERVAL_MINUTES,
} from "../prisma/queries/projects/pipeline-sync-schedule";

const NOW = new Date("2026-07-27T12:00:00.000Z");

function minutesAgo(n: number) {
	return new Date(NOW.getTime() - n * 60_000);
}

describe("isPipelineSyncDue", () => {
	it("is due when it has never fetched", () => {
		// Otherwise a newly connected repository looks broken for an interval.
		expect(
			isPipelineSyncDue({
				now: NOW,
				lastFetchedAt: null,
				intervalMinutes: 240,
			}),
		).toBe(true);
	});

	it("is not due before the interval has elapsed", () => {
		expect(
			isPipelineSyncDue({
				now: NOW,
				lastFetchedAt: minutesAgo(59),
				intervalMinutes: 60,
			}),
		).toBe(false);
	});

	it("is due at EXACTLY the interval, not one tick later", () => {
		// The sweep ticks on the same period as the shortest interval. With a
		// strict `>` every project would miss its slot by milliseconds and sync
		// at half the rate its owner chose — a bug that looks like "the schedule
		// is just unreliable".
		expect(
			isPipelineSyncDue({
				now: NOW,
				lastFetchedAt: minutesAgo(60),
				intervalMinutes: 60,
			}),
		).toBe(true);
	});

	it("is due once the interval has passed", () => {
		expect(
			isPipelineSyncDue({
				now: NOW,
				lastFetchedAt: minutesAgo(300),
				intervalMinutes: 240,
			}),
		).toBe(true);
	});

	it("uses the default interval for a project with no QA settings row", () => {
		// A project that has never opened Settings ▸ Testing must keep the
		// behaviour it already had, not stop syncing.
		expect(
			isPipelineSyncDue({
				now: NOW,
				lastFetchedAt: minutesAgo(
					DEFAULT_PIPELINE_SYNC_INTERVAL_MINUTES,
				),
				intervalMinutes: null,
			}),
		).toBe(true);
		expect(
			isPipelineSyncDue({
				now: NOW,
				lastFetchedAt: minutesAgo(
					DEFAULT_PIPELINE_SYNC_INTERVAL_MINUTES - 1,
				),
				intervalMinutes: null,
			}),
		).toBe(false);
	});

	it("counts a manual 'Sync now' as a fetch, so it does not double up", () => {
		// `lastFetchedAt` records the last SUCCESSFUL fetch whoever caused it.
		// Pressing Sync now and then having the sweep immediately fetch again
		// would double the load on the customer's provider for no new data.
		expect(
			isPipelineSyncDue({
				now: NOW,
				lastFetchedAt: minutesAgo(2),
				intervalMinutes: 15,
			}),
		).toBe(false);
	});
});

describe("normalisePipelineSyncInterval", () => {
	it("accepts every offered interval unchanged", () => {
		for (const minutes of PIPELINE_SYNC_INTERVAL_MINUTES) {
			expect(normalisePipelineSyncInterval(minutes)).toBe(minutes);
		}
	});

	it("falls back to the default for a value outside the set", () => {
		// Can only arrive from a direct database edit or an older client. The
		// honest response is the default cadence, not a crashed sweep.
		expect(normalisePipelineSyncInterval(7)).toBe(
			DEFAULT_PIPELINE_SYNC_INTERVAL_MINUTES,
		);
		expect(normalisePipelineSyncInterval(0)).toBe(
			DEFAULT_PIPELINE_SYNC_INTERVAL_MINUTES,
		);
		expect(normalisePipelineSyncInterval(null)).toBe(
			DEFAULT_PIPELINE_SYNC_INTERVAL_MINUTES,
		);
	});

	it("offers nothing shorter than the sweep's own tick", () => {
		// Offering 5 minutes when the sweep runs every 15 would be a promise the
		// product cannot keep.
		expect(Math.min(...PIPELINE_SYNC_INTERVAL_MINUTES)).toBe(15);
	});
});
