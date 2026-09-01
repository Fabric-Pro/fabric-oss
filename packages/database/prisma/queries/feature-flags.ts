import { logger } from "@repo/logs";
import {
	FEATURE_FLAG_KEYS,
	type FeatureFlagKey,
	type FlagSource,
	isFeatureFlagKey,
	resolveFlag,
} from "@repo/utils/feature-flag-registry";
import { db } from "../client";

/**
 * DB-backed feature-flag reads.
 *
 * Cached with a short TTL because these run inside hot procedure handlers: an
 * uncached read would add a round-trip to every gated request. The cost is that
 * a flip takes up to TTL_MS to propagate, and propagates per process
 * independently. That is acceptable for admin-toggled flags and strictly better
 * than the redeploy this replaces. `setFlagOverride` busts the local cache
 * immediately so the admin who flipped it sees the change at once.
 */
const TTL_MS = 10_000;

let cache: { at: number; overrides: Map<FeatureFlagKey, boolean> } | null =
	null;

/** Test seam — cache is module-level, so tests must be able to clear it. */
export function __resetFeatureFlagCacheForTest(): void {
	cache = null;
}

/**
 * Overrides plus whether the read actually succeeded.
 *
 * `degraded` exists because "no override row" and "we could not look" are
 * different facts that the Map alone cannot distinguish, and for a kill switch
 * the difference decides whether an unattended write proceeds. Every existing
 * caller keeps the old lenient behaviour through {@link getFlagOverrides}.
 */
export async function getFlagOverridesDetailed(): Promise<{
	overrides: Map<FeatureFlagKey, boolean>;
	degraded: boolean;
}> {
	if (cache && Date.now() - cache.at < TTL_MS) {
		return { overrides: cache.overrides, degraded: false };
	}

	let rows: Array<{ key: string; enabled: boolean }>;
	try {
		rows = await db.featureFlagOverride.findMany({
			select: { key: true, enabled: true },
		});
	} catch (err) {
		// The override table can be unreadable (migration not applied, DB
		// outage, etc). This read runs inside the authenticated layout and
		// two Meeting Digest procedures, so a throw here takes down every
		// authenticated page. Degrade instead: return "no overrides", which
		// sends every flag through `resolveFlag` to its env/registry value.
		//
		// The fail direction is per-flag, not uniformly safe. For a default-OFF
		// flag this can only turn it off. For a default-ON one it resolves back
		// ON, so an admin's OFF is not durable against a fault in this table
		// specifically — accepted, and recorded in each such flag's `note`.
		// Three flags default ON today (UNIFIED_AGENT_INTERFACE,
		// NEWSLETTER_APPROVAL_CHAT, PUBLISHING_INBOX); read the registry rather
		// than trusting this count, which is the sort of thing that goes stale.
		//
		// Deliberately NOT cached: caching this empty Map would pin every
		// flag to its fallback value for the rest of the TTL even after the
		// DB recovers. Leaving `cache` untouched means the very next call
		// retries the read, so recovery is immediate rather than delayed.
		// Do not "optimize" this by writing `cache = { at: Date.now(),
		// overrides: new Map() }` here.
		logger.error(
			{
				event: "feature_flags.override_read_failed",
				err: {
					message: err instanceof Error ? err.message : String(err),
					name: err instanceof Error ? err.name : "UnknownError",
				},
			},
			"Feature flag override read failed; falling back to env/registry defaults for all flags",
		);
		return {
			overrides: new Map<FeatureFlagKey, boolean>(),
			degraded: true,
		};
	}

	const overrides = new Map<FeatureFlagKey, boolean>();
	for (const row of rows) {
		// A row for a de-registered flag is ignored rather than throwing: the
		// registry is the authority on what exists, and a stale row must never
		// be able to break every read.
		if (isFeatureFlagKey(row.key)) {
			overrides.set(row.key, row.enabled);
		}
	}

	cache = { at: Date.now(), overrides };
	return { overrides, degraded: false };
}

/**
 * The lenient reader every existing caller uses: a failed override read
 * degrades to env/registry values rather than throwing.
 */
export async function getFlagOverrides(): Promise<
	Map<FeatureFlagKey, boolean>
> {
	return (await getFlagOverridesDetailed()).overrides;
}

export async function getAllFlagsDetailed(): Promise<
	Array<{ key: FeatureFlagKey; enabled: boolean; source: FlagSource }>
> {
	const overrides = await getFlagOverrides();
	return FEATURE_FLAG_KEYS.map((key) => ({
		key,
		...resolveFlag(key, overrides.get(key), process.env),
	}));
}

export async function getAllFlags(): Promise<Record<FeatureFlagKey, boolean>> {
	const detailed = await getAllFlagsDetailed();
	return Object.fromEntries(
		detailed.map((f) => [f.key, f.enabled]),
	) as Record<FeatureFlagKey, boolean>;
}

export async function isFeatureEnabled(key: FeatureFlagKey): Promise<boolean> {
	const overrides = await getFlagOverrides();
	return resolveFlag(key, overrides.get(key), process.env).enabled;
}

/**
 * Fail-CLOSED read, for a flag whose job is to stop something.
 *
 * {@link isFeatureEnabled} degrades an unreadable override table to the env
 * value, which is right for a rollout gate — a fault should not blank the
 * product. It is wrong for a kill switch: the env var for one is typically
 * `true` in every environment precisely because the switch is the brake, so an
 * administrator's OFF would evaporate on exactly the kind of database fault
 * during which someone is most likely to be pulling it.
 *
 * Here an unreadable override table resolves to DISABLED. The cost of being
 * wrong is a sweep that stands down for a tick; the cost the other way is an
 * unattended rewrite of a customer's document that an operator believed they
 * had already stopped.
 */
export async function isKillSwitchArmed(key: FeatureFlagKey): Promise<boolean> {
	const { overrides, degraded } = await getFlagOverridesDetailed();
	if (degraded) {
		return false;
	}
	return resolveFlag(key, overrides.get(key), process.env).enabled;
}

export async function setFlagOverride(input: {
	key: FeatureFlagKey;
	enabled: boolean;
	updatedBy: string;
}): Promise<void> {
	await db.featureFlagOverride.upsert({
		where: { key: input.key },
		create: {
			key: input.key,
			enabled: input.enabled,
			updatedBy: input.updatedBy,
		},
		update: { enabled: input.enabled, updatedBy: input.updatedBy },
	});
	cache = null;
}

/**
 * Delete a flag's override row, returning it to its env/registry-resolved
 * value (source "env" or "default").
 *
 * Uses `deleteMany` rather than `delete` so it is idempotent: clearing a flag
 * that has no override row is a no-op (count 0), not a P2025. Errors are NOT
 * swallowed — like `setFlagOverride`, a failed write must reject so the admin
 * console surfaces it rather than silently reporting success. Busts the cache
 * so the admin who cleared it sees the resolved value immediately.
 */
export async function clearFlagOverride(key: FeatureFlagKey): Promise<void> {
	await db.featureFlagOverride.deleteMany({ where: { key } });
	cache = null;
}
