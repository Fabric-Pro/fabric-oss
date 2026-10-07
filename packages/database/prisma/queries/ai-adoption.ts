import { db } from "../client";
import type {
	AnswerSource,
	PendingBacklogProposalStatus,
} from "../generated/client";
import type { ChatGptPlanModelUsage } from "./ai-usage-activity";

/**
 * Read-only aggregates for the platform-admin "AI Adoption" dashboard
 * (Fizzy #2230, Phase 0). These queries introduce NO new write paths and are
 * only reachable through instance-admin procedures, so they run rarely; keep
 * them as single-pass aggregations.
 *
 * Load notes per table:
 * - DecisionLogEntry has no index covering (answerSource, createdAt); the
 *   answered-entry population is human-action-sized (one row per settled
 *   answer), so a range scan is acceptable here. Revisit with a partial
 *   index if this table ever grows hot.
 * - PendingBacklogProposal has a [createdAt] index; BacklogUpdateSession is
 *   aggregated via its primary-key-sized row count.
 * - AiUsageLog is the big table: one groupBy pass per aggregate (the
 *   platform summary and the per-organization billing-source split), each
 *   the same clamped createdAt range scan.
 */

const MAX_PERIOD_DAYS = 365;

export interface AiAdoptionRange {
	from: Date;
	to: Date;
}

export interface MaturationAnswerAdoption {
	totals: {
		aiSuggested: number;
		aiEdited: number;
		manual: number;
		total: number;
	};
	/** Per-day counts, gap-filled, oldest first. Dates are UTC YYYY-MM-DD. */
	series: Array<{
		date: string;
		aiSuggested: number;
		aiEdited: number;
		manual: number;
	}>;
}

export interface BacklogProposalAdoption {
	statusTotals: Record<PendingBacklogProposalStatus, number>;
	totalProposals: number;
	/** Per-day accepted (APPROVED+APPLIED) vs rejected counts, gap-filled. */
	series: Array<{ date: string; accepted: number; rejected: number }>;
	sessions: {
		count: number;
		appliedChanges: number;
		failedChanges: number;
	};
}

export interface AiBillingSourceOrganizationRow {
	/** null = rows recorded without an organization. */
	organizationId: string | null;
	organizationName: string | null;
	plan: {
		requests: number;
		totalTokens: number;
		/** Tokens per plan model, for the API-equivalent estimate. */
		usageByModel: ChatGptPlanModelUsage[];
	};
	api: { requests: number; totalTokens: number; costMicroUsd: number };
}

export interface AiBillingSourceByOrganization {
	rows: AiBillingSourceOrganizationRow[];
	/** Organizations with any usage in the window, before the row cap. */
	totalOrganizations: number;
}

export interface AiUsageAdoptionSummary {
	requests: number;
	failedRequests: number;
	totalTokens: number;
	costMicroUsd: number;
}

function clampRange({ from, to }: AiAdoptionRange): AiAdoptionRange {
	const maxSpanMs = MAX_PERIOD_DAYS * 24 * 60 * 60 * 1000;
	const safeTo = to;
	const safeFrom =
		safeTo.getTime() - from.getTime() > maxSpanMs
			? new Date(safeTo.getTime() - maxSpanMs)
			: from;
	return { from: safeFrom, to: safeTo };
}

