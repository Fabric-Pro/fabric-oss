import { db, type Prisma } from "../client";
import type { AIProvider, AiTaskType } from "../generated/client";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const DEFAULT_PERIOD_DAYS = 30;

/**
 * Build a Prisma WHERE fragment for a multi-select project filter.
 *
 * The projectId column is nullable, so the array can carry a literal
 * `null` element to mean "rows with no project". Returns:
 *   - `{}` when the array is undefined/empty (no filter)
 *   - `{ projectId: null }` when only `null` is selected
 *   - `{ projectId: { in: [...] } }` when only ids are selected
 *   - `{ OR: [{ projectId: { in: [...] } }, { projectId: null }] }`
 *     when both ids and `null` are selected
 */
function buildProjectIdClause(
	projectIds: Array<string | null> | undefined,
): Prisma.AiUsageLogWhereInput {
	if (!projectIds || projectIds.length === 0) {
		return {};
	}
	const includeNull = projectIds.some((id) => id === null);
	const ids = projectIds.filter((id): id is string => typeof id === "string");

	if (includeNull && ids.length === 0) {
		return { projectId: null };
	}
	if (!includeNull) {
		return { projectId: { in: ids } };
	}
	return { OR: [{ projectId: { in: ids } }, { projectId: null }] };
}

type TenantParams =
	| { organizationId: string; userId?: string }
	| { userId: string; organizationId?: null | undefined };

export interface AiUsageActivityRow {
	id: string;
	createdAt: Date;
	userId: string | null;
	userName: string | null;
	userEmail: string | null;
	provider: AIProvider;
	modelCanonicalName: string | null;
	providerModelId: string;
	taskType: AiTaskType | null;
	agentId: string | null;
	conversationId: string | null;
	/** Background-attribution label (Fizzy #1894); null = user-initiated. */
	jobType: string | null;
	projectId: string | null;
	projectName: string | null;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costMicroUsd: number;
	latencyMs: number;
	success: boolean;
	errorMessage: string | null;
}

export interface AiUsageActivityTotals {
	requests: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costMicroUsd: number;
	avgLatencyMs: number;
}

export interface AiUsageActivityResult {
	rows: AiUsageActivityRow[];
	nextCursor: string | null;
	totals: AiUsageActivityTotals;
	periodDays: number;
}

export type AiUsageActivitySortBy =
	| "createdAt"
	| "totalTokens"
	| "costMicroUsd"
	| "latencyMs";
export type AiUsageActivitySortOrder = "asc" | "desc";

