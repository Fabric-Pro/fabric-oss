import { createHash } from "node:crypto";
import {
	getRegisteredAgentByAgentId,
	touchAgentCardCache,
	updateAgentCardCache,
	updateAgentEmbedding,
	updateRegisteredAgentHealthCheck,
} from "@repo/database";
import { generateEmbedding } from "@repo/rag/lib/embedding/generator";
import type { TenantContext } from "@repo/rag/lib/embedding/types";
import { resolveAgentUrl } from "../../lib/agent-url-resolver";
import { CacheKeys, CacheTTL, RedisCache } from "../../lib/redis-cache";

/**
 * Refresh gate for the stored agent card. Mirrors CacheTTL.agentCard (the
 * single source of truth) so the health probe, the Redis L1 cache and
 * agent-capabilities.ts's L2 DB read all agree on freshness.
 */
export const AGENT_CARD_REFRESH_TTL_MS = CacheTTL.agentCard * 1000;

/**
 * Upper bound on how long a stored embedding is trusted even when its source
 * hash still matches. The hash is the real change guard — this TTL only
 * catches anything the hash can't see (e.g. a manual metadata edit).
 */
export const AGENT_EMBEDDING_REFRESH_TTL_MS = 24 * 60 * 60_000; // 24 hours

export function formatProbeError(resolvedUrl: string, cause: string): string {
	return `${cause} probing ${resolvedUrl}/health`;
}

/**
 * Parse an ISO-8601 timestamp stored in agent metadata into epoch millis.
 * Returns null for anything that isn't a valid date string (undefined,
 * non-string, malformed) so callers can treat "unparseable" the same as
 * "never cached".
 */
