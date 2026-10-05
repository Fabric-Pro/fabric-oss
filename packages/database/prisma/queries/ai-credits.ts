import { db } from "../client";
import type {
	AIProvider,
	AiTaskType,
	AiUsageBillingCategory,
} from "../generated/client";

type TenantCreditParams =
	| { organizationId: string; userId?: string }
	| { userId: string; organizationId?: null | undefined };

export interface AiUsageCostEstimate {
	userId?: string;
	organizationId?: string;
	provider: AIProvider;
	providerModelId: string;
	modelCanonicalName?: string;
	taskType?: AiTaskType;
	/** Total input tokens, INCLUDING any cache reads and writes below. */
	inputTokens: number;
	outputTokens: number;
	/** The part of inputTokens served from cache (a read). Priced below the input rate. */
	cachedInputTokens?: number;
	/** The part of inputTokens written into the cache. Priced above the input rate (Anthropic). */
	cacheCreationInputTokens?: number;
}

export interface AiUsageBreakdownSummary {
	totalCostUsd: number;
	totalRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalTokens: number;
}

export interface AiUsageBreakdownItem {
	label: string;
	value: string | null;
	requests: number;
	totalCostUsd: number;
	totalTokens: number;
}

export interface AiUsageByUserItem {
	userId: string;
	name: string | null;
	email: string | null;
	requests: number;
	totalCostUsd: number;
	totalTokens: number;
}

export interface RecentAiUsageItem {
	id: string;
	userId: string | null;
	userName: string | null;
	userEmail: string | null;
	provider: AIProvider;
	modelCanonicalName: string | null;
	providerModelId: string;
	taskType: AiTaskType | null;
	billingCategory: AiUsageBillingCategory | null;
	totalTokens: number;
	costUsd: number;
	createdAt: Date;
}

export interface TenantAiUsageBreakdown {
	periodDays: number;
	summary: {
		allTime: AiUsageBreakdownSummary;
		currentPeriod: AiUsageBreakdownSummary;
	};
	byModel: AiUsageBreakdownItem[];
	byProvider: AiUsageBreakdownItem[];
	byTaskType: AiUsageBreakdownItem[];
	byBillingCategory: AiUsageBreakdownItem[];
	byUser: AiUsageByUserItem[];
	recentUsage: RecentAiUsageItem[];
}

const pricingCache = new Map<
	string,
	Promise<{ inputCostPer1M: number; outputCostPer1M: number } | null>
>();

function createUsageSummary(data: {
	totalCostMicroUsd: number | null | undefined;
	totalRequests: number | null | undefined;
	totalInputTokens: number | null | undefined;
	totalOutputTokens: number | null | undefined;
	totalTokens: number | null | undefined;
}): AiUsageBreakdownSummary {
	return {
		totalCostUsd: Number(
			(((data.totalCostMicroUsd ?? 0) as number) / 1_000_000).toFixed(6),
		),
		totalRequests: data.totalRequests ?? 0,
		totalInputTokens: data.totalInputTokens ?? 0,
		totalOutputTokens: data.totalOutputTokens ?? 0,
		totalTokens: data.totalTokens ?? 0,
	};
}

function getPricingCacheKey(data: AiUsageCostEstimate): string {
	return [
		data.provider,
		data.providerModelId,
		data.modelCanonicalName ?? "",
	].join(":");
}

async function getAiUsagePricing(data: AiUsageCostEstimate) {
	const cacheKey = getPricingCacheKey(data);
	const cached = pricingCache.get(cacheKey);

	if (cached) {
		return cached;
	}

	const pending = (async () => {
		const providerMapping = await db.aiModelProviderMapping.findFirst({
			where: {
				provider: data.provider,
				providerModelId: data.providerModelId,
				isAvailable: true,
			},
			select: {
				inputCostPer1M: true,
				outputCostPer1M: true,
				model: {
					select: {
						inputCostPer1M: true,
						outputCostPer1M: true,
					},
				},
			},
		});

		if (providerMapping) {
			return {
				inputCostPer1M:
					providerMapping.inputCostPer1M ??
					providerMapping.model.inputCostPer1M ??
					0,
				outputCostPer1M:
					providerMapping.outputCostPer1M ??
					providerMapping.model.outputCostPer1M ??
					0,
			};
		}

		if (!data.modelCanonicalName) {
			return null;
		}

		const model = await db.aiModel.findUnique({
			where: {
				canonicalName: data.modelCanonicalName,
			},
			select: {
				inputCostPer1M: true,
				outputCostPer1M: true,
			},
		});

		if (!model) {
			return null;
		}

		return {
			inputCostPer1M: model.inputCostPer1M ?? 0,
			outputCostPer1M: model.outputCostPer1M ?? 0,
		};
	})();

	pricingCache.set(cacheKey, pending);
	return pending;
}