export async function listAiUsageActivity(
	params: TenantParams & {
		periodDays?: number;
		from?: Date;
		to?: Date;
		taskTypes?: AiTaskType[];
		status?: "success" | "error";
		providerModelIds?: string[];
		// Array of project ids; `null` is a valid element meaning "rows
		// with no project". `[]` means "no filter" (all rows match).
		projectIds?: Array<string | null>;
		// `filterUserIds` narrows org-context results to one or more
		// specific members. Distinct from the tenant `userId` on personal
		// context, which identifies WHICH user's personal data to read.
		filterUserIds?: string[];
		minCostMicroUsd?: number;
		maxCostMicroUsd?: number;
		minLatencyMs?: number;
		maxLatencyMs?: number;
		sortBy?: AiUsageActivitySortBy;
		sortOrder?: AiUsageActivitySortOrder;
		cursor?: string;
		limit?: number;
	},
): Promise<AiUsageActivityResult> {
	const limit = Math.max(
		1,
		Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
	);

	// Date range filter precedence:
	//   1. Explicit { from, to } takes over when either bound is set.
	//   2. Otherwise fall back to periodDays preset (default 30).
	let createdAt: Prisma.DateTimeFilter | undefined;
	let effectivePeriodDays = Math.max(
		1,
		params.periodDays ?? DEFAULT_PERIOD_DAYS,
	);

	if (params.from || params.to) {
		createdAt = {};
		if (params.from) {
			createdAt.gte = params.from;
		}
		if (params.to) {
			createdAt.lte = params.to;
		}
		// periodDays loses meaning when an explicit range is supplied; report
		// the actual span so summary tile copy can stay accurate.
		if (params.from && params.to) {
			const ms = params.to.getTime() - params.from.getTime();
			effectivePeriodDays = Math.max(1, Math.ceil(ms / 86_400_000));
		}
	} else {
		const periodStart = new Date();
		periodStart.setDate(periodStart.getDate() - effectivePeriodDays);
		createdAt = { gte: periodStart };
	}

	const tenantWhere: Prisma.AiUsageLogWhereInput =
		"organizationId" in params && params.organizationId
			? { organizationId: params.organizationId }
			: { userId: params.userId, organizationId: null };

	const costFilter: { gte?: number; lte?: number } = {};
	if (typeof params.minCostMicroUsd === "number") {
		costFilter.gte = params.minCostMicroUsd;
	}
	if (typeof params.maxCostMicroUsd === "number") {
		costFilter.lte = params.maxCostMicroUsd;
	}

	const latencyFilter: { gte?: number; lte?: number } = {};
	if (typeof params.minLatencyMs === "number") {
		latencyFilter.gte = params.minLatencyMs;
	}
	if (typeof params.maxLatencyMs === "number") {
		latencyFilter.lte = params.maxLatencyMs;
	}

	const projectIdClause = buildProjectIdClause(params.projectIds);

	const where: Prisma.AiUsageLogWhereInput = {
		...tenantWhere,
		createdAt,
		...(params.taskTypes && params.taskTypes.length > 0
			? { taskType: { in: params.taskTypes } }
			: {}),
		...(params.status ? { success: params.status === "success" } : {}),
		...(params.providerModelIds && params.providerModelIds.length > 0
			? { providerModelId: { in: params.providerModelIds } }
			: {}),
		...projectIdClause,
		...("organizationId" in params &&
		params.organizationId &&
		params.filterUserIds &&
		params.filterUserIds.length > 0
			? { userId: { in: params.filterUserIds } }
			: {}),
		...(Object.keys(costFilter).length > 0
			? { costMicroUsd: costFilter }
			: {}),
		...(Object.keys(latencyFilter).length > 0
			? { latencyMs: latencyFilter }
			: {}),
	};

	const sortBy = params.sortBy ?? "createdAt";
	const sortOrder = params.sortOrder ?? "desc";

	// Tiebreaker by `id` (also descending) keeps cursor pagination
	// deterministic when the primary sort field has duplicate values.
	const orderBy: Prisma.AiUsageLogOrderByWithRelationInput[] = [
		{ [sortBy]: sortOrder } as Prisma.AiUsageLogOrderByWithRelationInput,
		{ id: sortOrder },
	];

	const [rawRows, totalsAggregate] = await Promise.all([
		db.aiUsageLog.findMany({
			where,
			orderBy,
			take: limit + 1,
			...(params.cursor
				? { cursor: { id: params.cursor }, skip: 1 }
				: {}),
			select: {
				id: true,
				createdAt: true,
				userId: true,
				provider: true,
				modelCanonicalName: true,
				providerModelId: true,
				taskType: true,
				agentId: true,
				conversationId: true,
				jobType: true,
				projectId: true,
				inputTokens: true,
				outputTokens: true,
				totalTokens: true,
				costMicroUsd: true,
				latencyMs: true,
				success: true,
				errorMessage: true,
				project: {
					select: { name: true },
				},
			},
		}),
		db.aiUsageLog.aggregate({
			where,
			_sum: {
				inputTokens: true,
				outputTokens: true,
				totalTokens: true,
				costMicroUsd: true,
			},
			_count: { id: true },
			_avg: { latencyMs: true },
		}),
	]);

	const hasMore = rawRows.length > limit;
	const sliced = hasMore ? rawRows.slice(0, limit) : rawRows;
	const nextCursor = hasMore ? (sliced[sliced.length - 1]?.id ?? null) : null;

	// Enrich with user name/email for org context — multi-member orgs need
	// to see who ran each call. Personal context is the caller, so skip.
	const isOrg = "organizationId" in params && params.organizationId;
	const userIds = isOrg
		? Array.from(
				new Set(
					sliced
						.map((row) => row.userId)
						.filter((id): id is string => Boolean(id)),
				),
			)
		: [];

	const usersById =
		userIds.length > 0
			? new Map(
					(
						await db.user.findMany({
							where: { id: { in: userIds } },
							select: { id: true, name: true, email: true },
						})
					).map((user) => [user.id, user]),
				)
			: new Map<string, { id: string; name: string; email: string }>();

	const rows: AiUsageActivityRow[] = sliced.map((row) => {
		const user = row.userId ? usersById.get(row.userId) : null;
		return {
			id: row.id,
			createdAt: row.createdAt,
			userId: row.userId,
			userName: user?.name ?? null,
			userEmail: user?.email ?? null,
			provider: row.provider,
			modelCanonicalName: row.modelCanonicalName,
			providerModelId: row.providerModelId,
			taskType: row.taskType,
			agentId: row.agentId,
			conversationId: row.conversationId,
			jobType: row.jobType,
			projectId: row.projectId,
			projectName: row.project?.name ?? null,
			inputTokens: row.inputTokens,
			outputTokens: row.outputTokens,
			totalTokens: row.totalTokens,
			costMicroUsd: row.costMicroUsd,
			latencyMs: row.latencyMs,
			success: row.success,
			errorMessage: row.errorMessage,
		};
	});

	return {
		rows,
		nextCursor,
		periodDays: effectivePeriodDays,
		totals: {
			requests: totalsAggregate._count.id,
			inputTokens: totalsAggregate._sum.inputTokens ?? 0,
			outputTokens: totalsAggregate._sum.outputTokens ?? 0,
			totalTokens: totalsAggregate._sum.totalTokens ?? 0,
			costMicroUsd: totalsAggregate._sum.costMicroUsd ?? 0,
			avgLatencyMs: Math.round(totalsAggregate._avg.latencyMs ?? 0),
		},
	};
}

