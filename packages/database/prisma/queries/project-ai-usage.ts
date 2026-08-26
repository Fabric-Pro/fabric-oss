import { db, Prisma } from "../client";
import type {
	AIProvider,
	AiTaskType,
	AiUsageBillingCategory,
} from "../generated/client";
import { AiUsageBillingCategorySchema } from "../zod";

export type UsageRange = "7d" | "30d" | "90d" | "all";
export type UsageBucket = "day" | "week";
export type UsageGroupBy =
	| "model"
	| "provider"
	| "taskType"
	| "agentId"
	| "billingCategory";

// Derive bucket keys from the Prisma enum so a new enum value doesn't get
// silently mapped to "UNKNOWN".
const BILLING_BUCKETS = [
	...AiUsageBillingCategorySchema.options,
	"UNKNOWN",
] as const;
type BillingBucketKey = (typeof BILLING_BUCKETS)[number];
const BILLING_BUCKET_SET = new Set<string>(BILLING_BUCKETS);

function asBillingBucketKey(value: unknown): BillingBucketKey {
	return typeof value === "string" && BILLING_BUCKET_SET.has(value)
		? (value as BillingBucketKey)
		: "UNKNOWN";
}

type UsageBucketTotals = { costCents: number; calls: number; tokens: number };

function emptyBucketTotals(): Record<BillingBucketKey, UsageBucketTotals> {
	return Object.fromEntries(
		BILLING_BUCKETS.map((k) => [k, { costCents: 0, calls: 0, tokens: 0 }]),
	) as Record<BillingBucketKey, UsageBucketTotals>;
}

function rangeStart(range: UsageRange): Date | null {
	if (range === "all") {
		return null;
	}
	const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - days);
	return d;
}

function buildUsageWhere(projectId: string, range: UsageRange): Prisma.Sql {
	const since = rangeStart(range);
	return since
		? Prisma.sql`WHERE "projectId" = ${projectId} AND "createdAt" >= ${since}`
		: Prisma.sql`WHERE "projectId" = ${projectId}`;
}

// Dashboard sums use costMicroUsd (1μ$ = $10^-6) instead of the Int cents
// column because many per-call costs are sub-cent and round to zero; summing
// zeros across thousands of rows collapsed per-project totals to $0. We
// aggregate at micro-USD precision and only convert to cents at the edge.
function microUsdToCents(microUsd: number): number {
	return Number((microUsd / 10_000).toFixed(4));
}

function microUsdToUsd(microUsd: number): number {
	return Number((microUsd / 1_000_000).toFixed(6));
}

export interface ProjectUsageSummary {
	totalCostCents: number;
	totalCostUsd: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalTokens: number;
	totalCalls: number;
	/** Null when there were no calls in the range — callers should render an
	 *  empty-state value instead of a misleading 100%. */
	successRate: number | null;
	byBillingCategory: Record<BillingBucketKey, UsageBucketTotals>;
}

export async function getProjectUsageSummary(params: {
	projectId: string;
	range: UsageRange;
}): Promise<ProjectUsageSummary> {
	const { projectId, range } = params;

	const rows = await db.$queryRaw<
		Array<{
			billingCategory: AiUsageBillingCategory | null;
			costMicroUsd: bigint;
			calls: bigint;
			inputTokens: bigint;
			outputTokens: bigint;
			totalTokens: bigint;
			successCalls: bigint;
		}>
	>(Prisma.sql`
		SELECT
			"billingCategory" as "billingCategory",
			COALESCE(SUM("costMicroUsd"), 0)::bigint as "costMicroUsd",
			COUNT(*)::bigint as calls,
			COALESCE(SUM("inputTokens"), 0)::bigint as "inputTokens",
			COALESCE(SUM("outputTokens"), 0)::bigint as "outputTokens",
			COALESCE(SUM("totalTokens"), 0)::bigint as "totalTokens",
			COALESCE(SUM(CASE WHEN success THEN 1 ELSE 0 END), 0)::bigint as "successCalls"
		FROM "ai_usage_log"
		${buildUsageWhere(projectId, range)}
		GROUP BY "billingCategory"
	`);

	const summary: ProjectUsageSummary = {
		totalCostCents: 0,
		totalCostUsd: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalTokens: 0,
		totalCalls: 0,
		successRate: null,
		byBillingCategory: emptyBucketTotals(),
	};

	let successCalls = 0;
	let totalMicroUsd = 0;

	for (const row of rows) {
		const microUsd = Number(row.costMicroUsd);
		const costCents = microUsdToCents(microUsd);
		const calls = Number(row.calls);
		const totalTokens = Number(row.totalTokens);

		totalMicroUsd += microUsd;
		summary.totalCalls += calls;
		summary.totalInputTokens += Number(row.inputTokens);
		summary.totalOutputTokens += Number(row.outputTokens);
		summary.totalTokens += totalTokens;
		successCalls += Number(row.successCalls);

		const target =
			summary.byBillingCategory[asBillingBucketKey(row.billingCategory)];
		target.costCents += costCents;
		target.calls += calls;
		target.tokens += totalTokens;
	}

	summary.totalCostCents = microUsdToCents(totalMicroUsd);
	summary.totalCostUsd = microUsdToUsd(totalMicroUsd);
	summary.successRate =
		summary.totalCalls === 0 ? null : successCalls / summary.totalCalls;

	return summary;
}

