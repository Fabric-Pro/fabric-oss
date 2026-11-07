import { db, type Prisma } from "../client";
import { storySemanticActivityAt } from "./projects/story-semantic-activity";

const MY_WORK_STORY_SELECT = {
	id: true,
	identifier: true,
	title: true,
	projectId: true,
	createdAt: true,
	lastEditedAt: true,
	draftingStage: true,
	status: { select: { name: true } },
	project: { select: { name: true } },
} as const;

type MyWorkStoryRow = Prisma.UserStoryGetPayload<{
	select: typeof MY_WORK_STORY_SELECT;
}>;

async function findRecentMyWorkStories(
	where: Prisma.UserStoryWhereInput,
	limit: number,
): Promise<MyWorkStoryRow[]> {
	const [edited, created] = await Promise.all([
		db.userStory.findMany({
			where: { ...where, lastEditedAt: { not: null } },
			orderBy: { lastEditedAt: "desc" },
			take: limit,
			select: MY_WORK_STORY_SELECT,
		}),
		db.userStory.findMany({
			where: { ...where, lastEditedAt: null },
			orderBy: { createdAt: "desc" },
			take: limit,
			select: MY_WORK_STORY_SELECT,
		}),
	]);
	return [...edited, ...created]
		.sort(
			(a, b) =>
				storySemanticActivityAt(b).getTime() -
				storySemanticActivityAt(a).getTime(),
		)
		.slice(0, limit);
}

export type MyWorkItemKind =
	| "feature"
	| "document"
	| "project"
	| "task"
	| "codingRun";

export type MyWorkDeliveryStage =
	| "drafting"
	| "sanityCheck"
	| "readyForDev"
	| "implementing"
	| "review"
	| "blocked";

export interface MyWorkItem {
	id: string;
	kind: MyWorkItemKind;
	title: string;
	subtitle?: string | null;
	identifier?: string | null;
	projectId?: string | null;
	projectName?: string | null;
	status?: string | null;
	deliveryStage?: MyWorkDeliveryStage;
	href: string;
	updatedAt: Date;
}

export interface MyWorkBucket {
	items: MyWorkItem[];
	total: number;
}

export interface MyWorkProjectVisit {
	projectId: string;
	lastVisitedAt: Date | null;
}

export interface MyWorkResult {
	inProgress: MyWorkBucket;
	needsReview: MyWorkBucket;
	blocked: MyWorkBucket;
	drafts: MyWorkBucket;
	assignedFeatures: MyWorkBucket;
	projectCount: number;
	projectVisits: MyWorkProjectVisit[];
}

function basePath(organizationSlug?: string | null): string {
	return organizationSlug ? `/app/${organizationSlug}` : "/app";
}

function storyHref(
	slug: string | null | undefined,
	projectId: string,
	storyId: string,
): string {
	return `${basePath(slug)}/projects/${projectId}/stories/${storyId}`;
}

function documentHref(
	slug: string | null | undefined,
	projectId: string,
	documentId: string,
): string {
	return `${basePath(slug)}/projects/${projectId}/documents/${documentId}`;
}

function projectHref(
	slug: string | null | undefined,
	projectId: string,
): string {
	return `${basePath(slug)}/projects/${projectId}`;
}

function agentTaskHref(slug: string | null | undefined): string {
	return `${basePath(slug)}/agents?tab=tasks`;
}

export interface GetMyWorkInput {
	userId: string;
	organizationId?: string | null;
	organizationSlug?: string | null;
	limit?: number;
	featureStage?: "all" | MyWorkDeliveryStage;
	now?: Date;
}

export function reachableProjectScope(
	userId: string,
	organizationId: string | null | undefined,
	now: Date,
): Prisma.ProjectWhereInput {
	if (!organizationId) {
		return { organizationId: null, deletedAt: null, userId };
	}
	return {
		organizationId,
		deletedAt: null,
		OR: [
			{ userId },
			{
				members: {
					some: {
						userId,
						acceptedAt: { not: null },
						OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
					},
				},
			},
		],
	};
}

function storyItem(
	story: MyWorkStoryRow,
	organizationSlug: string | null | undefined,
	status?: string,
): MyWorkItem {
	return {
		id: story.id,
		kind: "feature",
		title: story.title,
		identifier: story.identifier,
		projectId: story.projectId,
		projectName: story.project.name,
		status: status ?? story.status?.name ?? story.draftingStage,
		deliveryStage: deliveryStage(story.draftingStage),
		href: storyHref(organizationSlug, story.projectId, story.id),
		updatedAt: story.lastEditedAt ?? story.createdAt,
	};
}

function deliveryStage(stage: string): MyWorkDeliveryStage {
	if (stage === "SANITY_CHECK") {
		return "sanityCheck";
	}
	if (stage === "PUBLISHED") {
		return "readyForDev";
	}
	return "drafting";
}

