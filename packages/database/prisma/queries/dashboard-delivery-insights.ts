import { db } from "../client";
import type { CodingRunStatus } from "../generated/client";
import { reachableProjectScope } from "./dashboard-my-work";

export type DeliveryInsightsRange = 7 | 30 | 90;
export type DeliveryFlowStage =
	| "drafting"
	| "sanityCheck"
	| "readyForDev"
	| "implementing"
	| "review"
	| "blocked";

export interface DeliveryInsightStory {
	createdAt: Date;
	draftingStage: string;
	draftingStageUpdatedAt: Date | null;
	blocked: boolean;
	versions: Array<{ createdAt: Date }>;
	codingRuns: Array<{ status: string }>;
}

export interface DeliveryRunGroup {
	status: string;
	count: number;
}

export interface DeliveryInsightsResult {
	hasData: boolean;
	timeline: Array<{ date: string; scope: number; ready: number }>;
	flow: Array<{ stage: DeliveryFlowStage; count: number }>;
	agentOutcomes: Array<{
		status: "active" | "completed" | "review" | "failed" | "cancelled";
		count: number;
	}>;
	summary: {
		createdInRange: number;
		readyInRange: number;
		previousReady: number;
		medianReadyDays: number | null;
		readyDurationSamples: number;
		runsNeedingAttention: number;
		reviewRuns: number;
		failedRuns: number;
	};
	generatedAt: Date;
}

const FLOW_STAGES: DeliveryFlowStage[] = [
	"drafting",
	"sanityCheck",
	"readyForDev",
	"implementing",
	"review",
	"blocked",
];
const REVIEW_STATUSES: CodingRunStatus[] = [
	"AWAITING_REVIEW",
	"PR_OPENED",
	"DEMO_READY",
];
const ACTIVE_STATUSES: CodingRunStatus[] = ["QUEUED", "STARTING", "RUNNING"];
const FAILED_STATUSES: CodingRunStatus[] = ["FAILED", "TERMINATED_STALE"];
const ATTENTION_STATUSES: CodingRunStatus[] = [
	...REVIEW_STATUSES,
	...FAILED_STATUSES,
];
const DAY_MS = 24 * 60 * 60 * 1000;

function utcDayStart(date: Date): Date {
	return new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
	);
}

function addUtcDays(date: Date, days: number): Date {
	const result = new Date(date);
	result.setUTCDate(result.getUTCDate() + days);
	return result;
}

