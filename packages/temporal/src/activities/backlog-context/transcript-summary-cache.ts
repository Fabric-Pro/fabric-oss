import { CacheKeys, CacheTTL, RedisCache } from "../../lib/redis-cache";

const SUMMARY_CACHE_TIMEOUT_MS = 2_000;

/** Redis is optional. Bound waiting as well as errors so it cannot consume the analysis reserve. */
async function optionalCache<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve().then(fn),
			new Promise<T>((resolve) => {
				timer = setTimeout(
					() => resolve(fallback),
					SUMMARY_CACHE_TIMEOUT_MS,
				);
			}),
		]);
	} catch {
		return fallback;
	} finally {
		clearTimeout(timer);
	}
}

/** Fetch and analysis share successful summaries only within an organization and project. */
export async function readTranscriptSummary(
	transcript: string,
	targetChars: number,
	organizationId?: string,
	projectId?: string,
): Promise<string | null> {
	if (!organizationId || !projectId) {
		return null;
	}
	const key = CacheKeys.meetingTranscriptSummary(
		transcript,
		organizationId,
		projectId,
		targetChars,
	);
	const cached = await optionalCache(() => RedisCache.get<string>(key), null);
	return typeof cached === "string" && cached.trim() ? cached : null;
}

/** Call only after a successful summary; failed or empty results have no cache entry. */
export async function writeTranscriptSummary(
	transcript: string,
	targetChars: number,
	summary: string,
	organizationId?: string,
	projectId?: string,
): Promise<void> {
	if (!organizationId || !projectId || !summary.trim()) {
		return;
	}
	const key = CacheKeys.meetingTranscriptSummary(
		transcript,
		organizationId,
		projectId,
		targetChars,
	);
	await optionalCache(
		() => RedisCache.set(key, summary, CacheTTL.meetingTranscript),
		undefined,
	);
}
