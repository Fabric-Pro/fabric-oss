import {
	FEATURE_FLAG_KEYS,
	FEATURE_FLAG_REGISTRY,
	type FeatureFlagKey,
	type FlagSource,
} from "@repo/utils/feature-flag-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Builds the expected `getAllFlags()` shape straight from the registry, with
 * per-key overrides for whatever the test scenario resolves differently from
 * the plain default (e.g. an env var or override row). This is what keeps
 * these tests from breaking every time someone registers a new flag: the
 * expectation grows with `FEATURE_FLAG_REGISTRY` instead of being a hardcoded
 * snapshot of it.
 */
function expectedFlags(
	overrides: Partial<Record<FeatureFlagKey, boolean>> = {},
): Record<FeatureFlagKey, boolean> {
	return Object.fromEntries(
		FEATURE_FLAG_KEYS.map((key) => [
			key,
			overrides[key] ?? FEATURE_FLAG_REGISTRY[key].default,
		]),
	) as Record<FeatureFlagKey, boolean>;
}

/** Same idea as `expectedFlags`, but for the detailed `{ key, enabled, source }` shape. */
function expectedDetailedFlags(
	overrides: Partial<
		Record<FeatureFlagKey, { enabled: boolean; source: FlagSource }>
	> = {},
): Array<{ key: FeatureFlagKey; enabled: boolean; source: FlagSource }> {
	return FEATURE_FLAG_KEYS.map((key) => ({
		key,
		enabled: overrides[key]?.enabled ?? FEATURE_FLAG_REGISTRY[key].default,
		source: overrides[key]?.source ?? "default",
	}));
}

const findMany = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		featureFlagOverride: {
			findMany: (...args: unknown[]) => findMany(...args),
			upsert: (...args: unknown[]) => upsert(...args),
			deleteMany: (...args: unknown[]) => deleteMany(...args),
		},
	},
}));

const loggerError = vi.fn();

vi.mock("@repo/logs", () => ({
	logger: {
		error: (...args: unknown[]) => loggerError(...args),
		warn: vi.fn(),
		info: vi.fn(),
	},
}));

import {
	__resetFeatureFlagCacheForTest,
	clearFlagOverride,
	getAllFlags,
	getAllFlagsDetailed,
	isFeatureEnabled,
	isKillSwitchArmed,
	setFlagOverride,
} from "../prisma/queries/feature-flags";

