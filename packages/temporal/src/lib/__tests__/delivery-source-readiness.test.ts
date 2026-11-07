import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@repo/database", () => ({ db: { $queryRaw: m.query } }));

import {
	getPrivateDeliverySourceAvailability,
	isPrivateDeliverySourceCaptureEnabled,
	isPrivateDeliverySourceStorageReady,
	PrivateDeliverySourceUnavailableError,
	requirePrivateDeliverySourceAvailability,
} from "../delivery-source-readiness";

beforeEach(() => {
	vi.stubEnv("FABRIC_PRIVATE_SOURCE_CAPTURE_ENABLED", "");
	m.query.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe("private source operator and storage readiness", () => {
	it.each(["", "false", "TRUE", " true", "true ", "1"])(
		"defaults off without database/provider queries for flag %j",
		async (flag) => {
			vi.stubEnv("FABRIC_PRIVATE_SOURCE_CAPTURE_ENABLED", flag);
			expect(isPrivateDeliverySourceCaptureEnabled()).toBe(false);
			expect(await getPrivateDeliverySourceAvailability()).toEqual({
				state: "UNAVAILABLE",
				reason: "NOT_ENABLED",
			});
			expect(m.query).not.toHaveBeenCalled();
		},
	);
	it("defaults off when the operator flag is absent", async () => {
		delete process.env.FABRIC_PRIVATE_SOURCE_CAPTURE_ENABLED;
		expect(await getPrivateDeliverySourceAvailability()).toEqual({
			state: "UNAVAILABLE",
			reason: "NOT_ENABLED",
		});
		expect(m.query).not.toHaveBeenCalled();
	});
	it("enables only after all required scoped physical tables are present", async () => {
		vi.stubEnv("FABRIC_PRIVATE_SOURCE_CAPTURE_ENABLED", "true");
		m.query.mockResolvedValue([{ ready: true }]);
		expect(isPrivateDeliverySourceCaptureEnabled()).toBe(true);
		expect(await getPrivateDeliverySourceAvailability()).toEqual({
			state: "ENABLED",
			reason: null,
		});
		await expect(
			requirePrivateDeliverySourceAvailability(),
		).resolves.toBeUndefined();
		const catalog = m.query.mock.calls[0][0].join("?");
		expect(catalog).toContain("pg_catalog.pg_class");
		expect(catalog).toContain("c.relrowsecurity AND c.relforcerowsecurity");
		expect(catalog).toContain("count(*) = 5");
		expect(catalog).toContain("captureWindowStart");
		expect(catalog).toContain("delivery_source_capture_window_finite");
		expect(m.query.mock.calls[0].slice(1)).toEqual([true]);
		expect(catalog).not.toMatch(/FROM\s+delivery_signal_/);
	});
	it.each(
		[[{ ready: false }], [], [{ ready: null }]].map((rows) => ({ rows })),
	)("keeps missing or unproven storage unavailable: %#", async ({ rows }) => {
		vi.stubEnv("FABRIC_PRIVATE_SOURCE_CAPTURE_ENABLED", "true");
		m.query.mockResolvedValue(rows);
		expect(await getPrivateDeliverySourceAvailability()).toEqual({
			state: "UNAVAILABLE",
			reason: "STORAGE_UNAVAILABLE",
		});
	});
	it("sanitizes connection/catalog failure and never breaks disabled startup", async () => {
		vi.stubEnv("FABRIC_PRIVATE_SOURCE_CAPTURE_ENABLED", "true");
		m.query.mockRejectedValue(Error("example-private-database-connection"));
		expect(await getPrivateDeliverySourceAvailability()).toEqual({
			state: "UNAVAILABLE",
			reason: "STORAGE_UNAVAILABLE",
		});
		try {
			await requirePrivateDeliverySourceAvailability();
			throw Error("Expected unavailable");
		} catch (error) {
			expect(error).toBeInstanceOf(PrivateDeliverySourceUnavailableError);
			expect(error).toHaveProperty(
				"code",
				"PRIVATE_SOURCE_CAPTURE_UNAVAILABLE",
			);
			expect(String(error)).not.toContain("example-private-database");
			expect((error as Error).cause).toBeUndefined();
		}
	});
	it("does not cache readiness across disabling/re-enabling or schema replacement", async () => {
		vi.stubEnv("FABRIC_PRIVATE_SOURCE_CAPTURE_ENABLED", "true");
		m.query.mockResolvedValueOnce([{ ready: true }]);
		expect((await getPrivateDeliverySourceAvailability()).state).toBe(
			"ENABLED",
		);
		vi.stubEnv("FABRIC_PRIVATE_SOURCE_CAPTURE_ENABLED", "false");
		expect((await getPrivateDeliverySourceAvailability()).reason).toBe(
			"NOT_ENABLED",
		);
		vi.stubEnv("FABRIC_PRIVATE_SOURCE_CAPTURE_ENABLED", "true");
		m.query.mockResolvedValueOnce([{ ready: false }]);
		expect((await getPrivateDeliverySourceAvailability()).reason).toBe(
			"STORAGE_UNAVAILABLE",
		);
		expect(m.query).toHaveBeenCalledTimes(2);
	});
	it("allows catalog-only retention storage qualification while ingestion remains off", async () => {
		vi.stubEnv("FABRIC_PRIVATE_SOURCE_CAPTURE_ENABLED", "false");
		m.query.mockResolvedValue([{ ready: true }]);
		expect(await isPrivateDeliverySourceStorageReady()).toBe(true);
		expect(m.query.mock.calls[0].slice(1)).toEqual([false]);
		expect(await getPrivateDeliverySourceAvailability()).toEqual({
			state: "UNAVAILABLE",
			reason: "NOT_ENABLED",
		});
		expect(m.query).toHaveBeenCalledTimes(1);
	});
});