/**
 * Usage-row contract, shared by every writer (the AI SDK middleware in
 * `packages/ai/lib/usage-logging-middleware.ts` and the LangChain agent path
 * in `packages/agent-core/src/services/usage-logging.ts`): `inputTokens` is
 * the provider's TOTAL input, INCLUDING prompt-cache reads and writes, and
 * `cachedInputTokens` / `cacheCreationInputTokens` are breakdowns of it. AI
 * SDK 7 providers report `inputTokens.total = noCache + cacheRead +
 * cacheWrite`; `@langchain/anthropic` 1.5.x reports `usage_metadata.
 * input_tokens` the same way; Databricks-served Claude reports an inclusive
 * `prompt_tokens` (live evidence: 4573 = 4570 cache writes + 3 uncached).
 * LangChain native-Anthropic rows written between 2026-09-09 and this change
 * stored an exclusive `inputTokens`; they are not migrated. Their stored cost
 * was computed at write time and is unaffected.
 *
 * Every recognised family therefore subtracts its cache buckets out of
 * `inputTokens` before pricing the remainder at the full input rate, and
 * prices the buckets at the family's multipliers:
 *  - Anthropic (Claude), on any provider — direct, gateway, Bedrock/Vertex or
 *    Databricks: reads ~0.1x, writes ~1.25x.
 *  - OpenAI: reads ~0.5x; no write charge.
 *  - Gemini: reads ~0.25x; no write charge.
 *  - Unknown family: charge every input token at 1x — never guess a cache
 *    rate we can't verify.
 * When a call reports no cache tokens every branch collapses to
 * `input*rate + output*rate`.
 */
type CacheAccounting = {
	/**
	 * true = inputTokens already includes cache writes (Anthropic). Families
	 * without a write charge leave this false: a reported write count is then
	 * neither subtracted nor charged, so it stays at the full input rate.
	 */
	writesIncludedInInput: boolean;
	/** Multiplier applied to cache-read tokens, relative to the input rate. */
	readMultiplier: number;
	/** Multiplier applied to cache-creation (write) tokens (Anthropic only). */
	writeMultiplier: number;
};

function cacheAccountingForModel(
	data: AiUsageCostEstimate,
): CacheAccounting | null {
	const id =
		`${data.providerModelId} ${data.modelCanonicalName ?? ""}`.toLowerCase();
	if (id.includes("claude") || id.includes("anthropic")) {
		// Anthropic on every provider (Databricks-served Claude included): both
		// cache buckets are inside inputTokens; reads 0.1x, writes 1.25x.
		return {
			writesIncludedInInput: true,
			readMultiplier: 0.1,
			writeMultiplier: 1.25,
		};
	}
	if (
		id.includes("gpt") ||
		id.includes("openai") ||
		/(^|[^a-z])o[134]([^a-z]|$)/.test(id)
	) {
		// OpenAI: reads are part of inputTokens, discounted to 0.5x; no write charge.
		return {
			writesIncludedInInput: false,
			readMultiplier: 0.5,
			writeMultiplier: 0,
		};
	}
	if (id.includes("gemini") || id.includes("google")) {
		// Gemini: reads part of inputTokens, discounted to 0.25x; no write charge.
		return {
			writesIncludedInInput: false,
			readMultiplier: 0.25,
			writeMultiplier: 0,
		};
	}
	return null;
}

export async function estimateAiUsageCostUsd(
	data: AiUsageCostEstimate,
): Promise<number> {
	const pricing = await getAiUsagePricing(data);

	if (!pricing) {
		return 0;
	}

	const inputRatePerToken = pricing.inputCostPer1M / 1_000_000;
	const outputRatePerToken = pricing.outputCostPer1M / 1_000_000;
	const outputCostUsd = data.outputTokens * outputRatePerToken;

	const cachedReads = Math.max(0, data.cachedInputTokens ?? 0);
	const cacheWrites = Math.max(0, data.cacheCreationInputTokens ?? 0);
	const accounting =
		cachedReads > 0 || cacheWrites > 0
			? cacheAccountingForModel(data)
			: null;

	if (!accounting) {
		// No cache tokens, or an unrecognized family: charge every input token at 1x.
		const inputCostUsd = data.inputTokens * inputRatePerToken;
		return Number((inputCostUsd + outputCostUsd).toFixed(6));
	}

	// Full-rate input = the portion neither read from nor written to cache.
	// inputTokens is inclusive (see the contract above), so the cache buckets
	// are subtracted out before their multipliers apply — otherwise a cached
	// token bills at the input rate PLUS its multiplier.
	let fullRateInput = Math.max(0, data.inputTokens - cachedReads);
	if (accounting.writesIncludedInInput) {
		fullRateInput = Math.max(0, fullRateInput - cacheWrites);
	}

	const inputCostUsd =
		fullRateInput * inputRatePerToken +
		cachedReads * inputRatePerToken * accounting.readMultiplier +
		cacheWrites * inputRatePerToken * accounting.writeMultiplier;

	return Number((inputCostUsd + outputCostUsd).toFixed(6));
}

