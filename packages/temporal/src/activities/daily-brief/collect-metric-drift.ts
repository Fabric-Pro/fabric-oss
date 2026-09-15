/**
 * Daily Brief — Success-metric drift collector (plan Slice 8).
 *
 * Reads the project's `ProjectSuccessMetric` rows and flags the ones that
 * need attention:
 *   - moved_against_direction — `lastValue` moved the wrong way vs
 *     `previousValue` (UP metrics fell, DOWN metrics rose)
 *   - missed_target           — a target exists and `lastValue` is on the
 *     wrong side of it
 *   - stale_observation       — no observation at all, or the last one is
 *     older than `METRIC_STALE_DAYS`
 *
 * Deterministic and DB-local; no LLM, no network. Returns the section items
 * and the matching `metric_drift` priority actions so the workflow can merge
 * them without a second activity.
 */
import type { MetricDriftItem, PriorityAction } from "@repo/database";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";

export const METRIC_STALE_DAYS = 14;

export interface CollectMetricDriftInput {
	projectId: string;
	organizationId: string | null;
	/** Injected by tests; defaults to `new Date()`. */
	now?: Date | string;
}

export interface CollectMetricDriftOutput {
	items: MetricDriftItem[];
	priorityActions: PriorityAction[];
}

export interface MetricDriftCandidate {
	id: string;
	name: string;
	direction: "UP" | "DOWN";
	target: number | null;
	lastValue: number | null;
	previousValue: number | null;
	lastObservedAt: Date | null;
}

/** Pure rule set — exported so the collector's contract is unit-testable. */
export function evaluateMetricDrift(
	metric: MetricDriftCandidate,
	now: Date,
): MetricDriftItem["reasons"] {
	const reasons: MetricDriftItem["reasons"] = [];
	const { direction, target, lastValue, previousValue, lastObservedAt } =
		metric;

	if (lastValue !== null && previousValue !== null) {
		const movedAgainst =
			direction === "UP"
				? lastValue < previousValue
				: lastValue > previousValue;
		if (movedAgainst) {
			reasons.push("moved_against_direction");
		}
	}

	if (lastValue !== null && target !== null) {
		const missed =
			direction === "UP" ? lastValue < target : lastValue > target;
		if (missed) {
			reasons.push("missed_target");
		}
	}

	const staleCutoff = now.getTime() - METRIC_STALE_DAYS * 24 * 60 * 60 * 1000;
	if (!lastObservedAt || lastObservedAt.getTime() < staleCutoff) {
		reasons.push("stale_observation");
	}

	return reasons;
}

export function metricsTabLink(
	projectId: string,
	organizationSlug?: string | null,
): string {
	const base = organizationSlug
		? `/app/${organizationSlug}/projects/${projectId}`
		: `/app/projects/${projectId}`;
	return `${base}?tab=outcomes`;
}

function formatValue(value: number | null): string {
	if (value === null) {
		return "—";
	}
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function describeDrift(item: MetricDriftItem): { title: string; why: string } {
	const { name, reasons, lastValue, previousValue, target, direction } = item;
	if (reasons.includes("moved_against_direction")) {
		return {
			title: `${name} moved from ${formatValue(previousValue)} to ${formatValue(lastValue)}`,
			why: `The metric should go ${direction === "UP" ? "up" : "down"} and moved the other way.`,
		};
	}
	if (reasons.includes("missed_target")) {
		return {
			title: `${name} is at ${formatValue(lastValue)} against a target of ${formatValue(target)}`,
			why: "The latest observation is on the wrong side of the agreed target.",
		};
	}
	return {
		title: `${name} has no observation in the last ${METRIC_STALE_DAYS} days`,
		why: "Without a fresh value the outcomes page cannot show whether the work is paying off.",
	};
}

export function buildMetricDriftActions(
	items: MetricDriftItem[],
	link: string,
): PriorityAction[] {
	return items.map((item) => {
		const { title, why } = describeDrift(item);
		return {
			kind: "metric_drift",
			title,
			whyItMatters: why,
			targetCuid: item.metricId,
			targetIdentifier: item.name,
			targetType: "metric",
			fabricLink: link,
		};
	});
}

export async function collectMetricDrift(
	input: CollectMetricDriftInput,
): Promise<CollectMetricDriftOutput> {
	const { projectId, organizationId } = input;
	const now = input.now ? new Date(input.now) : new Date();

	heartbeat("collectMetricDrift: starting");
	logger.info("[DailyBrief/collectMetricDrift] Starting", {
		projectId,
		organizationId,
	});

	const [metrics, project] = await Promise.all([
		db.projectSuccessMetric.findMany({
			where: { projectId, organizationId },
			orderBy: { createdAt: "asc" },
			select: {
				id: true,
				name: true,
				direction: true,
				target: true,
				lastValue: true,
				previousValue: true,
				lastObservedAt: true,
			},
		}),
		organizationId
			? db.organization.findUnique({
					where: { id: organizationId },
					select: { slug: true },
				})
			: Promise.resolve(null),
	]);

	const items: MetricDriftItem[] = [];
	for (const metric of metrics) {
		const reasons = evaluateMetricDrift(metric, now);
		if (reasons.length === 0) {
			continue;
		}
		items.push({
			metricId: metric.id,
			name: metric.name,
			direction: metric.direction,
			target: metric.target,
			lastValue: metric.lastValue,
			previousValue: metric.previousValue,
			lastObservedAt: metric.lastObservedAt,
			reasons,
		});
	}

	const link = metricsTabLink(projectId, project?.slug ?? null);
	const priorityActions = buildMetricDriftActions(items, link);

	logger.info("[DailyBrief/collectMetricDrift] Done", {
		projectId,
		metricCount: metrics.length,
		driftCount: items.length,
	});

	return { items, priorityActions };
}