describe("feature flag readers", () => {
	beforeEach(() => {
		findMany.mockReset();
		upsert.mockReset();
		deleteMany.mockReset();
		loggerError.mockReset();
		__resetFeatureFlagCacheForTest();
		delete process.env.FABRIC_FEATURE_PERSONAL_MEETINGS;
	});

	it("returns the registry default when there is no row and no env var", async () => {
		findMany.mockResolvedValue([]);
		await expect(isFeatureEnabled("PERSONAL_MEETINGS")).resolves.toBe(
			false,
		);
	});

	it("uses the env var when there is no row", async () => {
		findMany.mockResolvedValue([]);
		process.env.FABRIC_FEATURE_PERSONAL_MEETINGS = "true";
		await expect(isFeatureEnabled("PERSONAL_MEETINGS")).resolves.toBe(true);
	});

	it("lets an override of false beat a truthy env var", async () => {
		findMany.mockResolvedValue([
			{ key: "PERSONAL_MEETINGS", enabled: false },
		]);
		process.env.FABRIC_FEATURE_PERSONAL_MEETINGS = "true";
		await expect(isFeatureEnabled("PERSONAL_MEETINGS")).resolves.toBe(
			false,
		);
	});

	it("ignores rows for keys that are not in the registry", async () => {
		findMany.mockResolvedValue([
			{ key: "REMOVED_FLAG", enabled: true },
			{ key: "PERSONAL_MEETINGS", enabled: true },
		]);
		const flags = await getAllFlags();
		// `expectedFlags` only ever contains registered keys, so this `toEqual`
		// fails both if a registered flag resolves wrong AND if the
		// unregistered `REMOVED_FLAG` row leaks into the result (an extra key
		// on the received side fails deep-equality against an object that
		// doesn't have it).
		expect(flags).toEqual(expectedFlags({ PERSONAL_MEETINGS: true }));
		expect(flags).not.toHaveProperty("REMOVED_FLAG");
	});

	it("reports the resolution source for the admin UI", async () => {
		findMany.mockResolvedValue([]);
		process.env.FABRIC_FEATURE_PERSONAL_MEETINGS = "true";
		await expect(getAllFlagsDetailed()).resolves.toEqual(
			expectedDetailedFlags({
				PERSONAL_MEETINGS: { enabled: true, source: "env" },
			}),
		);
	});

	it("caches reads within the TTL and re-reads after a write", async () => {
		findMany.mockResolvedValue([]);
		await getAllFlags();
		await getAllFlags();
		expect(findMany).toHaveBeenCalledTimes(1);

		upsert.mockResolvedValue({});
		await setFlagOverride({
			key: "PERSONAL_MEETINGS",
			enabled: true,
			updatedBy: "user_1",
		});

		findMany.mockResolvedValue([
			{ key: "PERSONAL_MEETINGS", enabled: true },
		]);
		await expect(isFeatureEnabled("PERSONAL_MEETINGS")).resolves.toBe(true);
		expect(findMany).toHaveBeenCalledTimes(2);
	});

	it("falls back to env/registry values instead of throwing when findMany rejects", async () => {
		findMany.mockRejectedValue(new Error("relation does not exist"));

		await expect(getAllFlags()).resolves.toEqual(expectedFlags());
	});

	it("still lets a truthy env var win when findMany rejects", async () => {
		findMany.mockRejectedValue(new Error("relation does not exist"));
		process.env.FABRIC_FEATURE_PERSONAL_MEETINGS = "true";

		await expect(isFeatureEnabled("PERSONAL_MEETINGS")).resolves.toBe(true);
	});

	it("logs the failure at error level with context", async () => {
		findMany.mockRejectedValue(new Error("relation does not exist"));

		await getAllFlags();

		expect(loggerError).toHaveBeenCalledTimes(1);
		const [meta, message] = loggerError.mock.calls[0];
		expect(meta).toMatchObject({
			event: "feature_flags.override_read_failed",
			err: expect.objectContaining({
				message: "relation does not exist",
			}),
		});
		expect(String(message)).toMatch(/feature flag/i);
	});

	it("does not cache a failed read, so the next call retries", async () => {
		findMany.mockRejectedValueOnce(new Error("relation does not exist"));
		await expect(getAllFlags()).resolves.toEqual(expectedFlags());

		findMany.mockResolvedValueOnce([
			{ key: "PERSONAL_MEETINGS", enabled: true },
		]);
		await expect(isFeatureEnabled("PERSONAL_MEETINGS")).resolves.toBe(true);
		expect(findMany).toHaveBeenCalledTimes(2);
	});

	it("still rejects on a failed write", async () => {
		upsert.mockRejectedValue(new Error("write failed"));

		await expect(
			setFlagOverride({
				key: "PERSONAL_MEETINGS",
				enabled: true,
				updatedBy: "user_1",
			}),
		).rejects.toThrow("write failed");
	});

	it("clearFlagOverride deletes the row by key and busts the cache", async () => {
		findMany.mockResolvedValue([
			{ key: "PERSONAL_MEETINGS", enabled: true },
		]);
		await getAllFlags();
		expect(findMany).toHaveBeenCalledTimes(1);

		deleteMany.mockResolvedValue({ count: 1 });
		await clearFlagOverride("PERSONAL_MEETINGS");
		expect(deleteMany).toHaveBeenCalledWith({
			where: { key: "PERSONAL_MEETINGS" },
		});

		// Cache busted: the next read hits the DB again and now sees no row,
		// so the flag falls through to the registry default (false).
		findMany.mockResolvedValue([]);
		await expect(getAllFlags()).resolves.toEqual(expectedFlags());
		expect(findMany).toHaveBeenCalledTimes(2);
	});

	it("clearFlagOverride is idempotent when no row exists (deleteMany, count 0)", async () => {
		deleteMany.mockResolvedValue({ count: 0 });
		await expect(
			clearFlagOverride("PERSONAL_MEETINGS"),
		).resolves.toBeUndefined();
	});

	it("clearFlagOverride rejects on a failed delete (not swallowed)", async () => {
		deleteMany.mockRejectedValue(new Error("delete failed"));
		await expect(clearFlagOverride("PERSONAL_MEETINGS")).rejects.toThrow(
			"delete failed",
		);
	});

	// A kill switch must not resolve back ON when the table holding an
	// administrator's OFF cannot be read. `isFeatureEnabled` degrades to the env
	// value on purpose — right for a rollout gate, wrong for a brake, because a
	// brake's env var is typically true in every environment precisely so the
	// switch is available.
	describe("isKillSwitchArmed", () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it("resolves DISABLED when the override table cannot be read", async () => {
			// The deployed posture for a brake: env var true everywhere, so the
			// lenient reader has something to fall back TO. That fallback is
			// exactly what must not happen here.
			vi.stubEnv("FABRIC_FEATURE_LIVING_DOCS_REFRESH", "true");
			__resetFeatureFlagCacheForTest();
			findMany.mockRejectedValue(new Error("relation does not exist"));

			// The lenient reader falls back to the env var and says armed...
			expect(await isFeatureEnabled("LIVING_DOCS_REFRESH_SWEEP")).toBe(
				true,
			);
			// ...the strict one refuses to, which is the whole point.
			expect(await isKillSwitchArmed("LIVING_DOCS_REFRESH_SWEEP")).toBe(
				false,
			);
		});

		it("honours a readable override and env value when the read succeeds", async () => {
			vi.stubEnv("FABRIC_FEATURE_LIVING_DOCS_REFRESH", "true");
			__resetFeatureFlagCacheForTest();
			findMany.mockResolvedValue([]);
			expect(await isKillSwitchArmed("LIVING_DOCS_REFRESH_SWEEP")).toBe(
				true,
			);

			__resetFeatureFlagCacheForTest();
			findMany.mockResolvedValue([
				{ key: "LIVING_DOCS_REFRESH_SWEEP", enabled: false },
			]);
			expect(await isKillSwitchArmed("LIVING_DOCS_REFRESH_SWEEP")).toBe(
				false,
			);
		});
	});
});
