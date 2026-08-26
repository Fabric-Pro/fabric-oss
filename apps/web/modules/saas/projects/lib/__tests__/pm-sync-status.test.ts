import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS, derivePmSyncStatus } from "../pm-sync-status";

const NOW = 1_700_000_000_000; // fixed clock for determinism

describe("derivePmSyncStatus", () => {
	it("returns 'disabled' when no PM tool is connected (regardless of other fields)", () => {
		expect(
			derivePmSyncStatus({
				hasPmToolConnected: false,
				adoStatePollActive: true,
				lastAdoStatePollAt: new Date(NOW),
				now: NOW,
			}),
		).toEqual({ kind: "disabled" });
	});

	it("returns 'not-enrolled' when connected but poll inactive", () => {
		expect(
			derivePmSyncStatus({
				hasPmToolConnected: true,
				adoStatePollActive: false,
				lastAdoStatePollAt: null,
				now: NOW,
			}),
		).toEqual({ kind: "not-enrolled" });
	});

	it("returns 'awaiting' when active but never polled", () => {
		expect(
			derivePmSyncStatus({
				hasPmToolConnected: true,
				adoStatePollActive: true,
				lastAdoStatePollAt: null,
				now: NOW,
			}),
		).toEqual({ kind: "awaiting" });
	});

	it("returns 'ok' for a recent poll (30 min ago)", () => {
		const at = new Date(NOW - 30 * 60 * 1000);
		expect(
			derivePmSyncStatus({
				hasPmToolConnected: true,
				adoStatePollActive: true,
				lastAdoStatePollAt: at,
				now: NOW,
			}),
		).toEqual({ kind: "ok", at });
	});

	it("returns 'stale' for an old poll (3h ago)", () => {
		const at = new Date(NOW - 3 * 60 * 60 * 1000);
		expect(
			derivePmSyncStatus({
				hasPmToolConnected: true,
				adoStatePollActive: true,
				lastAdoStatePollAt: at,
				now: NOW,
			}),
		).toEqual({ kind: "stale", at });
	});

	it("accepts an ISO string timestamp (oRPC may serialize Date as string)", () => {
		const iso = new Date(NOW - 30 * 60 * 1000).toISOString();
		const result = derivePmSyncStatus({
			hasPmToolConnected: true,
			adoStatePollActive: true,
			lastAdoStatePollAt: iso,
			now: NOW,
		});
		expect(result.kind).toBe("ok");
	});

	it("treats exactly STALE_AFTER_MS as 'ok' and one ms older as 'stale' (boundary)", () => {
		const atBoundary = new Date(NOW - STALE_AFTER_MS);
		const atPastBoundary = new Date(NOW - STALE_AFTER_MS - 1);
		expect(
			derivePmSyncStatus({
				hasPmToolConnected: true,
				adoStatePollActive: true,
				lastAdoStatePollAt: atBoundary,
				now: NOW,
			}).kind,
		).toBe("ok");
		expect(
			derivePmSyncStatus({
				hasPmToolConnected: true,
				adoStatePollActive: true,
				lastAdoStatePollAt: atPastBoundary,
				now: NOW,
			}).kind,
		).toBe("stale");
	});
});