/**
 * Distinct models and projects that appear in the tenant's recent usage —
 * used to populate the activity-history filter dropdowns. Scoped to the
 * same XOR tenant filter so a personal user never sees an org's models.
 */
export interface AiUsageActivityFacets {
	models: Array<{
		providerModelId: string;
		modelCanonicalName: string | null;
		provider: AIProvider;
		requests: number;
	}>;
	projects: Array<{ id: string; name: string }>;
	users: Array<{
		id: string;
		name: string | null;
		email: string | null;
		requests: number;
		removed: boolean;
	}>;
}

export async function getAiUsageActivityFacets(
	params: TenantParams & { periodDays?: number; from?: Date; to?: Date },
): Promise<AiUsageActivityFacets> {
	let createdAt: Prisma.DateTimeFilter | undefined;
	if (params.from || params.to) {
		createdAt = {};
		if (params.from) {
			createdAt.gte = params.from;
		}
		if (params.to) {
			createdAt.lte = params.to;
		}
	} else {
		const periodDays = Math.max(
			1,
			params.periodDays ?? DEFAULT_PERIOD_DAYS,
		);
		const periodStart = new Date();
		periodStart.setDate(periodStart.getDate() - periodDays);
		createdAt = { gte: periodStart };
	}

	const tenantWhere: Prisma.AiUsageLogWhereInput =
		"organizationId" in params && params.organizationId
			? { organizationId: params.organizationId }
			: { userId: params.userId, organizationId: null };

	const where: Prisma.AiUsageLogWhereInput = { ...tenantWhere, createdAt };
	const isOrg = "organizationId" in params && params.organizationId;

	const [modelGroups, projectIds, userGroups] = await Promise.all([
		db.aiUsageLog.groupBy({
			by: ["providerModelId", "modelCanonicalName", "provider"],
			where,
			_count: { id: true },
			orderBy: { _count: { id: "desc" } },
			take: 30,
		}),
		db.aiUsageLog.findMany({
			where: { ...where, projectId: { not: null } },
			distinct: ["projectId"],
			select: { projectId: true },
			take: 100,
		}),
		// Only relevant on org pages — personal users see only their own runs.
		isOrg
			? db.aiUsageLog.groupBy({
					by: ["userId"],
					where: { ...where, userId: { not: null } },
					_count: { id: true },
					orderBy: { _count: { id: "desc" } },
					take: 200,
				})
			: Promise.resolve(
					[] as Array<{
						userId: string | null;
						_count: { id: number };
					}>,
				),
	]);

	const projectIdList = projectIds
		.map((row) => row.projectId)
		.filter((id): id is string => Boolean(id));

	const userIdList = userGroups
		.map((row) => row.userId)
		.filter((id): id is string => Boolean(id));

	const [projectRows, userRows] = await Promise.all([
		projectIdList.length > 0
			? db.project.findMany({
					where: { id: { in: projectIdList } },
					select: { id: true, name: true },
				})
			: Promise.resolve([] as Array<{ id: string; name: string }>),
		userIdList.length > 0
			? db.user.findMany({
					where: { id: { in: userIdList } },
					select: { id: true, name: true, email: true },
				})
			: Promise.resolve(
					[] as Array<{
						id: string;
						name: string | null;
						email: string | null;
					}>,
				),
	]);

	const usersById = new Map(userRows.map((u) => [u.id, u]));

	return {
		models: modelGroups.map((row) => ({
			providerModelId: row.providerModelId,
			modelCanonicalName: row.modelCanonicalName,
			provider: row.provider,
			requests: row._count.id,
		})),
		projects: projectRows.map((row) => ({ id: row.id, name: row.name })),
		users: userGroups
			.filter((row): row is typeof row & { userId: string } =>
				Boolean(row.userId),
			)
			.map((row) => {
				const user = usersById.get(row.userId);
				return {
					id: row.userId,
					name: user?.name ?? null,
					email: user?.email ?? null,
					requests: row._count.id,
					// Hard-deleted users have no row in `User`; we still know
					// they ran calls because the userId remains on AiUsageLog.
					removed: !user,
				};
			}),
	};
}

