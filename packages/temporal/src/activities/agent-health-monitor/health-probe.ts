import {
	updateAgentCardCache,
	updateAgentEmbedding,
	updateRegisteredAgentHealthCheck,
} from "@repo/database";
import { generateEmbedding } from "@repo/rag/lib/embedding/generator";
import type { TenantContext } from "@repo/rag/lib/embedding/types";
import { resolveAgentUrl } from "../../lib/agent-url-resolver";
import { CacheKeys, CacheTTL, RedisCache } from "../../lib/redis-cache";

export function formatProbeError(resolvedUrl: string, cause: string): string {
	return `${cause} probing ${resolvedUrl}/health`;
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

	// When the agent is healthy, proactively refresh the agent card cache in the
	// DB so getAgentCapabilities() can serve it from L2 without hitting the live
	// agent on the next orchestrator call.
	if (healthy) {
		try {
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
		} catch (err) {
			// Don't fail the health check if agent card refresh fails
			console.warn(
				`[HealthMonitor] Failed to refresh agent card cache for ${input.agentId}:`,
				err,
			);
		}

		// Compute and store description embedding if tenant context + search text
		// are provided. This keeps embeddings fresh every health-check cycle so
		// searchAvailableAgents() can serve them from the DB cache.
		if (input.userId && input.agentSearchText) {
			try {
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
