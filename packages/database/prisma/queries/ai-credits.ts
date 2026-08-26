import { db, Prisma } from "../client";
import type {
	AIProvider,
	AiTaskType,
	AiUsageBillingCategory,
} from "../generated/client";

export const FREE_AI_CREDIT_LIMIT_USD = 5;

// Do NOT construct this at module load. `Prisma` is re-exported from `../client`
// off the CJS generated client; in the Turbopack production bundle the
// `@repo/database` barrel can evaluate this module before that binding is
// initialized, throwing `ReferenceError: Prisma is not defined` during Next's
// page-data collection (masked for weeks by turbo build-cache hits until an
// unrelated dependency change busted @repo/web's cache). Build it lazily so the
// `Prisma` value is only read at call time, after all modules have initialized.
let freeAiCreditLimitDecimalMemo: Prisma.Decimal | undefined;
const freeAiCreditLimitDecimal = (): Prisma.Decimal => {
	if (!freeAiCreditLimitDecimalMemo) {
		freeAiCreditLimitDecimalMemo = new Prisma.Decimal(
			FREE_AI_CREDIT_LIMIT_USD.toFixed(6),
		);
	}
	return freeAiCreditLimitDecimalMemo;
};

type TenantCreditParams =
	| { organizationId: string; userId?: string }
	| { userId: string; organizationId?: null | undefined };

export interface AiCreditStatus {
	usedCreditUsd: number;
	remainingCreditUsd: number;
	creditLimitUsd: number;
	isLimitReached: boolean;
}

