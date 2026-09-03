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
const findUnique = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();
const findManyOrg = vi.fn();
const findUniqueOrg = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		featureFlagOverride: {
			findMany: (...args: unknown[]) => findMany(...args),
			findUnique: (...args: unknown[]) => findUnique(...args),
			upsert: (...args: unknown[]) => upsert(...args),
			deleteMany: (...args: unknown[]) => deleteMany(...args),
		},
		organizationFeatureFlagOverride: {
			findMany: (...args: unknown[]) => findManyOrg(...args),
			findUnique: (...args: unknown[]) => findUniqueOrg(...args),
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
	__ORG_CACHE_MAX_FOR_TEST,
	__resetFeatureFlagCacheForTest,
	clearFlagOverride,
	getAllFlags,
	getAllFlagsDetailed,
	getAllFlagsForOrganization,
	getDisabledOrganizationIds,
	getEnabledOrganizationIds,
	getGlobalFlagOverride,
	getOrganizationFlagOverrideUncached,
	getOrgFlagOverrides,
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

// Fix round 2 (§FIX 2): `isFeatureEnabled`'s global read goes through
// `getFlagOverrides`'s 10-second TTL cache — correct for hot request paths,
// wrong for the daily publishing sweep's once-a-tick, credit-spending
// decision. `getGlobalFlagOverride` is the dedicated escape hatch: a direct,
// uncached row read, mirroring `getEnabledOrganizationIds` /
// `getDisabledOrganizationIds`'s shape and no-try/catch stance.
describe("getGlobalFlagOverride (uncached global reader)", () => {
	beforeEach(() => {
		findUnique.mockReset();
	});

	// The property the whole reader exists for: two consecutive calls must
	// each see the CURRENT database state, with no TTL wait and no
	// cache-busting call (no setFlagOverride, no __resetFeatureFlagCacheForTest)
	// in between — unlike `isFeatureEnabled`, which would still be serving the
	// first value from its 10-second cache.
	it("re-reads the database on every call — no TTL, unlike isFeatureEnabled", async () => {
		findUnique.mockResolvedValueOnce({ enabled: true });
		await expect(getGlobalFlagOverride("PUBLISHING_SUITE")).resolves.toBe(
			true,
		);

		findUnique.mockResolvedValueOnce({ enabled: false });
		await expect(getGlobalFlagOverride("PUBLISHING_SUITE")).resolves.toBe(
			false,
		);

		expect(findUnique).toHaveBeenCalledTimes(2);
	});

	it("returns undefined when there is no override row — distinct from a stored false", async () => {
		findUnique.mockResolvedValueOnce(null);
		await expect(
			getGlobalFlagOverride("PUBLISHING_SUITE"),
		).resolves.toBeUndefined();
	});

	it("queries by key alone, selecting only enabled", async () => {
		findUnique.mockResolvedValueOnce(null);
		await getGlobalFlagOverride("PUBLISHING_SUITE");
		expect(findUnique).toHaveBeenCalledWith({
			where: { key: "PUBLISHING_SUITE" },
			select: { enabled: true },
		});
	});

	// Mirrors `getEnabledOrganizationIds` / `getDisabledOrganizationIds`: no
	// try/catch, so a read failure here must throw and let the calling
	// activity retry, rather than degrading to a default indistinguishable
	// from a real answer.
	it("throws rather than degrading, unlike getFlagOverrides' fail-open catch", async () => {
		findUnique.mockRejectedValueOnce(new Error("relation does not exist"));
		await expect(getGlobalFlagOverride("PUBLISHING_SUITE")).rejects.toThrow(
			"relation does not exist",
		);
	});
});

// Copilot-review follow-up: the per-project dispatch-time re-check
// (`isPublishingSuiteEnabledForOrganizationUncached`,
// packages/temporal/src/activities/publishing-suggestion/find-eligible-projects.ts)
// used to answer its one-organization question by fetching every override
// row for the key via `getEnabledOrganizationIds` / `getDisabledOrganizationIds`
// and scanning the list with `.includes()`. This reader answers the same
// question directly, against the table's `(key, organizationId)` primary
// key — mirroring `getGlobalFlagOverride`'s shape and no-try/catch stance.
describe("getOrganizationFlagOverrideUncached (uncached org reader)", () => {
	beforeEach(() => {
		findUniqueOrg.mockReset();
	});

	it("re-reads the database on every call — no TTL, unlike isFeatureEnabled", async () => {
		findUniqueOrg.mockResolvedValueOnce({ enabled: true });
		await expect(
			getOrganizationFlagOverrideUncached("PUBLISHING_SUITE", "org_1"),
		).resolves.toBe(true);

		findUniqueOrg.mockResolvedValueOnce({ enabled: false });
		await expect(
			getOrganizationFlagOverrideUncached("PUBLISHING_SUITE", "org_1"),
		).resolves.toBe(false);

		expect(findUniqueOrg).toHaveBeenCalledTimes(2);
	});

	it("returns undefined when there is no override row — distinct from a stored false", async () => {
		findUniqueOrg.mockResolvedValueOnce(null);
		await expect(
			getOrganizationFlagOverrideUncached("PUBLISHING_SUITE", "org_1"),
		).resolves.toBeUndefined();
	});

	it("queries by the compound (key, organizationId) primary key, selecting only enabled", async () => {
		findUniqueOrg.mockResolvedValueOnce(null);
		await getOrganizationFlagOverrideUncached("PUBLISHING_SUITE", "org_1");
		expect(findUniqueOrg).toHaveBeenCalledWith({
			where: {
				key_organizationId: {
					key: "PUBLISHING_SUITE",
					organizationId: "org_1",
				},
			},
			select: { enabled: true },
		});
	});

	// Mirrors `getGlobalFlagOverride` / `getEnabledOrganizationIds` /
	// `getDisabledOrganizationIds`: no try/catch, so a read failure here must
	// throw and let the calling activity retry, rather than degrading to a
	// default indistinguishable from a real answer.
	it("throws rather than degrading, unlike getFlagOverrides' fail-open catch", async () => {
		findUniqueOrg.mockRejectedValueOnce(
			new Error("relation does not exist"),
		);
		await expect(
			getOrganizationFlagOverrideUncached("PUBLISHING_SUITE", "org_1"),
		).rejects.toThrow("relation does not exist");
	});
});

describe("org-scoped flag reads", () => {
	beforeEach(() => {
		__resetFeatureFlagCacheForTest();
		findMany.mockReset();
		findManyOrg.mockReset();
	});

	it("prefers an org row over the global row", async () => {
		findMany.mockResolvedValue([
			{ key: "PUBLISHING_SUITE", enabled: false },
		]);
		findManyOrg.mockResolvedValue([
			{ key: "PUBLISHING_SUITE", enabled: true },
		]);

		await expect(
			isFeatureEnabled("PUBLISHING_SUITE", "org_1"),
		).resolves.toBe(true);
	});

	it("inherits the global value when the organization has no row", async () => {
		findMany.mockResolvedValue([
			{ key: "PUBLISHING_SUITE", enabled: true },
		]);
		findManyOrg.mockResolvedValue([]);

		await expect(
			isFeatureEnabled("PUBLISHING_SUITE", "org_1"),
		).resolves.toBe(true);
	});

	it("ignores rows for de-registered flag keys", async () => {
		findMany.mockResolvedValue([]);
		findManyOrg.mockResolvedValue([{ key: "GONE_FLAG", enabled: true }]);

		await expect(
			isFeatureEnabled("PUBLISHING_SUITE", "org_1"),
		).resolves.toBe(false);
	});

	// Precondition asserted, not assumed: the first call must actually have
	// populated the cache, or "org B did not see org A's value" passes
	// vacuously in a run where nothing was cached at all.
	it("caches per organization and never answers across organizations", async () => {
		findMany.mockResolvedValue([]);
		findManyOrg.mockImplementation(({ where }) =>
			Promise.resolve(
				where.organizationId === "org_1"
					? [{ key: "PUBLISHING_SUITE", enabled: true }]
					: [],
			),
		);

		await expect(
			isFeatureEnabled("PUBLISHING_SUITE", "org_1"),
		).resolves.toBe(true);
		const callsAfterFirst = findManyOrg.mock.calls.length;

		// Precondition: a repeat read for org_1 is served from cache.
		await expect(
			isFeatureEnabled("PUBLISHING_SUITE", "org_1"),
		).resolves.toBe(true);
		expect(findManyOrg.mock.calls.length).toBe(callsAfterFirst);

		// The actual property: org_2 is unaffected by org_1's cached true.
		await expect(
			isFeatureEnabled("PUBLISHING_SUITE", "org_2"),
		).resolves.toBe(false);
	});

	// Mirrors the global reader's contract exactly: degrade to "no overrides"
	// and do NOT cache the failure, so recovery is immediate rather than
	// delayed by a full TTL.
	it("degrades to no overrides on a read error and does not cache it", async () => {
		findMany.mockResolvedValue([]);
		findManyOrg.mockRejectedValueOnce(new Error("relation missing"));

		await expect(
			isFeatureEnabled("PUBLISHING_SUITE", "org_1"),
		).resolves.toBe(false);

		findManyOrg.mockResolvedValue([
			{ key: "PUBLISHING_SUITE", enabled: true },
		]);
		await expect(
			isFeatureEnabled("PUBLISHING_SUITE", "org_1"),
		).resolves.toBe(true);
	});

	// The bug this pins: a cache HIT used to return early without moving the
	// entry, so eviction removed the first key ever inserted regardless of
	// how recently it had been read. Reading org_0 again after some filler
	// organizations load must push it to the back of the eviction order —
	// same as a real refresh — so it survives when the cache is later
	// driven past ORG_CACHE_MAX, while an organization loaded around the
	// same time but never re-read does not.
	it("refreshes recency on a cache hit, so a re-read organization survives eviction", async () => {
		findMany.mockResolvedValue([]);
		findManyOrg.mockResolvedValue([
			{ key: "PUBLISHING_SUITE", enabled: true },
		]);

		const max = __ORG_CACHE_MAX_FOR_TEST;
		const fillerBeforeReread = 3;

		// org_0 loads first.
		await isFeatureEnabled("PUBLISHING_SUITE", "org_0");

		// A few other organizations load right after it, ahead of org_0 in
		// insertion order.
		for (let i = 1; i <= fillerBeforeReread; i++) {
			await isFeatureEnabled("PUBLISHING_SUITE", `org_${i}`);
		}

		// Re-reading org_0 is a cache hit (no new query) — with the fix it
		// moves to the back of the insertion order, past org_1..org_3.
		const callsBeforeReread = findManyOrg.mock.calls.length;
		await isFeatureEnabled("PUBLISHING_SUITE", "org_0");
		expect(findManyOrg.mock.calls.length).toBe(callsBeforeReread);

		// Fill the rest of the way to ORG_CACHE_MAX with untouched
		// organizations, then push one past the cap to force the first
		// eviction.
		for (let i = fillerBeforeReread + 1; i <= max - 1; i++) {
			await isFeatureEnabled("PUBLISHING_SUITE", `org_${i}`);
		}
		await isFeatureEnabled("PUBLISHING_SUITE", `org_${max}`);

		// org_0 was read recently (after org_1..org_3) — it must still be
		// cached and answer with no query.
		const callsBeforeOrg0Check = findManyOrg.mock.calls.length;
		await isFeatureEnabled("PUBLISHING_SUITE", "org_0");
		expect(findManyOrg.mock.calls.length).toBe(callsBeforeOrg0Check);

		// org_1 was loaded around the same time as org_0 but never re-read —
		// it is the true least-recently-used entry and must have been
		// evicted to make room, so reading it again issues a fresh query.
		const callsBeforeOrg1Check = findManyOrg.mock.calls.length;
		await isFeatureEnabled("PUBLISHING_SUITE", "org_1");
		expect(findManyOrg.mock.calls.length).toBe(callsBeforeOrg1Check + 1);
	});

	it("lists the organizations with an enabled row for a key", async () => {
		findManyOrg.mockResolvedValue([
			{ organizationId: "org_1" },
			{ organizationId: "org_2" },
		]);

		await expect(
			getEnabledOrganizationIds("PUBLISHING_SUITE"),
		).resolves.toEqual(["org_1", "org_2"]);
	});

	it("queries only enabled:true rows for the enabled list", async () => {
		findManyOrg.mockResolvedValue([]);

		await getEnabledOrganizationIds("PUBLISHING_SUITE");

		expect(findManyOrg).toHaveBeenCalledWith({
			where: { key: "PUBLISHING_SUITE", enabled: true },
			select: { organizationId: true },
		});
	});

	// Companion to the enabled list (fix round 1 / F2): the deny-list a
	// globally-enabled sweep consults to honour an organization's explicit
	// opt-out.
	it("lists the organizations with an explicitly disabled row for a key", async () => {
		findManyOrg.mockResolvedValue([{ organizationId: "org_bad" }]);

		await expect(
			getDisabledOrganizationIds("PUBLISHING_SUITE"),
		).resolves.toEqual(["org_bad"]);
	});

	it("queries only enabled:false rows for the disabled list", async () => {
		findManyOrg.mockResolvedValue([]);

		await getDisabledOrganizationIds("PUBLISHING_SUITE");

		expect(findManyOrg).toHaveBeenCalledWith({
			where: { key: "PUBLISHING_SUITE", enabled: false },
			select: { organizationId: true },
		});
	});
});

describe("getAllFlagsForOrganization", () => {
	beforeEach(() => {
		__resetFeatureFlagCacheForTest();
		findMany.mockReset();
		findManyOrg.mockReset();
	});

	it("an organization override beats the global override", async () => {
		// Global override says OFF for everyone; this organization says ON.
		findMany.mockResolvedValue([
			{ key: "PUBLISHING_SUITE", enabled: false },
		]);
		findManyOrg.mockResolvedValue([
			{ key: "PUBLISHING_SUITE", enabled: true },
		]);

		const flags = await getAllFlagsForOrganization("org-enrolled");

		expect(flags.PUBLISHING_SUITE).toBe(true);
	});

	it("an explicit organization `false` beats a global `true` (the kill switch)", async () => {
		findMany.mockResolvedValue([
			{ key: "PUBLISHING_SUITE", enabled: true },
		]);
		findManyOrg.mockResolvedValue([
			{ key: "PUBLISHING_SUITE", enabled: false },
		]);

		const flags = await getAllFlagsForOrganization("org-excluded");

		expect(flags.PUBLISHING_SUITE).toBe(false);
	});

	it("no organization row INHERITS the global value; it does not deny", async () => {
		// The distinction that carries the design: absent !== false. A resolver
		// that collapsed them would switch the feature off for every
		// organization the moment the global override was cleared.
		findMany.mockResolvedValue([
			{ key: "PUBLISHING_SUITE", enabled: true },
		]);
		findManyOrg.mockResolvedValue([]);

		const flags = await getAllFlagsForOrganization("org-no-row");

		expect(flags.PUBLISHING_SUITE).toBe(true);
	});

	it("returns a value for EVERY registry key, not only overridden ones", async () => {
		// The provider hands this straight to FeatureFlagProvider, whose
		// context type is Record<FeatureFlagKey, boolean>. A partial object
		// would make useFeatureFlag return undefined for an unlisted key,
		// which reads as `false` at every call site without ever throwing.
		findMany.mockResolvedValue([]);
		findManyOrg.mockResolvedValue([]);

		const flags = await getAllFlagsForOrganization("org-empty");

		for (const key of FEATURE_FLAG_KEYS) {
			expect(typeof flags[key]).toBe("boolean");
		}
	});

	it("resolves the same as getAllFlags when the organization has no rows", async () => {
		// Negative control with its precondition asserted: the org read must
		// actually have returned nothing, or this passes vacuously against a
		// resolver that ignores the organization entirely.
		findMany.mockResolvedValue([
			{ key: "PUBLISHING_SUITE", enabled: true },
		]);
		findManyOrg.mockResolvedValue([]);

		const orgOverrides = await getOrgFlagOverrides("org-no-row");
		expect(orgOverrides.size).toBe(0); // precondition

		expect(await getAllFlagsForOrganization("org-no-row")).toEqual(
			await getAllFlags(),
		);
	});
});