const CODING_RUN_SELECT = {
	id: true,
	status: true,
	lastError: true,
	updatedAt: true,
	storyId: true,
	story: {
		select: {
			identifier: true,
			title: true,
			projectId: true,
			project: { select: { name: true } },
		},
	},
} as const;

type CodingRunRow = Prisma.CodingRunGetPayload<{
	select: typeof CODING_RUN_SELECT;
}>;

function codingRunItem(
	run: CodingRunRow,
	organizationSlug: string | null | undefined,
	failed: boolean,
): MyWorkItem {
	const reviewStatus = {
		AWAITING_REVIEW: "Review run",
		PR_OPENED: "Pull request open",
		DEMO_READY: "Demo ready",
	} as const;
	return {
		id: run.id,
		kind: "codingRun",
		title: run.story.title,
		identifier: run.story.identifier,
		projectId: run.story.projectId,
		projectName: run.story.project.name,
		status: failed
			? "Run failed"
			: (reviewStatus[run.status as keyof typeof reviewStatus] ??
				"Review run"),
		subtitle: failed ? run.lastError : null,
		href: storyHref(organizationSlug, run.story.projectId, run.storyId),
		updatedAt: run.updatedAt,
	};
}

export async function getMyWork({
	userId,
	organizationId,
	organizationSlug,
	limit = 6,
	featureStage = "all",
	now = new Date(),
}: GetMyWorkInput): Promise<MyWorkResult> {
	const projectScope = reachableProjectScope(userId, organizationId, now);
	const storyScope = { assigneeId: userId, project: projectScope };
	const documentScope = {
		project: projectScope,
		OR: [{ userId }, { lastEditedBy: userId }],
	};
	const runScope = { userId, project: projectScope };
	const failedTaskWhere = {
		userId,
		...(organizationId ? { organizationId } : { organizationId: null }),
		status: { in: ["failed", "error", "FAILED", "ERROR"] },
	};
	const reviewRunWhere: Prisma.CodingRunWhereInput = {
		...runScope,
		status: { in: ["AWAITING_REVIEW", "PR_OPENED", "DEMO_READY"] },
	};
	const blockedRunWhere: Prisma.CodingRunWhereInput = {
		...runScope,
		status: { in: ["FAILED", "TERMINATED_STALE"] },
	};
	const openStage = {
		notIn: ["DECLINED", "CLOSED"] as Array<"DECLINED" | "CLOSED">,
	};
	const assignedFeaturesWhere: Prisma.UserStoryWhereInput = {
		...storyScope,
		...(featureStage === "blocked"
			? { blocked: true, draftingStage: openStage }
			: featureStage === "implementing"
				? {
						draftingStage: openStage,
						codingRuns: {
							some: {
								status: {
									in: ["QUEUED", "STARTING", "RUNNING"],
								},
							},
						},
					}
				: featureStage === "review"
					? {
							draftingStage: openStage,
							codingRuns: {
								some: {
									status: {
										in: [
											"AWAITING_REVIEW",
											"PR_OPENED",
											"DEMO_READY",
										],
									},
								},
							},
						}
					: {
							draftingStage:
								featureStage === "all"
									? openStage
									: featureStage === "sanityCheck"
										? "SANITY_CHECK"
										: featureStage === "readyForDev"
											? "PUBLISHED"
											: {
													notIn: [
														"SANITY_CHECK",
														"PUBLISHED",
														"DECLINED",
														"CLOSED",
													],
												},
						}),
	};

	const [
		inProgressStories,
		needsReviewStories,
		needsReviewDocs,
		reviewRuns,
		blockedTasks,
		blockedDocs,
		blockedRuns,
		draftProjects,
		draftStories,
		assignedFeatures,
		inProgressTotal,
		reviewStoriesTotal,
		reviewDocsTotal,
		reviewRunsTotal,
		blockedTasksTotal,
		blockedDocsTotal,
		blockedRunsTotal,
		draftProjectsTotal,
		draftStoriesTotal,
		assignedFeaturesTotal,
		projectCount,
		projectVisits,
	] = await Promise.all([
		findRecentMyWorkStories(
			{
				...storyScope,
				draftingStage: { in: ["ACTIVE_ANALYSIS", "DRAFT"] },
			},
			limit,
		),
		findRecentMyWorkStories(
			{ ...storyScope, draftingStage: "SANITY_CHECK" },
			limit,
		),
		db.projectDocument.findMany({
			where: { ...documentScope, status: "REVIEW" },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				title: true,
				type: true,
				projectId: true,
				updatedAt: true,
				project: { select: { name: true } },
			},
		}),
		db.codingRun.findMany({
			where: reviewRunWhere,
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: CODING_RUN_SELECT,
		}),
		db.agentTask.findMany({
			where: failedTaskWhere,
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				agentId: true,
				status: true,
				stage: true,
				error: true,
				updatedAt: true,
			},
		}),
		db.projectDocument.findMany({
			where: { ...documentScope, status: "FAILED" },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				title: true,
				type: true,
				projectId: true,
				updatedAt: true,
				project: { select: { name: true } },
			},
		}),
		db.codingRun.findMany({
			where: blockedRunWhere,
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: CODING_RUN_SELECT,
		}),
		db.project.findMany({
			where: { ...projectScope, userId, status: "DRAFT" },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: { id: true, name: true, updatedAt: true },
		}),
		findRecentMyWorkStories(
			{ ...storyScope, draftingStage: "PLACEHOLDER" },
			limit,
		),
		findRecentMyWorkStories(assignedFeaturesWhere, limit),
		db.userStory.count({
			where: {
				...storyScope,
				draftingStage: { in: ["ACTIVE_ANALYSIS", "DRAFT"] },
			},
		}),
		db.userStory.count({
			where: { ...storyScope, draftingStage: "SANITY_CHECK" },
		}),
		db.projectDocument.count({
			where: { ...documentScope, status: "REVIEW" },
		}),
		db.codingRun.count({ where: reviewRunWhere }),
		db.agentTask.count({ where: failedTaskWhere }),
		db.projectDocument.count({
			where: { ...documentScope, status: "FAILED" },
		}),
		db.codingRun.count({ where: blockedRunWhere }),
		db.project.count({
			where: { ...projectScope, userId, status: "DRAFT" },
		}),
		db.userStory.count({
			where: { ...storyScope, draftingStage: "PLACEHOLDER" },
		}),
		db.userStory.count({ where: assignedFeaturesWhere }),
		db.project.count({ where: projectScope }),
		db.projectUserPreference.findMany({
			where: { userId, project: projectScope },
			orderBy: { lastVisitedAt: { sort: "desc", nulls: "last" } },
			take: 50,
			select: { projectId: true, lastVisitedAt: true },
		}),
	]);

	const needsReviewItems: MyWorkItem[] = [
		...needsReviewStories.map((story) =>
			storyItem(story, organizationSlug, "Sanity Check"),
		),
		...needsReviewDocs.map<MyWorkItem>((document) => ({
			id: document.id,
			kind: "document",
			title: document.title,
			identifier: document.type,
			projectId: document.projectId,
			projectName: document.project.name,
			status: "Review",
			href: documentHref(
				organizationSlug,
				document.projectId,
				document.id,
			),
			updatedAt: document.updatedAt,
		})),
		...reviewRuns.map((run) => codingRunItem(run, organizationSlug, false)),
	]
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
		.slice(0, limit);

	const blockedItems: MyWorkItem[] = [
		...blockedTasks.map<MyWorkItem>((task) => ({
			id: task.id,
			kind: "task",
			title: formatAgentName(task.agentId),
			subtitle: task.error ?? task.stage ?? null,
			status: "Failed",
			href: agentTaskHref(organizationSlug),
			updatedAt: task.updatedAt,
		})),
		...blockedDocs.map<MyWorkItem>((document) => ({
			id: document.id,
			kind: "document",
			title: document.title,
			identifier: document.type,
			projectId: document.projectId,
			projectName: document.project.name,
			status: "Generation failed",
			href: documentHref(
				organizationSlug,
				document.projectId,
				document.id,
			),
			updatedAt: document.updatedAt,
		})),
		...blockedRuns.map((run) => codingRunItem(run, organizationSlug, true)),
	]
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
		.slice(0, limit);

	const draftItems: MyWorkItem[] = [
		...draftProjects.map<MyWorkItem>((project) => ({
			id: project.id,
			kind: "project",
			title: project.name,
			status: "Draft",
			href: projectHref(organizationSlug, project.id),
			updatedAt: project.updatedAt,
		})),
		...draftStories.map((story) =>
			storyItem(story, organizationSlug, "Placeholder"),
		),
	]
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
		.slice(0, limit);

	return {
		inProgress: {
			items: inProgressStories.map((story) =>
				storyItem(story, organizationSlug),
			),
			total: inProgressTotal,
		},
		needsReview: {
			items: needsReviewItems,
			total: reviewStoriesTotal + reviewDocsTotal + reviewRunsTotal,
		},
		blocked: {
			items: blockedItems,
			total: blockedTasksTotal + blockedDocsTotal + blockedRunsTotal,
		},
		drafts: {
			items: draftItems,
			total: draftProjectsTotal + draftStoriesTotal,
		},
		assignedFeatures: {
			items: assignedFeatures.map((story) =>
				storyItem(story, organizationSlug),
			),
			total: assignedFeaturesTotal,
		},
		projectCount,
		projectVisits,
	};
}

function formatAgentName(agentId: string): string {
	if (
		agentId === "orchestrator" ||
		agentId === "fabric-ai" ||
		agentId === "fabric_ai"
	) {
		return "Fabric AI";
	}
	return agentId
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
