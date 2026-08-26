/**
 * Opt-in, browser-local cache for personal meeting insights (#2104).
 *
 * PRIVACY CONTRACT — read before editing:
 * Only DERIVED insights (summary + action items) are ever stored. Transcript
 * text must never reach this module. Nothing here touches the server, so
 * #1899's FR7 no-persistence guarantee is unaffected and the user-facing
 * promise that "nothing is saved to our database" stays literally true. That
 * is the whole reason this feature is client-side rather than an encrypted
 * server cache; see
 * docs/superpowers/specs/2026-08-02-2104-personal-insights-caching-design.md.
 *
 * One blob per (userId, projectId) rather than one key per meeting: key
 * derivation must be synchronous to serve a hit during render, which rules out
 * SubtleCrypto, and a single object makes LRU, purge, and quota handling
 * trivially correct instead of a key sweep.
 *
 * The join URL is a meeting CAPABILITY URL and is never stored — entries are
 * keyed by a hash of it.
 */
import type { PersonalInsightItem } from "./types";

const KEY_PREFIX = "meeting-digest-personal-insights";

/**
 * Bump when `buildPersonalInsightsPrompt` or `PersonalInsightsSchema` changes.
 * Without this, a prompt improvement would silently never reach opted-in users,
 * who would keep being served summaries from the old prompt until the TTL.
 */
export const CACHE_VERSION = 1;

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 100;

export type CachedInsights = {
	summary: string;
	actionItems: PersonalInsightItem[];
};

type Entry = CachedInsights & { cachedAt: number };
type CacheBlob = { v: number; entries: Record<string, Entry> };

export function storageKey(userId: string, projectId: string): string {
	return `${KEY_PREFIX}:${userId}:${projectId}`;
}

/**
 * cyrb128 — a synchronous, non-cryptographic 128-bit hash.
 *
 * Not a security boundary. It exists so the capability URL is not sitting in
 * cleartext in storage, and so a 128-bit width makes a collision between two of
 * one user's own meetings a non-concern.
 *
 * The separator is a literal `|`; neither a Teams join URL nor an ISO-8601
 * timestamp can contain one, so the concatenation is unambiguous.
 */
export function entryId(joinUrl: string, startTime?: string): string {
	const str = `${joinUrl}|${startTime ?? ""}`;
	let h1 = 1779033703;
	let h2 = 3144134277;
	let h3 = 1013904242;
	let h4 = 2773480762;

	for (let i = 0; i < str.length; i++) {
		const k = str.charCodeAt(i);
		h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
		h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
		h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
		h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
	}

	h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
	h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
	h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
	h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);

	return [
		(h1 ^ h2 ^ h3 ^ h4) >>> 0,
		(h2 ^ h1) >>> 0,
		(h3 ^ h1) >>> 0,
		(h4 ^ h1) >>> 0,
	]
		.map((n) => n.toString(16).padStart(8, "0"))
		.join("");
}

/**
 * #2137 — stale data must leave the disk, not merely read as a miss. The TTL
 * and version checks exist to bound how long a personal summary can sit in
 * localStorage; returning null while keeping the bytes would defeat that.
 * Reads run during render, so the actual removal is deferred to a microtask.
 */
function sweepLater(sweep: () => void): void {
	queueMicrotask(() => {
		try {
			sweep();
		} catch {
			// Storage disabled — nothing on disk to sweep anyway.
		}
	});
}

function readBlob(key: string): CacheBlob | null {
	let raw: string | null;
	try {
		raw = localStorage.getItem(key);
	} catch {
		// Private browsing / storage disabled. Behave as a cold cache.
		return null;
	}
	if (!raw) {
		return null;
	}

	try {
		const parsed = JSON.parse(raw) as CacheBlob;
		// `typeof null === "object"` and so does an array, so both need ruling
		// out explicitly. A null `entries` used to pass this check and then
		// throw on property access — during render.
		if (
			parsed?.v !== CACHE_VERSION ||
			parsed.entries === null ||
			typeof parsed.entries !== "object" ||
			Array.isArray(parsed.entries)
		) {
			// A different cache version's summaries will never be read again —
			// delete them rather than letting them outlive their usefulness.
			sweepLater(() => localStorage.removeItem(key));
			return null;
		}
		return parsed;
	} catch {
		// Corrupt blob: a miss, not a throw. This runs during render.
		sweepLater(() => localStorage.removeItem(key));
		return null;
	}
}