function dateKey(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function countStatuses(groups: DeliveryRunGroup[], statuses: string[]): number {
	return groups
		.filter((group) => statuses.includes(group.status))
		.reduce((total, group) => total + group.count, 0);
}

function firstReadyAt(story: DeliveryInsightStory): Date | null {
	const version = story.versions[0];
	if (version) {
		return version.createdAt;
	}
	return story.draftingStage === "PUBLISHED"
		? story.draftingStageUpdatedAt
		: null;
}

function median(values: number[]): number | null {
	if (values.length === 0) {
		return null;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const value =
		sorted.length % 2 === 0
			? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
			: (sorted[middle] ?? 0);
	return Math.round(value * 10) / 10;
}

export function buildDeliveryInsights(input: {
	stories: DeliveryInsightStory[];
	outcomeGroups: DeliveryRunGroup[];
	attentionGroups: DeliveryRunGroup[];
	days: number;
	now: Date;
}): DeliveryInsightsResult {
	const { stories, outcomeGroups, attentionGroups, days, now } = input;
	const rangeStart = addUtcDays(utcDayStart(now), -(days - 1));
	const periodEnd = addUtcDays(rangeStart, days);
	const previousStart = addUtcDays(rangeStart, -days);
	const readyEvents = stories
		.map((story) => ({
			createdAt: story.createdAt,
			readyAt: firstReadyAt(story),
		}))
		.filter(
			(event): event is { createdAt: Date; readyAt: Date } =>
				event.readyAt !== null,
		);
	const createdInRange = stories.filter(
		(story) => story.createdAt >= rangeStart && story.createdAt < periodEnd,
	).length;
	const currentReady = readyEvents.filter(
		(event) => event.readyAt >= rangeStart && event.readyAt < periodEnd,
	);
	const previousReady = readyEvents.filter(
		(event) => event.readyAt >= previousStart && event.readyAt < rangeStart,
	).length;

	let scope = stories.filter((story) => story.createdAt < rangeStart).length;
	let ready = readyEvents.filter(
		(event) => event.readyAt < rangeStart,
	).length;
	const timeline = Array.from({ length: days }, (_, index) => {
		const day = addUtcDays(rangeStart, index);
		const nextDay = addUtcDays(day, 1);
		scope += stories.filter(
			(story) => story.createdAt >= day && story.createdAt < nextDay,
		).length;
		ready += readyEvents.filter(
			(event) => event.readyAt >= day && event.readyAt < nextDay,
		).length;
		return { date: dateKey(day), scope, ready };
	});

	const flowCounts = new Map<DeliveryFlowStage, number>(
		FLOW_STAGES.map((stage) => [stage, 0]),
	);
	for (const story of stories) {
		if (["DECLINED", "CLOSED"].includes(story.draftingStage)) {
			continue;
		}
		const runStatuses = story.codingRuns.map((run) => run.status);
		let stage: DeliveryFlowStage = "drafting";
		if (story.blocked) {
			stage = "blocked";
		} else if (
			runStatuses.some((status) =>
				REVIEW_STATUSES.some((candidate) => candidate === status),
			)
		) {
			stage = "review";
		} else if (
			runStatuses.some((status) =>
				ACTIVE_STATUSES.some((candidate) => candidate === status),
			)
		) {
			stage = "implementing";
		} else if (story.draftingStage === "SANITY_CHECK") {
			stage = "sanityCheck";
		} else if (story.draftingStage === "PUBLISHED") {
			stage = "readyForDev";
		}
		flowCounts.set(stage, (flowCounts.get(stage) ?? 0) + 1);
	}

	const reviewRuns = countStatuses(attentionGroups, REVIEW_STATUSES);
	const failedRuns = countStatuses(attentionGroups, FAILED_STATUSES);
	const outcomeDefinitions = [
		{ status: "active" as const, statuses: ACTIVE_STATUSES },
		{ status: "completed" as const, statuses: ["COMPLETED"] },
		{ status: "review" as const, statuses: REVIEW_STATUSES },
		{ status: "failed" as const, statuses: FAILED_STATUSES },
		{ status: "cancelled" as const, statuses: ["CANCELLED"] },
	];
	const agentOutcomes = outcomeDefinitions.map((definition) => ({
		status: definition.status,
		count: countStatuses(outcomeGroups, definition.statuses),
	}));

	return {
		hasData:
			stories.length > 0 ||
			outcomeGroups.some((group) => group.count > 0) ||
			attentionGroups.some((group) => group.count > 0),
		timeline,
		flow: FLOW_STAGES.map((stage) => ({
			stage,
			count: flowCounts.get(stage) ?? 0,
		})),
		agentOutcomes,
		summary: {
			createdInRange,
			readyInRange: currentReady.length,
			previousReady,
			medianReadyDays: median(
				currentReady.map((event) =>
					Math.max(
						0,
						(event.readyAt.getTime() - event.createdAt.getTime()) /
							DAY_MS,
					),
				),
			),
			readyDurationSamples: currentReady.length,
			runsNeedingAttention: reviewRuns + failedRuns,
			reviewRuns,
			failedRuns,
		},
		generatedAt: now,
	};
}

const DELIVERY_STORY_SELECT = {
	createdAt: true,
	draftingStage: true,
	draftingStageUpdatedAt: true,
	blocked: true,
	versions: {
		where: { draftingStage: "PUBLISHED" },
		orderBy: { createdAt: "asc" },
		take: 1,
		select: { createdAt: true },
	},
	codingRuns: { select: { status: true } },
} as const;

export async function getDeliveryInsights(input: {
	userId: string;
	organizationId: string;
	days: DeliveryInsightsRange;
	now?: Date;
}): Promise<DeliveryInsightsResult> {
	const now = input.now ?? new Date();
	const rangeStart = addUtcDays(utcDayStart(now), -(input.days - 1));
	const projectScope = reachableProjectScope(
		input.userId,
		input.organizationId,
		now,
	);
	const runScope = { userId: input.userId, project: projectScope };
	const [stories, rawOutcomeGroups, rawAttentionGroups] = await Promise.all([
		db.userStory.findMany({
			where: { assigneeId: input.userId, project: projectScope },
			select: DELIVERY_STORY_SELECT,
		}),
		db.codingRun.groupBy({
			by: ["status"],
			where: { ...runScope, updatedAt: { gte: rangeStart } },
			_count: { _all: true },
		}),
		db.codingRun.groupBy({
			by: ["status"],
			where: { ...runScope, status: { in: ATTENTION_STATUSES } },
			_count: { _all: true },
		}),
	]);
	const normalizeGroups = (
		groups: Array<{ status: string; _count: { _all: number } }>,
	): DeliveryRunGroup[] =>
		groups.map((group) => ({
			status: group.status,
			count: group._count._all,
		}));

	return buildDeliveryInsights({
		stories,
		outcomeGroups: normalizeGroups(rawOutcomeGroups),
		attentionGroups: normalizeGroups(rawAttentionGroups),
		days: input.days,
		now,
	});
}