function utcDayKey(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** Every UTC day key in [from, to], oldest first. */
function enumerateDays({ from, to }: AiAdoptionRange): string[] {
	const days: string[] = [];
	const cursor = new Date(
		Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
	);
	const end = to.getTime();
	while (cursor.getTime() <= end) {
		days.push(utcDayKey(cursor));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return days;
}

/**
 * How maturation answers were sourced: taken from the AI recommendation
 * as-is, edited from it, or written manually. `answerSource IS NOT NULL` is
 * the "an answer happened" predicate (set on settled reply turns and minted
 * RESOLVED roots).
 */
export async function getMaturationAnswerAdoption(
	range: AiAdoptionRange,
): Promise<MaturationAnswerAdoption> {
	const { from, to } = clampRange(range);

	const rows = await db.decisionLogEntry.findMany({
		where: {
			answerSource: { not: null },
			deletedAt: null,
			createdAt: { gte: from, lte: to },
		},
		select: { createdAt: true, answerSource: true },
	});

	const totals = { aiSuggested: 0, aiEdited: 0, manual: 0, total: 0 };
	const byDay = new Map<
		string,
		{ aiSuggested: number; aiEdited: number; manual: number }
	>();
	for (const day of enumerateDays({ from, to })) {
		byDay.set(day, { aiSuggested: 0, aiEdited: 0, manual: 0 });
	}

	const FIELD_BY_SOURCE: Record<
		AnswerSource,
		"aiSuggested" | "aiEdited" | "manual"
	> = {
		AI_SUGGESTED: "aiSuggested",
		AI_EDITED: "aiEdited",
		MANUAL: "manual",
	};

	for (const row of rows) {
		if (!row.answerSource) {
			continue;
		}
		const field = FIELD_BY_SOURCE[row.answerSource];
		totals[field] += 1;
		totals.total += 1;
		const bucket = byDay.get(utcDayKey(row.createdAt));
		if (bucket) {
			bucket[field] += 1;
		}
	}

	return {
		totals,
		series: Array.from(byDay.entries()).map(([date, counts]) => ({
			date,
			...counts,
		})),
	};
}

const BACKLOG_STATUSES: PendingBacklogProposalStatus[] = [
	"PENDING",
	"APPROVED",
	"APPLIED",
	"REJECTED",
	"FAILED",
	"SUPERSEDED",
	"BACKLOG",
];

/**
 * AI Backlog Update proposal outcomes plus applied/failed change counts from
 * the sessions ledger.
 */
export async function getBacklogProposalAdoption(
	range: AiAdoptionRange,
): Promise<BacklogProposalAdoption> {
	const { from, to } = clampRange(range);
	const createdAt = { gte: from, lte: to };

	const [statusGroups, proposalRows, sessionAggregate] = await Promise.all([
		db.pendingBacklogProposal.groupBy({
			by: ["status"],
			where: { createdAt },
			_count: { _all: true },
		}),
		db.pendingBacklogProposal.findMany({
			where: {
				createdAt,
				status: { in: ["APPROVED", "APPLIED", "REJECTED"] },
			},
			select: { createdAt: true, status: true },
		}),
		db.backlogUpdateSession.aggregate({
			where: { createdAt },
			_count: { _all: true },
			_sum: { appliedCount: true, failedCount: true },
		}),
	]);

	const statusTotals = Object.fromEntries(
		BACKLOG_STATUSES.map((status) => [status, 0]),
	) as Record<PendingBacklogProposalStatus, number>;
	let totalProposals = 0;
	for (const group of statusGroups) {
		statusTotals[group.status] = group._count._all;
		totalProposals += group._count._all;
	}

	const byDay = new Map<string, { accepted: number; rejected: number }>();
	for (const day of enumerateDays({ from, to })) {
		byDay.set(day, { accepted: 0, rejected: 0 });
	}
	for (const row of proposalRows) {
		const bucket = byDay.get(utcDayKey(row.createdAt));
		if (!bucket) {
			continue;
		}
		if (row.status === "REJECTED") {
			bucket.rejected += 1;
		} else {
			bucket.accepted += 1;
		}
	}

	return {
		statusTotals,
		totalProposals,
		series: Array.from(byDay.entries()).map(([date, counts]) => ({
			date,
			...counts,
		})),
		sessions: {
			count: sessionAggregate._count._all,
			appliedChanges: sessionAggregate._sum.appliedCount ?? 0,
			failedChanges: sessionAggregate._sum.failedCount ?? 0,
		},
	};
}

/**
 * Platform-wide LLM call volume for the same window, as denominator context.
 * Single groupBy pass; callers should surface that LangGraph agent runtimes
 * bypass the usage-logging middleware, so this undercounts agent traffic.
 */
export async function getAiUsageAdoptionSummary(
	range: AiAdoptionRange,
): Promise<AiUsageAdoptionSummary> {
	const { from, to } = clampRange(range);

	const groups = await db.aiUsageLog.groupBy({
		by: ["success"],
		where: { createdAt: { gte: from, lte: to } },
		_count: { _all: true },
		_sum: { totalTokens: true, costMicroUsd: true },
	});

	const summary: AiUsageAdoptionSummary = {
		requests: 0,
		failedRequests: 0,
		totalTokens: 0,
		costMicroUsd: 0,
	};
	for (const group of groups) {
		summary.requests += group._count._all;
		summary.totalTokens += group._sum.totalTokens ?? 0;
		summary.costMicroUsd += group._sum.costMicroUsd ?? 0;
		if (!group.success) {
			summary.failedRequests += group._count._all;
		}
	}
	return summary;
}

const BILLING_SOURCE_ORG_ROW_CAP = 50;

/**
 * Per-organization split of LLM calls between members' own ChatGPT plans and
 * API-billed providers. Plan rows record cost 0, so only API cost is
 * reported. Ordered by plan requests, then API requests; capped at
 * BILLING_SOURCE_ORG_ROW_CAP rows.
 */
export async function getAiBillingSourceByOrganization(
	range: AiAdoptionRange,
): Promise<AiBillingSourceByOrganization> {
	const { from, to } = clampRange(range);

	const [groups, planModelGroups] = await Promise.all([
		db.aiUsageLog.groupBy({
			by: ["organizationId", "provider"],
			where: { createdAt: { gte: from, lte: to } },
			_count: { _all: true },
			_sum: { totalTokens: true, costMicroUsd: true },
		}),
		db.aiUsageLog.groupBy({
			by: ["organizationId", "providerModelId"],
			where: {
				createdAt: { gte: from, lte: to },
				provider: "OPENAI_CHATGPT_PLAN",
			},
			_sum: {
				inputTokens: true,
				outputTokens: true,
				cachedInputTokens: true,
			},
		}),
	]);

	const byOrg = new Map<string | null, AiBillingSourceOrganizationRow>();
	for (const group of groups) {
		let row = byOrg.get(group.organizationId);
		if (!row) {
			row = {
				organizationId: group.organizationId,
				organizationName: null,
				plan: { requests: 0, totalTokens: 0, usageByModel: [] },
				api: { requests: 0, totalTokens: 0, costMicroUsd: 0 },
			};
			byOrg.set(group.organizationId, row);
		}
		const requests = group._count._all;
		const totalTokens = group._sum.totalTokens ?? 0;
		if (group.provider === "OPENAI_CHATGPT_PLAN") {
			row.plan.requests += requests;
			row.plan.totalTokens += totalTokens;
		} else {
			row.api.requests += requests;
			row.api.totalTokens += totalTokens;
			row.api.costMicroUsd += group._sum.costMicroUsd ?? 0;
		}
	}

	for (const group of planModelGroups) {
		byOrg.get(group.organizationId)?.plan.usageByModel.push({
			providerModelId: group.providerModelId,
			inputTokens: group._sum.inputTokens ?? 0,
			outputTokens: group._sum.outputTokens ?? 0,
			cachedInputTokens: group._sum.cachedInputTokens ?? 0,
		});
	}

	const rows = Array.from(byOrg.values())
		.sort(
			(a, b) =>
				b.plan.requests - a.plan.requests ||
				b.api.requests - a.api.requests,
		)
		.slice(0, BILLING_SOURCE_ORG_ROW_CAP);

	const organizationIds = rows
		.map((row) => row.organizationId)
		.filter((id): id is string => id !== null);
	if (organizationIds.length > 0) {
		const organizations = await db.organization.findMany({
			where: { id: { in: organizationIds } },
			select: { id: true, name: true },
		});
		const nameById = new Map(
			organizations.map((org) => [org.id, org.name]),
		);
		for (const row of rows) {
			if (row.organizationId) {
				row.organizationName = nameById.get(row.organizationId) ?? null;
			}
		}
	}

	return { rows, totalOrganizations: byOrg.size };
}