// The per-tenant credit ledger (`AiCreditAccount`) is no longer read from here.
//
// Nothing writes it either (Fizzy #1875): the accrual that incremented it after
// every usage record counted spend on a tenant's own provider key against a
// platform allowance that never funded it, and the allowance granted no access.
// With the credit-status procedure and the external balance route gone, the
// reader had no consumer left and went with them.
//
// The table and its rows are deliberately kept — see
// `docs/plans/2026-09-03-001-feat-byok-only-remove-trial-credit-plan.md` KTD3.
// They are history, and nothing in the product consults them.
//
// Usage reporting below is unaffected: it reads `AiUsageLog`, not this ledger.

export async function getTenantAiUsageBreakdown(
	params: TenantCreditParams & {
		periodDays?: number;
		recentUsageLimit?: number;
		topItemsLimit?: number;
	},
): Promise<TenantAiUsageBreakdown> {
	const periodDays = Math.max(1, params.periodDays ?? 30);
	const recentUsageLimit = Math.max(
		1,
		Math.min(params.recentUsageLimit ?? 10, 50),
	);
	const topItemsLimit = Math.max(1, Math.min(params.topItemsLimit ?? 5, 20));
	const periodStart = new Date();
	periodStart.setDate(periodStart.getDate() - periodDays);

	const tenantWhere =
		"organizationId" in params && params.organizationId
			? {
					organizationId: params.organizationId,
				}
			: {
					userId: params.userId,
					organizationId: null,
				};

	const periodWhere = {
		...tenantWhere,
		createdAt: {
			gte: periodStart,
		},
	};

	const [
		allTimeAggregate,
		periodAggregate,
		modelRows,
		providerRows,
		taskRows,
		billingRows,
		userRows,
		recentUsage,
	] = await Promise.all([
		db.aiUsageLog.aggregate({
			where: tenantWhere,
			_sum: {
				costMicroUsd: true,
				inputTokens: true,
				outputTokens: true,
				totalTokens: true,
			},
			_count: {
				id: true,
			},
		}),
		db.aiUsageLog.aggregate({
			where: periodWhere,
			_sum: {
				costMicroUsd: true,
				inputTokens: true,
				outputTokens: true,
				totalTokens: true,
			},
			_count: {
				id: true,
			},
		}),
		db.aiUsageLog.groupBy({
			by: ["modelCanonicalName", "providerModelId"],
			where: periodWhere,
			_sum: {
				costMicroUsd: true,
				totalTokens: true,
			},
			_count: {
				id: true,
			},
			orderBy: {
				_sum: {
					costMicroUsd: "desc",
				},
			},
			take: topItemsLimit,
		}),
		db.aiUsageLog.groupBy({
			by: ["provider"],
			where: periodWhere,
			_sum: {
				costMicroUsd: true,
				totalTokens: true,
			},
			_count: {
				id: true,
			},
			orderBy: {
				_sum: {
					costMicroUsd: "desc",
				},
			},
			take: topItemsLimit,
		}),
		db.aiUsageLog.groupBy({
			by: ["taskType"],
			where: periodWhere,
			_sum: {
				costMicroUsd: true,
				totalTokens: true,
			},
			_count: {
				id: true,
			},
			orderBy: {
				_sum: {
					costMicroUsd: "desc",
				},
			},
			take: topItemsLimit,
		}),
		db.aiUsageLog.groupBy({
			by: ["billingCategory"],
			where: {
				...periodWhere,
				success: true,
			},
			_sum: {
				costMicroUsd: true,
				totalTokens: true,
			},
			_count: {
				id: true,
			},
			orderBy: {
				_sum: {
					costMicroUsd: "desc",
				},
			},
		}),
		"organizationId" in params && params.organizationId
			? db.aiUsageLog.groupBy({
					by: ["userId"],
					where: periodWhere,
					_sum: {
						costMicroUsd: true,
						totalTokens: true,
					},
					_count: {
						id: true,
					},
					orderBy: {
						_sum: {
							costMicroUsd: "desc",
						},
					},
					take: topItemsLimit,
				})
			: Promise.resolve([]),
		db.aiUsageLog.findMany({
			where: periodWhere,
			orderBy: {
				createdAt: "desc",
			},
			take: recentUsageLimit,
			select: {
				id: true,
				userId: true,
				provider: true,
				modelCanonicalName: true,
				providerModelId: true,
				taskType: true,
				billingCategory: true,
				totalTokens: true,
				costMicroUsd: true,
				createdAt: true,
			},
		}),
	]);

	const usageUserIds = Array.from(
		new Set(
			[
				...userRows.map((row) => row.userId),
				...recentUsage.map((entry) => entry.userId),
			].filter((userId): userId is string => Boolean(userId)),
		),
	);

	const usersById =
		usageUserIds.length > 0
			? new Map(
					(
						await db.user.findMany({
							where: {
								id: {
									in: usageUserIds,
								},
							},
							select: {
								id: true,
								name: true,
								email: true,
							},
						})
					).map((user) => [user.id, user]),
				)
			: new Map();

	return {
		periodDays,
		summary: {
			allTime: createUsageSummary({
				totalCostMicroUsd: allTimeAggregate._sum.costMicroUsd,
				totalRequests: allTimeAggregate._count.id,
				totalInputTokens: allTimeAggregate._sum.inputTokens,
				totalOutputTokens: allTimeAggregate._sum.outputTokens,
				totalTokens: allTimeAggregate._sum.totalTokens,
			}),
			currentPeriod: createUsageSummary({
				totalCostMicroUsd: periodAggregate._sum.costMicroUsd,
				totalRequests: periodAggregate._count.id,
				totalInputTokens: periodAggregate._sum.inputTokens,
				totalOutputTokens: periodAggregate._sum.outputTokens,
				totalTokens: periodAggregate._sum.totalTokens,
			}),
		},
		byModel: modelRows.map((row) => ({
			label: row.modelCanonicalName ?? row.providerModelId,
			value: row.providerModelId,
			requests: row._count.id,
			totalCostUsd: Number(
				(((row._sum.costMicroUsd ?? 0) as number) / 1_000_000).toFixed(
					6,
				),
			),
			totalTokens: row._sum.totalTokens ?? 0,
		})),
		byProvider: providerRows.map((row) => ({
			label: row.provider,
			value: null,
			requests: row._count.id,
			totalCostUsd: Number(
				(((row._sum.costMicroUsd ?? 0) as number) / 1_000_000).toFixed(
					6,
				),
			),
			totalTokens: row._sum.totalTokens ?? 0,
		})),
		byTaskType: taskRows.map((row) => ({
			label: row.taskType ?? "Unspecified",
			value: null,
			requests: row._count.id,
			totalCostUsd: Number(
				(((row._sum.costMicroUsd ?? 0) as number) / 1_000_000).toFixed(
					6,
				),
			),
			totalTokens: row._sum.totalTokens ?? 0,
		})),
		byBillingCategory: billingRows.map((row) => ({
			label: row.billingCategory ?? "UNCLASSIFIED",
			value: null,
			requests: row._count.id,
			totalCostUsd: Number(
				(((row._sum.costMicroUsd ?? 0) as number) / 1_000_000).toFixed(
					6,
				),
			),
			totalTokens: row._sum.totalTokens ?? 0,
		})),
		byUser: userRows
			.filter((row) => row.userId)
			.map((row) => ({
				userId: row.userId as string,
				name: usersById.get(row.userId as string)?.name ?? null,
				email: usersById.get(row.userId as string)?.email ?? null,
				requests: row._count.id,
				totalCostUsd: Number(
					(
						((row._sum.costMicroUsd ?? 0) as number) / 1_000_000
					).toFixed(6),
				),
				totalTokens: row._sum.totalTokens ?? 0,
			})),
		recentUsage: recentUsage.map((entry) => ({
			id: entry.id,
			userId: entry.userId ?? null,
			userName: entry.userId
				? (usersById.get(entry.userId)?.name ?? null)
				: null,
			userEmail: entry.userId
				? (usersById.get(entry.userId)?.email ?? null)
				: null,
			provider: entry.provider,
			modelCanonicalName: entry.modelCanonicalName,
			providerModelId: entry.providerModelId,
			taskType: entry.taskType ?? null,
			billingCategory: entry.billingCategory ?? null,
			totalTokens: entry.totalTokens,
			costUsd: Number(((entry.costMicroUsd ?? 0) / 1_000_000).toFixed(6)),
			createdAt: entry.createdAt,
		})),
	};
}
