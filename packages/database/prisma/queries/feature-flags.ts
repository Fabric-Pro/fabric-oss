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

/**
 * Per-organization override cache, same TTL as the global one so both levels
 * propagate on one clock.
 *
 * BOUNDED on purpose. The global cache is a single slot; this one is keyed by
 * organization id, which on a large instance is an unbounded Map in a
 * long-lived process. The cap is a memory bound, not a correctness one —
 * eviction only costs a re-read.
 */
const ORG_CACHE_MAX = 500;

/** Test seam — lets a test drive the cache past its cap without hardcoding it. */
export const __ORG_CACHE_MAX_FOR_TEST = ORG_CACHE_MAX;

const orgCache = new Map<
	string,
	{ at: number; overrides: Map<FeatureFlagKey, boolean> }
>();

/** Test seam — caches are module-level, so tests must be able to clear them. */
export function __resetFeatureFlagCacheForTest(): void {
	cache = null;
	orgCache.clear();
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
		...resolveFlag(key, { global: overrides.get(key) }, process.env),
	}));
}

export async function getAllFlags(): Promise<Record<FeatureFlagKey, boolean>> {
	const detailed = await getAllFlagsDetailed();
	return Object.fromEntries(
		detailed.map((f) => [f.key, f.enabled]),
	) as Record<FeatureFlagKey, boolean>;
}

export async function getOrgFlagOverrides(
	organizationId: string,
): Promise<Map<FeatureFlagKey, boolean>> {
	const hit = orgCache.get(organizationId);
	if (hit && Date.now() - hit.at < TTL_MS) {
		// Delete-then-set moves this entry to the back of the insertion order
		// on every HIT, not just on refresh, so eviction below stays
		// least-recently-USED. Without this, a heavily-read organization
		// loaded once early can still be evicted while an organization
		// nobody has touched since its later load survives.
		orgCache.delete(organizationId);
		orgCache.set(organizationId, hit);
		return hit.overrides;
	}

	let rows: Array<{ key: string; enabled: boolean }>;
	try {
		rows = await db.organizationFeatureFlagOverride.findMany({
			where: { organizationId },
			select: { key: true, enabled: true },
		});
	} catch (err) {
		// Same contract as getFlagOverrides: degrade to "no org overrides",
		// which sends the flag to its global/env/default value. Deliberately
		// NOT cached — caching this empty Map would pin the organization to
		// its fallback for the rest of the TTL even after the DB recovers.
		//
		// For PUBLISHING_SUITE the fail direction is safe: default false and,
		// in production, no env var and no global override, so an unreadable
		// table resolves it OFF for everyone rather than on.
		logger.error(
			{
				event: "feature_flags.org_override_read_failed",
				organizationId,
				err: {
					message: err instanceof Error ? err.message : String(err),
					name: err instanceof Error ? err.name : "UnknownError",
				},
			},
			"Org feature flag override read failed; falling back to global/env/registry values",
		);
		return new Map<FeatureFlagKey, boolean>();
	}

	const overrides = new Map<FeatureFlagKey, boolean>();
	for (const row of rows) {
		// A row for a de-registered flag is ignored rather than throwing —
		// the registry is the authority on what exists.
		if (isFeatureFlagKey(row.key)) {
			overrides.set(row.key, row.enabled);
		}
	}

	// Delete before set so a freshly-fetched entry moves to the back of the
	// insertion order too — same least-recently-USED contract as the
	// cache-hit path above, not least-recently-refreshed.
	orgCache.delete(organizationId);
	if (orgCache.size >= ORG_CACHE_MAX) {
		const oldest = orgCache.keys().next().value;
		if (oldest !== undefined) {
			orgCache.delete(oldest);
		}
	}
	orgCache.set(organizationId, { at: Date.now(), overrides });
	return overrides;
}

export async function isFeatureEnabled(
	key: FeatureFlagKey,
	organizationId?: string,
): Promise<boolean> {
	const globalOverrides = await getFlagOverrides();
	const org = organizationId
		? (await getOrgFlagOverrides(organizationId)).get(key)
		: undefined;

	return resolveFlag(
		key,
		{ org, global: globalOverrides.get(key) },
		process.env,
	).enabled;
}

/**
 * Organization ids with an ENABLED override row for `key`.
 *
 * Uncached and deliberately so: its only caller is the daily suggestion sweep,
 * which runs once per tick and must not act on a stale allowlist — an
 * organization removed from the list should stop being swept on the next tick,
 * not up to a TTL later. Rows with `enabled: false` are excluded, so this
 * answers "who is switched on", never "who has a row".
 */
export async function getEnabledOrganizationIds(
	key: FeatureFlagKey,
): Promise<string[]> {
	const rows = await db.organizationFeatureFlagOverride.findMany({
		where: { key, enabled: true },
		select: { organizationId: true },
	});
	return rows.map((row) => row.organizationId);
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
	return resolveFlag(key, { global: overrides.get(key) }, process.env)
		.enabled;
}

