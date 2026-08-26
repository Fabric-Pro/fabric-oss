/**
 * External API Usage Log queries
 *
 * Tracks per-key, per-agent usage for analytics and billing.
 */

import { db } from "../client";
import { Prisma } from "../generated/client";

export interface LogExternalApiUsageParams {
	apiKeyType: "USER" | "ORGANIZATION";
	apiKeyId: string;
	apiKeyPrefix: string;
	instanceId?: string;
	deploymentId?: string;
	userId: string;
	organizationId?: string;
	executionId?: string;
	endpoint: string;
	method: string;
	statusCode: number;
	latencyMs?: number;
	clientIp?: string;
	userAgent?: string;
}

/**
 * Log a single external API usage entry (fire-and-forget)
 */
export async function logExternalApiUsage(params: LogExternalApiUsageParams) {
	return db.externalApiUsageLog.create({
		data: {
			apiKeyType: params.apiKeyType,
			apiKeyId: params.apiKeyId,
			apiKeyPrefix: params.apiKeyPrefix,
			instanceId: params.instanceId ?? null,
			deploymentId: params.deploymentId ?? null,
			userId: params.userId,
			organizationId: params.organizationId ?? null,
			executionId: params.executionId ?? null,
			endpoint: params.endpoint,
			method: params.method,
			statusCode: params.statusCode,
			latencyMs: params.latencyMs ?? null,
			clientIp: params.clientIp ?? null,
			userAgent: params.userAgent ?? null,
		},
	});
}

/**
 * Get usage summary for an API key within a time window
 */
export async function getApiKeyUsageSummary(
	apiKeyId: string,
	windowDays: number,
) {
	const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

	const [totalRequests, totalTokens] = await Promise.all([
		db.externalApiUsageLog.count({
			where: { apiKeyId, createdAt: { gte: since } },
		}),
		db.externalApiUsageLog.aggregate({
			where: { apiKeyId, createdAt: { gte: since } },
			_sum: { inputTokens: true, outputTokens: true },
		}),
	]);

	return {
		totalRequests,
		inputTokens: totalTokens._sum.inputTokens ?? 0,
		outputTokens: totalTokens._sum.outputTokens ?? 0,
		windowDays,
	};
}

/**
 * Get usage summary per agent instance for an API key
 */
export async function getApiKeyUsageByAgent(
	apiKeyId: string,
	windowDays: number,
) {
	const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

	return db.externalApiUsageLog.groupBy({
		by: ["instanceId"],
		where: {
			apiKeyId,
			createdAt: { gte: since },
			instanceId: { not: null },
		},
		_count: { id: true },
		_sum: { inputTokens: true, outputTokens: true },
		orderBy: { _count: { id: "desc" } },
	});
}

/**
 * Update token usage on an existing log entry (after execution completes)
 */
export async function updateExternalApiUsageTokens(
	logId: string,
	tokens: {
		inputTokens: number;
		outputTokens: number;
		estimatedCost?: number;
	},
) {
	return db.externalApiUsageLog.update({
		where: { id: logId },
		data: {
			inputTokens: tokens.inputTokens,
			outputTokens: tokens.outputTokens,
			estimatedCost: tokens.estimatedCost
				? new Prisma.Decimal(tokens.estimatedCost)
				: null,
		},
	});
}