export interface AiUsageCostEstimate {
	userId?: string;
	organizationId?: string;
	provider: AIProvider;
	providerModelId: string;
	modelCanonicalName?: string;
	taskType?: AiTaskType;
	inputTokens: number;
	outputTokens: number;
	/** Prompt tokens served from cache (a read). Priced below the input rate. */
	cachedInputTokens?: number;
	/** Prompt tokens written into the cache. Priced above the input rate (Anthropic). */
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

function normalizeUsd(value: Prisma.Decimal | number | string): number {
	return Number(new Prisma.Decimal(value).toFixed(6));
}

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
 * Prompt-cache accounting differs by model family, so pricing must too:
 *  - Anthropic (Claude), called direct or via Bedrock/Vertex: `inputTokens`
 *    EXCLUDES cache reads/writes — they are reported separately. Cache reads
 *    bill at ~0.1x the input rate, cache writes at ~1.25x. So both are ADDED
 *    on top of the plain input cost.
 *  - Anthropic (Claude) served through Databricks' Foundation Model API: same
 *    0.1x/1.25x Anthropic cache multipliers, but Databricks fronts it with an
 *    OpenAI-compatible surface and reports `prompt_tokens` INCLUSIVE of BOTH
 *    the cache-read AND the cache-write portion (live evidence: a
 *    cache-write call reported `prompt_tokens: 4573` = 4570
 *    `cache_creation_input_tokens` + 3 uncached — see
 *    `normalizeDatabricksUsageFields` in `databricks-compat.ts`), unlike
 *    Anthropic's own API, which reports both separately from `inputTokens`.
 *    Charging this like the direct-Anthropic branch (`inputTokens` assumed
 *    fully exclusive, both reads AND writes added on top) would double-count
 *    both: a cache HIT would cost MORE than an uncached call, and a
 *    cache-WRITE call would bill its write tokens at input-rate PLUS 1.25x
 *    (2.25x total) instead of 1.25x. Must be tested before the
 *    direct-Anthropic branch below, which would otherwise match on "claude"
 *    first.
 *  - OpenAI / Gemini: `inputTokens` INCLUDES cache reads; there is no separate
 *    write charge. So the cached portion is DISCOUNTED within the input cost
 *    (OpenAI ~0.5x, Gemini ~0.25x), never added.
 *  - Unknown family: fall back to charging every input token at 1x (the prior
 *    behavior) — never guess an inclusivity convention we can't verify.
 * When a call reports no cache tokens (the overwhelming majority, and every
 * pre-caching call) every branch collapses to `input*rate + output*rate`, so
 * this is backward-compatible and only changes cached calls.
 */
type CacheAccounting = {
	/** true = inputTokens already includes cache reads (OpenAI/Gemini, Databricks). */
	readsIncludedInInput: boolean;
	/** true = inputTokens already includes cache writes (Databricks only). */
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
	// `data.provider` is the typed AIProvider enum value, populated identically
	// on both usage-logging paths (packages/ai's `metadata.provider` and the
	// same value threaded through the LangChain agent path's `ai_provider`) —
	// a reliable discriminator, unlike sniffing "databricks" out of the id
	// string (serving-endpoint names are user-defined aliases, same caveat as
	// documented on `isReasoningModelName`).
	if (
		data.provider === "DATABRICKS" &&
		(id.includes("claude") || id.includes("anthropic"))
	) {
		// Databricks-served Claude: Anthropic's cache multipliers, but BOTH
		// reads and writes are already inside inputTokens. See the docstring
		// above.
		return {
			readsIncludedInInput: true,
			writesIncludedInInput: true,
			readMultiplier: 0.1,
			writeMultiplier: 1.25,
		};
	}
	if (id.includes("claude") || id.includes("anthropic")) {
		// Anthropic: reads/writes reported separately, added at 0.1x/1.25x.
		return {
			readsIncludedInInput: false,
			writesIncludedInInput: false,
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
			readsIncludedInInput: true,
			writesIncludedInInput: false,
			readMultiplier: 0.5,
			writeMultiplier: 0,
		};
	}
	if (id.includes("gemini") || id.includes("google")) {
		// Gemini: reads part of inputTokens, discounted to 0.25x; no write charge.
		return {
			readsIncludedInInput: true,
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

	// Full-rate input = the portion neither read from nor written to cache. For
	// OpenAI/Gemini/Databricks the cached reads are part of inputTokens, so
	// subtract them out before applying the discount; for direct Anthropic they
	// are already excluded. Databricks additionally includes cache WRITES in
	// inputTokens (unlike every other branch, where writes are either reported
	// separately or don't exist) — subtract those out too, or a cache-write
	// call bills its write tokens at input-rate PLUS the write multiplier.
	let fullRateInput = accounting.readsIncludedInInput
		? Math.max(0, data.inputTokens - cachedReads)
		: data.inputTokens;
	if (accounting.writesIncludedInInput) {
		fullRateInput = Math.max(0, fullRateInput - cacheWrites);
	}

	const inputCostUsd =
		fullRateInput * inputRatePerToken +
		cachedReads * inputRatePerToken * accounting.readMultiplier +
		cacheWrites * inputRatePerToken * accounting.writeMultiplier;

	return Number((inputCostUsd + outputCostUsd).toFixed(6));
}

export async function incrementTenantAiCreditUsage(
	params: TenantCreditParams & { costUsd: number },
) {
	if (!(params.costUsd > 0)) {
		return null;
	}

	const costUsd = new Prisma.Decimal(params.costUsd.toFixed(6));

	if ("organizationId" in params && params.organizationId) {
		return db.aiCreditAccount.upsert({
			where: {
				organizationId: params.organizationId,
			},
			create: {
				organizationId: params.organizationId,
				userId: null,
				usedCreditUsd: costUsd,
			},
			update: {
				usedCreditUsd: {
					increment: costUsd,
				},
			},
		});
	}

	return db.aiCreditAccount.upsert({
		where: {
			userId: params.userId,
		},
		create: {
			userId: params.userId,
			organizationId: null,
			usedCreditUsd: costUsd,
		},
		update: {
			usedCreditUsd: {
				increment: costUsd,
			},
		},
	});
}

export async function getTenantAiCreditStatus(
	params: TenantCreditParams,
): Promise<AiCreditStatus> {
	const account =
		"organizationId" in params && params.organizationId
			? await db.aiCreditAccount.findUnique({
					where: {
						organizationId: params.organizationId,
					},
					select: {
						usedCreditUsd: true,
					},
				})
			: await db.aiCreditAccount.findUnique({
					where: {
						userId: params.userId,
					},
					select: {
						usedCreditUsd: true,
					},
				});

	const usedCreditUsd = normalizeUsd(account?.usedCreditUsd ?? 0);
	const remainingCreditUsd = Math.max(
		0,
		Number((FREE_AI_CREDIT_LIMIT_USD - usedCreditUsd).toFixed(6)),
	);

	return {
		usedCreditUsd,
		remainingCreditUsd,
		creditLimitUsd: FREE_AI_CREDIT_LIMIT_USD,
		isLimitReached: new Prisma.Decimal(usedCreditUsd.toFixed(6)).gte(
			freeAiCreditLimitDecimal(),
		),
	};
}

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