/**
 * Organization ids with an explicitly DISABLED override row for `key`.
 *
 * The companion exclusion list to `getEnabledOrganizationIds`, for a flag
 * resolved globally-on: an override row is a boolean VALUE rather than a bare
 * membership entry precisely so an organization can opt OUT of a
 * globally-enabled feature, and the daily publishing sweep is the one path
 * where ignoring that would spend money. An organization with NO row at all
 * is unaffected (it inherits the global value) — only an explicit
 * `enabled: false` row lands here.
 *
 * Uncached for the same reason as `getEnabledOrganizationIds`: a
 * re-enrolled organization must resume being swept on the very next tick,
 * not up to a TTL later. Deliberately has NO try/catch — a read failure here
 * must throw so the calling activity retries and the sweep fails closed,
 * rather than degrading to "nobody is disabled" and silently spending on an
 * organization that asked to be excluded.
 */
export async function getDisabledOrganizationIds(
	key: FeatureFlagKey,
): Promise<string[]> {
	const rows = await db.organizationFeatureFlagOverride.findMany({
		where: { key, enabled: false },
		select: { organizationId: true },
	});
	return rows.map((row) => row.organizationId);
}

/**
 * The single ORGANIZATION override row for `key` and `organizationId`, read
 * directly from the database with no cache. `undefined` means "no row"
 * (falls through to the global/env/registry chain), distinct from a stored
 * `false` — the same contract as {@link getGlobalFlagOverride}.
 *
 * The table's primary key is `(key, organizationId)`, so this answers the
 * direct question — is there an override row for THIS key and THIS
 * organization, and what does it say — with a single indexed `findUnique`,
 * not a scan of every organization with an override for the key. Its only
 * caller is `isPublishingSuiteEnabledForOrganizationUncached` in
 * `packages/temporal/src/activities/publishing-suggestion/find-eligible-projects.ts`,
 * the per-project dispatch-time re-check that runs once per dispatched
 * project, immediately before that project triggers an LLM generation.
 *
 * `getEnabledOrganizationIds` / `getDisabledOrganizationIds` stay exactly as
 * they are for `findEligibleProjects`'s sweep, which genuinely needs the
 * full set of overridden organizations once per tick; this reader answers
 * the complementary one-row question a single already-known project asks.
 *
 * Uncached for the same reason as `getGlobalFlagOverride`,
 * `getEnabledOrganizationIds` and `getDisabledOrganizationIds`: a
 * re-enrolled or newly-disabled organization must be reflected on the very
 * next dispatch, not up to a TTL later. Deliberately has NO try/catch — a
 * read failure here must throw so the calling activity retries and the
 * dispatch fails closed, rather than degrading to a default value that
 * would be indistinguishable from a real answer.
 */
export async function getOrganizationFlagOverrideUncached(
	key: FeatureFlagKey,
	organizationId: string,
): Promise<boolean | undefined> {
	const row = await db.organizationFeatureFlagOverride.findUnique({
		where: { key_organizationId: { key, organizationId } },
		select: { enabled: true },
	});
	return row?.enabled;
}

/**
 * The GLOBAL override row for `key`, read directly from the database with no
 * cache. `undefined` means "no row" (falls through to env/registry), distinct
 * from a stored `false`.
 *
 * `isFeatureEnabled` / `getFlagOverrides` are cached with a 10-second TTL,
 * which is correct for the hot request paths they serve — an admin's flip
 * propagates per-process within the TTL, which is fine for a page load. It is
 * WRONG for the Publishing Suite's two credit-spending decisions: the daily
 * sweep's global resolution, made ONCE PER TICK — not per project — before
 * the per-project loop even starts, deciding whether to spend on every
 * active project, in
 * `packages/temporal/src/activities/publishing-suggestion/find-eligible-projects.ts`;
 * and the per-project dispatch-time re-check added by Codex fix round 2
 * (§E), which lives in `dispatch-suggestion.ts` and runs immediately before
 * a generation workflow actually starts — it calls a helper EXPORTED from
 * that same find-eligible-projects.ts
 * (`isPublishingSuiteEnabledForOrganizationUncached`). Both funnel through
 * find-eligible-projects.ts's private `resolvePublishingSuiteGlobalUncached`,
 * so a worker holding a stale cached `true` for up to 10 seconds after an
 * admin globally disables the flag cannot make either decision on the old
 * value — exactly the cost both gates exist to avoid. This reader exists so
 * that decision can be made fresh, mirroring `getEnabledOrganizationIds` /
 * `getDisabledOrganizationIds`, its siblings in THIS file
 * (`feature-flags.ts`), which are uncached for the identical reason.
 *
 * Deliberately has NO try/catch, mirroring `getEnabledOrganizationIds` /
 * `getDisabledOrganizationIds`: a read failure here must throw so the calling
 * activity retries and the sweep fails closed, rather than degrading to a
 * default value that would be indistinguishable from a real answer.
 *
 * `isFeatureEnabled` itself is left untouched — this is an ADDITIONAL reader
 * for callers that need no cache, not a replacement for the cached path
 * every hot-request-path caller correctly relies on.
 */
export async function getGlobalFlagOverride(
	key: FeatureFlagKey,
): Promise<boolean | undefined> {
	const row = await db.featureFlagOverride.findUnique({
		where: { key },
		select: { enabled: true },
	});
	return row?.enabled;
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
