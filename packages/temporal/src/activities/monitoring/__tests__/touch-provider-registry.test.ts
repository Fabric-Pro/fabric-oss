/**
 * Tests for the `touchProviderRegistry` helper.
 *
 * The helper exists because every monitoring activity used to rewrite its
 * provider's `IntegrationProviderRegistry` row on every single call, just
 * to move `lastPolledAt` forward. With a 2-minute poll across 29
 * providers that churned the table continuously on an idle environment.
 *
 * The contract under test: write only when a value actually changed, or
 * when the stored heartbeat is older than
 * `PROVIDER_HEARTBEAT_MIN_INTERVAL_MS`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const update = vi.fn();

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		integrationProviderRegistry: {
			findUnique: (args: unknown) => findUnique(args),
			update: (args: unknown) => update(args),
		},
	},
}));

import {
	PROVIDER_HEARTBEAT_MIN_INTERVAL_MS,
	touchProviderRegistry,
} from "../touch-provider-registry";

/** Pull the `data` payload of the single update the helper issued. */
function updateData(): Record<string, unknown> {
	expect(update).toHaveBeenCalledTimes(1);
	return (update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

const NOW = new Date("2026-01-01T12:00:00.000Z");
/** Stored heartbeat well inside the throttle window. */
const FRESH = new Date(NOW.getTime() - 30_000);
/** Stored heartbeat exactly at the throttle boundary — counts as stale. */
const STALE = new Date(NOW.getTime() - PROVIDER_HEARTBEAT_MIN_INTERVAL_MS);

beforeEach(() => {
	findUnique.mockReset();
	update.mockReset();
	update.mockResolvedValue({});
});

describe("touchProviderRegistry", () => {
	it("does not write when no registry row exists", async () => {
		findUnique.mockResolvedValueOnce(null);

		const result = await touchProviderRegistry({
			providerKey: "unknown-provider",
			currentHealth: "OPERATIONAL",
			now: NOW,
		});

		expect(result).toEqual({ updated: false, healthChanged: false });
		expect(update).not.toHaveBeenCalled();
	});

	it("does not write when nothing changed and the heartbeat is fresh", async () => {
		findUnique.mockResolvedValueOnce({
			currentHealth: "OPERATIONAL",
			lastIncidentId: null,
			lastPolledAt: FRESH,
		});

		const result = await touchProviderRegistry({
			providerKey: "openai",
			currentHealth: "OPERATIONAL",
			now: NOW,
		});

		expect(result).toEqual({ updated: false, healthChanged: false });
		expect(update).not.toHaveBeenCalled();
	});

	it("writes only lastPolledAt when nothing changed but the heartbeat is stale", async () => {
		findUnique.mockResolvedValueOnce({
			currentHealth: "OPERATIONAL",
			lastIncidentId: null,
			lastPolledAt: STALE,
		});

		const result = await touchProviderRegistry({
			providerKey: "openai",
			currentHealth: "OPERATIONAL",
			now: NOW,
		});

		expect(result).toEqual({ updated: true, healthChanged: false });
		expect(updateData()).toEqual({ lastPolledAt: NOW });
	});

	it("treats a never-polled row as stale", async () => {
		findUnique.mockResolvedValueOnce({
			currentHealth: "OPERATIONAL",
			lastIncidentId: null,
			lastPolledAt: null,
		});

		const result = await touchProviderRegistry({
			providerKey: "openai",
			now: NOW,
		});

		expect(result).toEqual({ updated: true, healthChanged: false });
		expect(updateData()).toEqual({ lastPolledAt: NOW });
	});

	it("writes health and refreshes the heartbeat when currentHealth changed, even while fresh", async () => {
		findUnique.mockResolvedValueOnce({
			currentHealth: "OPERATIONAL",
			lastIncidentId: null,
			lastPolledAt: FRESH,
		});

		const result = await touchProviderRegistry({
			providerKey: "openai",
			currentHealth: "MAJOR_OUTAGE",
			now: NOW,
		});

		expect(result).toEqual({ updated: true, healthChanged: true });
		expect(updateData()).toEqual({
			currentHealth: "MAJOR_OUTAGE",
			lastPolledAt: NOW,
		});
	});

	it("writes lastIncidentId and refreshes the heartbeat when it changed, even while fresh", async () => {
		findUnique.mockResolvedValueOnce({
			currentHealth: "MAJOR_OUTAGE",
			lastIncidentId: "incident-old",
			lastPolledAt: FRESH,
		});

		const result = await touchProviderRegistry({
			providerKey: "openai",
			currentHealth: "MAJOR_OUTAGE",
			lastIncidentId: "incident-new",
			now: NOW,
		});

		// Health matched, so `healthChanged` stays false even though a row
		// was written — the two flags are independent by design.
		expect(result).toEqual({ updated: true, healthChanged: false });
		expect(updateData()).toEqual({
			lastIncidentId: "incident-new",
			lastPolledAt: NOW,
		});
	});

	it("clears lastIncidentId when passed null", async () => {
		findUnique.mockResolvedValueOnce({
			currentHealth: "OPERATIONAL",
			lastIncidentId: "incident-old",
			lastPolledAt: FRESH,
		});

		const result = await touchProviderRegistry({
			providerKey: "openai",
			lastIncidentId: null,
			now: NOW,
		});

		expect(result).toEqual({ updated: true, healthChanged: false });
		expect(updateData()).toEqual({
			lastIncidentId: null,
			lastPolledAt: NOW,
		});
	});

	it("leaves currentHealth and lastIncidentId alone when they are omitted", async () => {
		findUnique.mockResolvedValueOnce({
			currentHealth: "DEGRADED",
			lastIncidentId: "incident-live",
			lastPolledAt: STALE,
		});

		await touchProviderRegistry({ providerKey: "openai", now: NOW });

		const data = updateData();
		expect(data).not.toHaveProperty("currentHealth");
		expect(data).not.toHaveProperty("lastIncidentId");
		expect(data).toEqual({ lastPolledAt: NOW });
	});

	it("swallows a failing read and reports no work", async () => {
		// Load-bearing: `upsertIntegrationIncident` calls this AFTER
		// committing the incident row and its FIRED event. A throw here
		// would fail the activity, and the retry would find the incident
		// already present, return `wasNew: false`, and leave the lifecycle
		// workflow unstarted.
		findUnique.mockRejectedValueOnce(new Error("registry read failed"));

		const result = await touchProviderRegistry({
			providerKey: "openai",
			currentHealth: "MAJOR_OUTAGE",
			now: NOW,
		});

		expect(result).toEqual({ updated: false, healthChanged: false });
		expect(update).not.toHaveBeenCalled();
	});

	it("swallows a failing write and reports no work, so a caller cannot announce an unpersisted transition", async () => {
		findUnique.mockResolvedValueOnce({
			currentHealth: "OPERATIONAL",
			lastIncidentId: null,
			lastPolledAt: FRESH,
		});
		update.mockRejectedValueOnce(new Error("registry write failed"));

		const result = await touchProviderRegistry({
			providerKey: "openai",
			currentHealth: "MAJOR_OUTAGE",
			now: NOW,
		});

		// The write was attempted but did not land, so `healthChanged` must
		// NOT claim the transition — the next tick re-reads the old value
		// and retries.
		expect(update).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ updated: false, healthChanged: false });
	});

	it("defaults `now` to the current time", async () => {
		findUnique.mockResolvedValueOnce({
			currentHealth: "OPERATIONAL",
			lastIncidentId: null,
			lastPolledAt: null,
		});

		const before = Date.now();
		await touchProviderRegistry({ providerKey: "openai" });

		const stamped = updateData().lastPolledAt as Date;
		expect(stamped).toBeInstanceOf(Date);
		expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
	});
});