export interface AiUsageActivityTimeSeriesPoint {
	// ISO timestamp of the bucket start. The granularity (day/hour/minute)
	// is encoded by the caller's `granularity` param — clients should not
	// parse this string themselves.
	date: string;
	requests: number;
	totalTokens: number;
	costMicroUsd: number;
	// Mean latency (ms) over rows in this bucket. Zero when the bucket
	// is empty so charts can render a continuous line.
	avgLatencyMs: number;
}

export type AiUsageActivityGranularity = "day" | "hour" | "minute";

/**
 * Daily aggregate of AI usage for the same XOR tenant filter, used to
 * power the activity-history chart. Returns one bucket per day in the
 * range, including zero-rows for days without any activity so the chart
 * x-axis stays continuous.
 */
export async function getAiUsageActivityTimeSeries(
	params: TenantParams & {
		periodDays?: number;
		from?: Date;
		to?: Date;
		taskTypes?: AiTaskType[];
		status?: "success" | "error";
		providerModelIds?: string[];
		// Array of project ids; `null` is a valid element meaning "rows
		// with no project". `[]` means "no filter" (all rows match).
		projectIds?: Array<string | null>;
		filterUserIds?: string[];
		minCostMicroUsd?: number;
		maxCostMicroUsd?: number;
		minLatencyMs?: number;
		maxLatencyMs?: number;
		// Bucket size: "day" for the default 30-day view, "hour" when the
		// caller has zoomed into ≤ ~7 days, "minute" for sub-day windows.
		// Chosen by the client — backend doesn't infer.
		granularity?: AiUsageActivityGranularity;
	},
): Promise<AiUsageActivityTimeSeriesPoint[]> {
	let from: Date;
	let to: Date;
	if (params.from && params.to) {
		from = params.from;
		to = params.to;
	} else {
		const periodDays = Math.max(
			1,
			params.periodDays ?? DEFAULT_PERIOD_DAYS,
		);
		to = new Date();
		from = new Date();
		from.setDate(from.getDate() - periodDays);
	}

	const tenantWhere: Prisma.AiUsageLogWhereInput =
		"organizationId" in params && params.organizationId
			? { organizationId: params.organizationId }
			: { userId: params.userId, organizationId: null };

	const costFilter: { gte?: number; lte?: number } = {};
	if (typeof params.minCostMicroUsd === "number") {
		costFilter.gte = params.minCostMicroUsd;
	}
	if (typeof params.maxCostMicroUsd === "number") {
		costFilter.lte = params.maxCostMicroUsd;
	}

	const latencyFilter: { gte?: number; lte?: number } = {};
	if (typeof params.minLatencyMs === "number") {
		latencyFilter.gte = params.minLatencyMs;
	}
	if (typeof params.maxLatencyMs === "number") {
		latencyFilter.lte = params.maxLatencyMs;
	}

	const projectIdClause = buildProjectIdClause(params.projectIds);

	const where: Prisma.AiUsageLogWhereInput = {
		...tenantWhere,
		createdAt: { gte: from, lte: to },
		...(params.taskTypes && params.taskTypes.length > 0
			? { taskType: { in: params.taskTypes } }
			: {}),
		...(params.status ? { success: params.status === "success" } : {}),
		...(params.providerModelIds && params.providerModelIds.length > 0
			? { providerModelId: { in: params.providerModelIds } }
			: {}),
		...projectIdClause,
		...("organizationId" in params &&
		params.organizationId &&
		params.filterUserIds &&
		params.filterUserIds.length > 0
			? { userId: { in: params.filterUserIds } }
			: {}),
		...(Object.keys(costFilter).length > 0
			? { costMicroUsd: costFilter }
			: {}),
		...(Object.keys(latencyFilter).length > 0
			? { latencyMs: latencyFilter }
			: {}),
	};

	const granularity = params.granularity ?? "day";

	// Pull rows we need to bucket, then group in JS. Hard-cap kept large
	// enough for ~365 days of daily/hourly aggregation but bounded to
	// avoid runaway memory on bad input.
	const rows = await db.aiUsageLog.findMany({
		where,
		select: {
			createdAt: true,
			totalTokens: true,
			costMicroUsd: true,
			latencyMs: true,
		},
		orderBy: { createdAt: "asc" },
		take: 50_000,
	});

	// Round a Date to the bucket boundary. The result becomes the bucket
	// key (ISO string) and is what the client renders on the x-axis.
	const truncate = (d: Date): Date => {
		const out = new Date(d);
		switch (granularity) {
			case "minute":
				// Round to the nearest 5-minute slot — keeps a sub-hour
				// zoom navigable without blowing the bucket count up.
				out.setSeconds(0, 0);
				out.setMinutes(Math.floor(out.getMinutes() / 5) * 5);
				return out;
			case "hour":
				out.setMinutes(0, 0, 0);
				return out;
			default:
				out.setHours(0, 0, 0, 0);
				return out;
		}
	};

	const advance = (d: Date): Date => {
		const out = new Date(d);
		switch (granularity) {
			case "minute":
				out.setMinutes(out.getMinutes() + 5);
				return out;
			case "hour":
				out.setHours(out.getHours() + 1);
				return out;
			default:
				out.setDate(out.getDate() + 1);
				return out;
		}
	};

	const buckets = new Map<
		number,
		{
			date: Date;
			requests: number;
			totalTokens: number;
			costMicroUsd: number;
			latencySum: number;
		}
	>();

	// Pre-fill bucket boundaries inside the requested range so the
	// x-axis stays continuous (empty buckets render as zero, no gaps).
	for (
		let cursor = truncate(from);
		cursor.getTime() <= to.getTime();
		cursor = advance(cursor)
	) {
		buckets.set(cursor.getTime(), {
			date: new Date(cursor),
			requests: 0,
			totalTokens: 0,
			costMicroUsd: 0,
			latencySum: 0,
		});
	}

	for (const row of rows) {
		const key = truncate(row.createdAt).getTime();
		const bucket = buckets.get(key);
		if (!bucket) {
			continue;
		}
		bucket.requests += 1;
		bucket.totalTokens += row.totalTokens;
		bucket.costMicroUsd += row.costMicroUsd;
		bucket.latencySum += row.latencyMs;
	}

	return Array.from(buckets.values())
		.sort((a, b) => a.date.getTime() - b.date.getTime())
		.map(({ date, latencySum, requests, ...vals }) => ({
			date: date.toISOString(),
			requests,
			...vals,
			avgLatencyMs: requests > 0 ? Math.round(latencySum / requests) : 0,
		}));
}