function writeBlob(key: string, blob: CacheBlob): void {
	try {
		localStorage.setItem(key, JSON.stringify(blob));
	} catch {
		// Quota exceeded or storage disabled. Evict the oldest half and retry
		// once; if that still fails, give up silently. The cache is an
		// optimization — a failed write must never fail a summarise.
		const ids = Object.keys(blob.entries).sort(
			(a, b) => blob.entries[a].cachedAt - blob.entries[b].cachedAt,
		);
		for (const id of ids.slice(0, Math.ceil(ids.length / 2))) {
			delete blob.entries[id];
		}
		try {
			localStorage.setItem(key, JSON.stringify(blob));
		} catch {
			// Deliberately swallowed.
		}
	}
}

/**
 * An unidentified caller must never touch the cache.
 *
 * `userId` arrives from the session and is `""` until it loads. Without this
 * guard every such render shares one `…:​:projectId` bucket, so two people using
 * the same browser could read each other's summaries out of it — exactly the
 * leak that user-scoping the key exists to prevent. Failing closed costs a
 * cache miss; failing open costs the guarantee.
 */
function isCacheable(userId: string): boolean {
	return userId.length > 0;
}

export function readInsights(
	userId: string,
	projectId: string,
	joinUrl: string,
	startTime?: string,
): CachedInsights | null {
	if (!isCacheable(userId)) {
		return null;
	}
	const key = storageKey(userId, projectId);
	const blob = readBlob(key);
	const id = entryId(joinUrl, startTime);
	const entry = blob?.entries[id];
	if (!blob || !entry) {
		return null;
	}
	if (Date.now() - entry.cachedAt > TTL_MS) {
		// Expired: prune this entry from disk (#2137) — the TTL bounds how
		// long a summary may sit in storage, not just whether it renders.
		delete blob.entries[id];
		sweepLater(() => writeBlob(key, blob));
		return null;
	}
	return { summary: entry.summary, actionItems: entry.actionItems };
}

export function writeInsights(
	userId: string,
	projectId: string,
	joinUrl: string,
	startTime: string | undefined,
	value: CachedInsights,
): void {
	if (!isCacheable(userId)) {
		return;
	}
	const key = storageKey(userId, projectId);
	const blob = readBlob(key) ?? { v: CACHE_VERSION, entries: {} };

	blob.entries[entryId(joinUrl, startTime)] = {
		summary: value.summary,
		actionItems: value.actionItems,
		cachedAt: Date.now(),
	};

	const ids = Object.keys(blob.entries);
	if (ids.length > MAX_ENTRIES) {
		const oldest = ids
			.sort((a, b) => blob.entries[a].cachedAt - blob.entries[b].cachedAt)
			.slice(0, ids.length - MAX_ENTRIES);
		for (const id of oldest) {
			delete blob.entries[id];
		}
	}

	writeBlob(key, blob);
}

/**
 * Drop one meeting's cached entry, leaving the rest of the blob untouched.
 *
 * For a meeting that was cacheable when it was summarised and has since
 * become a shared, linked-without-transcript row: `readInsights` is never
 * called for it again once that happens (that is the whole point of the
 * `cacheActive` gate in `PersonalMeetingSheet`), so nothing else on the read
 * path would ever prune it — it would otherwise sit past its TTL until the
 * LRU cap evicts it or the user purges, contradicting #2137's promise that
 * stale data leaves the disk. The caller is expected to invoke this exactly
 * on that guarded-miss path.
 *
 * Deferred the same way the TTL prune in `readInsights` is (#2137): this can
 * be called from a render path, so the actual write is pushed to a
 * microtask rather than happening synchronously here.
 */
export function dropInsights(
	userId: string,
	projectId: string,
	joinUrl: string,
	startTime?: string,
): void {
	if (!isCacheable(userId)) {
		return;
	}
	const key = storageKey(userId, projectId);
	const blob = readBlob(key);
	const id = entryId(joinUrl, startTime);
	if (!blob || !(id in blob.entries)) {
		return;
	}
	delete blob.entries[id];
	sweepLater(() => writeBlob(key, blob));
}

/** Drop every cached insight for one project. Used when caching is turned off. */
export function purgeProject(userId: string, projectId: string): void {
	try {
		localStorage.removeItem(storageKey(userId, projectId));
	} catch {
		// Nothing to clean up if storage is unavailable.
	}
}

/**
 * Drop every cached insight for a user across all projects.
 *
 * Used on sign-out. Entries are user-keyed, so another Fabric account cannot
 * read them in-app — but anyone with devtools could. Erasing on sign-out is the
 * difference between "scoped" and "gone".
 */
export function purgeUser(userId: string): void {
	const prefix = `${KEY_PREFIX}:${userId}:`;
	try {
		// Collect first: calling removeItem while iterating by index reindexes
		// the store and would skip keys.
		const doomed: string[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key?.startsWith(prefix)) {
				doomed.push(key);
			}
		}
		for (const key of doomed) {
			localStorage.removeItem(key);
		}
	} catch {
		// Nothing to clean up if storage is unavailable.
	}
}