export interface ProjectUsageBreakdownItem {
	key: string;
	label: string;
	costCents: number;
	costUsd: number;
	calls: number;
	totalTokens: number;
}

export async function getProjectUsageBreakdown(params: {
	projectId: string;
	range: UsageRange;
	groupBy: UsageGroupBy;
}): Promise<ProjectUsageBreakdownItem[]> {
	const { projectId, range, groupBy } = params;

	const column: Record<UsageGroupBy, Prisma.Sql> = {
		model: Prisma.sql`COALESCE("modelCanonicalName", "providerModelId")`,
		provider: Prisma.sql`"provider"::text`,
		taskType: Prisma.sql`"taskType"::text`,
		agentId: Prisma.sql`"agentId"`,
		billingCategory: Prisma.sql`"billingCategory"::text`,
	};

	const rows = await db.$queryRaw<
		Array<{
			key: string | null;
			costMicroUsd: bigint;
			calls: bigint;
			totalTokens: bigint;
		}>
	>(Prisma.sql`
		SELECT
			${column[groupBy]} as "key",
			COALESCE(SUM("costMicroUsd"), 0)::bigint as "costMicroUsd",
			COUNT(*)::bigint as calls,
			COALESCE(SUM("totalTokens"), 0)::bigint as "totalTokens"
		FROM "ai_usage_log"
		${buildUsageWhere(projectId, range)}
		GROUP BY ${column[groupBy]}
		ORDER BY "costMicroUsd" DESC
		LIMIT 50
	`);

	return rows.map((row) => {
		const key = row.key ?? "unknown";
		const microUsd = Number(row.costMicroUsd);
		return {
			key,
			label: key,
			costCents: microUsdToCents(microUsd),
			costUsd: microUsdToUsd(microUsd),
			calls: Number(row.calls),
			totalTokens: Number(row.totalTokens),
		};
	});
}

export interface ProjectUsageTimeSeriesPoint {
	bucketStart: string; // ISO date
	costCents: number;
	costUsd: number;
	totalTokens: number;
	calls: number;
}

export async function getProjectUsageTimeSeries(params: {
	projectId: string;
	range: UsageRange;
	bucket: UsageBucket;
}): Promise<ProjectUsageTimeSeriesPoint[]> {
	const { projectId, range, bucket } = params;
	// Force weekly buckets when range=all so old projects don't return
	// hundreds of daily points.
	const truncUnit = bucket === "week" || range === "all" ? "week" : "day";

	const rows = await db.$queryRaw<
		Array<{
			bucketStart: Date;
			costMicroUsd: bigint;
			totalTokens: bigint;
			calls: bigint;
		}>
	>(Prisma.sql`
		SELECT
			date_trunc(${truncUnit}, "createdAt") as "bucketStart",
			COALESCE(SUM("costMicroUsd"), 0)::bigint as "costMicroUsd",
			COALESCE(SUM("totalTokens"), 0)::bigint as "totalTokens",
			COUNT(*)::bigint as calls
		FROM "ai_usage_log"
		${buildUsageWhere(projectId, range)}
		GROUP BY "bucketStart"
		ORDER BY "bucketStart" ASC
	`);

	return rows.map((row) => {
		const microUsd = Number(row.costMicroUsd);
		return {
			bucketStart: row.bucketStart.toISOString(),
			costCents: microUsdToCents(microUsd),
			costUsd: microUsdToUsd(microUsd),
			totalTokens: Number(row.totalTokens),
			calls: Number(row.calls),
		};
	});
}

export interface ProjectUsageRecentItem {
	id: string;
	createdAt: Date;
	provider: AIProvider;
	modelCanonicalName: string | null;
	providerModelId: string;
	taskType: AiTaskType | null;
	agentId: string | null;
	conversationId: string | null;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costCents: number;
	costUsd: number;
	latencyMs: number;
	success: boolean;
	billingCategory: AiUsageBillingCategory | null;
}

export async function getProjectUsageRecent(params: {
	projectId: string;
	limit?: number;
	cursor?: string;
}): Promise<{ items: ProjectUsageRecentItem[]; nextCursor: string | null }> {
	const { projectId, limit = 25, cursor } = params;
	const safeLimit = Math.min(Math.max(limit, 1), 100);

	const rows = await db.aiUsageLog.findMany({
		where: { projectId },
		// Stable tie-breaker by id: rows created in the same timestamp bucket
		// would otherwise have nondeterministic order across pages, so cursor
		// pagination could skip or duplicate them.
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: safeLimit + 1,
		...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
		select: {
			id: true,
			createdAt: true,
			provider: true,
			modelCanonicalName: true,
			providerModelId: true,
			taskType: true,
			agentId: true,
			conversationId: true,
			inputTokens: true,
			outputTokens: true,
			totalTokens: true,
			costMicroUsd: true,
			latencyMs: true,
			success: true,
			billingCategory: true,
		},
	});

	const nextCursor = rows.length > safeLimit ? rows[safeLimit - 1].id : null;
	const items = rows.slice(0, safeLimit).map(({ costMicroUsd, ...row }) => ({
		...row,
		costCents: microUsdToCents(costMicroUsd),
		costUsd: microUsdToUsd(costMicroUsd),
	}));

	return { items, nextCursor };
}