export interface AiUsageEstimate {
	medianInputTokens: number;
	medianOutputTokens: number;
	medianTotalTokens: number;
	medianLatencyMs: number;
	medianCostMicroUsd: number;
	sampleCount: number;
}

const ESTIMATE_SAMPLE_SIZE = 20;

function median(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
		: sorted[mid];
}

export async function getMedianAiUsageByTaskType(
	params: TenantParams & {
		taskType: AiTaskType;
		sampleSize?: number;
	},
): Promise<AiUsageEstimate | null> {
	const sampleSize = Math.max(
		1,
		Math.min(params.sampleSize ?? ESTIMATE_SAMPLE_SIZE, 100),
	);

	const tenantWhere: Prisma.AiUsageLogWhereInput =
		"organizationId" in params && params.organizationId
			? { organizationId: params.organizationId }
			: { userId: params.userId, organizationId: null };

	const samples = await db.aiUsageLog.findMany({
		where: {
			...tenantWhere,
			taskType: params.taskType,
			success: true,
		},
		orderBy: { createdAt: "desc" },
		take: sampleSize,
		select: {
			inputTokens: true,
			outputTokens: true,
			totalTokens: true,
			latencyMs: true,
			costMicroUsd: true,
		},
	});

	if (samples.length === 0) {
		return null;
	}

	return {
		medianInputTokens: median(samples.map((s) => s.inputTokens)),
		medianOutputTokens: median(samples.map((s) => s.outputTokens)),
		medianTotalTokens: median(samples.map((s) => s.totalTokens)),
		medianLatencyMs: median(samples.map((s) => s.latencyMs)),
		medianCostMicroUsd: median(samples.map((s) => s.costMicroUsd)),
		sampleCount: samples.length,
	};
}