function parseIsoMs(value: unknown): number | null {
	if (typeof value !== "string") {
		return null;
	}
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Recursively sort object keys so two structurally-equal JSON values compare
 * equal regardless of key order. Arrays keep their order (order is
 * meaningful there); primitives fall back to plain JSON.stringify.
 */
function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>).sort();
		const entries = keys.map(
			(key) =>
				`${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
		);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

export interface CheckAgentHealthInput {
	agentId: string;
	deploymentUrl: string;
	/** Tenant context for embedding generation — required to resolve the embedding model */
	userId?: string;
	organizationId?: string;
	/** Pre-built search text for embedding (name + description + skills + tags) */
	agentSearchText?: string;
}

export interface CheckAgentHealthOutput {
	agentId: string;
	healthy: boolean;
	responseTimeMs: number;
}

export async function checkAgentHealth(
	input: CheckAgentHealthInput,
): Promise<CheckAgentHealthOutput> {
	const startTime = Date.now();
	const resolvedUrl = resolveAgentUrl(input.agentId, input.deploymentUrl);
	let healthy = false;
	let healthError: string | undefined;

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		try {
			const response = await fetch(`${resolvedUrl}/health`, {
				signal: controller.signal,
			});
			healthy = response.ok;
			if (!healthy) {
				healthError = formatProbeError(
					resolvedUrl,
					`HTTP ${response.status}`,
				);
			}
		} finally {
			clearTimeout(timeout);
		}
	} catch (err) {
		healthy = false;
		const cause =
			err instanceof Error && err.name === "AbortError"
				? "timeout after 5000ms"
				: err instanceof Error
					? err.message
					: "probe failed";
		healthError = formatProbeError(resolvedUrl, cause);
	}

	const responseTimeMs = Date.now() - startTime;

	await updateRegisteredAgentHealthCheck(input.agentId, healthy, healthError);

	// When the agent is healthy, keep the agent card and description embedding
	// cached in the DB so getAgentCapabilities() / searchAvailableAgents() can
	// serve them from L2 without hitting the live agent or the embedding API.
	// Both are TTL-gated and change-guarded: the card is only re-fetched once
	// per AGENT_CARD_REFRESH_TTL_MS and only rewritten when its content
	// changed, and the embedding is only regenerated when the search text it
	// was built from changes (bounded by AGENT_EMBEDDING_REFRESH_TTL_MS).
	if (healthy) {
		let metadata: Record<string, unknown> = {};
		try {
			const stored = await getRegisteredAgentByAgentId(input.agentId);
			metadata =
				(stored?.metadata as Record<string, unknown> | null) ?? {};
		} catch (err) {
			console.warn(
				`[HealthMonitor] Failed to read stored metadata for ${input.agentId}, treating as empty:`,
				err,
			);
		}

		try {
			const cachedAtMs = parseIsoMs(metadata.agentCardCachedAt);
			const cardAgeMs =
				cachedAtMs === null ? null : Date.now() - cachedAtMs;
			// A negative age means a future timestamp (clock skew or a
			// hand-edited row) — that must not count as fresh.
			const cardIsFresh =
				metadata.agentCard !== undefined &&
				cardAgeMs !== null &&
				cardAgeMs >= 0 &&
				cardAgeMs < AGENT_CARD_REFRESH_TTL_MS;

			if (!cardIsFresh) {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 5000);

				let agentCardRaw: Record<string, unknown> | null = null;
				try {
					const cardResponse = await fetch(
						`${resolvedUrl}/.well-known/agent.json`,
						{ signal: controller.signal },
					);
					if (cardResponse.ok) {
						agentCardRaw = (await cardResponse.json()) as Record<
							string,
							unknown
						>;
					} else {
						console.warn(
							`[HealthMonitor] Agent card fetch returned ${cardResponse.status} for ${input.agentId}`,
						);
					}
				} finally {
					clearTimeout(timeout);
				}

				if (agentCardRaw) {
					const storedCard = metadata.agentCard;
					const unchanged =
						storedCard !== undefined &&
						stableStringify(agentCardRaw) ===
							stableStringify(storedCard);

					if (unchanged) {
						await touchAgentCardCache(input.agentId, new Date());
						RedisCache.set(
							CacheKeys.agentCard(input.agentId),
							agentCardRaw,
							CacheTTL.agentCard,
						).catch(() => {});
						console.log(
							`[HealthMonitor] Agent card unchanged for ${input.agentId}; advanced freshness stamp only`,
						);
					} else {
						await updateAgentCardCache(
							input.agentId,
							agentCardRaw,
							new Date(),
						);
						// Also cache in Redis for fast L1 reads by agent-capabilities.ts
						RedisCache.set(
							CacheKeys.agentCard(input.agentId),
							agentCardRaw,
							CacheTTL.agentCard,
						).catch(() => {});
						console.log(
							`[HealthMonitor] Refreshed agent card cache for ${input.agentId}`,
						);
					}
				}
			}
		} catch (err) {
			// Don't fail the health check if agent card refresh fails
			console.warn(
				`[HealthMonitor] Failed to refresh agent card cache for ${input.agentId}:`,
				err,
			);
		}

		// Compute and store description embedding if tenant context + search text
		// are provided. Regeneration is guarded by a hash of the search text: the
		// embedding is only recomputed when the text changed, or when the stored
		// hash is older than AGENT_EMBEDDING_REFRESH_TTL_MS.
		if (input.userId && input.agentSearchText) {
			try {
				const sourceHash = createHash("sha256")
					.update(input.agentSearchText)
					.digest("hex");
				const generatedAtMs = parseIsoMs(metadata.embeddingGeneratedAt);
				const embeddingAgeMs =
					generatedAtMs === null ? null : Date.now() - generatedAtMs;
				// A negative age means a future timestamp (clock skew or a
				// hand-edited row) — that must not count as fresh.
				const embeddingIsFresh =
					metadata.descriptionEmbedding !== undefined &&
					metadata.embeddingSourceHash === sourceHash &&
					embeddingAgeMs !== null &&
					embeddingAgeMs >= 0 &&
					embeddingAgeMs < AGENT_EMBEDDING_REFRESH_TTL_MS;

				if (!embeddingIsFresh) {
					const tenantContext: TenantContext = {
						userId: input.userId,
						organizationId: input.organizationId,
					};
					const result = await generateEmbedding(
						input.agentSearchText,
						tenantContext,
						undefined,
					);
					await updateAgentEmbedding(
						input.agentId,
						result.embedding,
						new Date(),
						result.model,
						sourceHash,
					);
					// Cache in Redis scoped to the model so callers using a different
					// embedding model won't get a cross-model cache hit.
					RedisCache.set(
						CacheKeys.agentEmbedding(input.agentId, result.model),
						result.embedding,
						CacheTTL.agentEmbedding,
					).catch(() => {});
					console.log(
						`[HealthMonitor] Refreshed description embedding for ${input.agentId} (model: ${result.model})`,
					);
				}
			} catch (err) {
				// Don't fail the health check if embedding generation fails
				console.warn(
					`[HealthMonitor] Failed to refresh description embedding for ${input.agentId}:`,
					err,
				);
			}
		}
	}

	return { agentId: input.agentId, healthy, responseTimeMs };
}
