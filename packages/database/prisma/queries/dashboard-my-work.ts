/**
 * Dashboard "My Work" query
 *
 * Returns focused, actionable items for the current user across four buckets:
 *   - inProgress: features the user is actively working on
 *   - needsReview: documents/features awaiting review or sanity-check
 *   - blocked:     failed agent tasks, pipelines, or document generations
 *   - drafts:      projects/features the user has started but not returned to
 *
 * Tenant XOR: user context filters by { userId, organizationId: null };
 * organization context filters by { organizationId } and restricts to the
 * current user's assigned / owned items where relevant.
 */

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
	| "pipeline";

export interface MyWorkItem {
	id: string;
	kind: MyWorkItemKind;
	title: string;
	subtitle?: string | null;
	identifier?: string | null;
	projectId?: string | null;
	projectName?: string | null;
	status?: string | null;
	href: string;
	updatedAt: Date;
}

export interface MyWorkBucket {
	items: MyWorkItem[];
	total: number;
}

export interface MyWorkResult {
	inProgress: MyWorkBucket;
	needsReview: MyWorkBucket;
	blocked: MyWorkBucket;
	drafts: MyWorkBucket;
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

function pipelineHref(slug: string | null | undefined): string {
	return `${basePath(slug)}/projects`;
}

export interface GetMyWorkInput {
	userId: string;
	organizationId?: string | null;
	organizationSlug?: string | null;
	limit?: number;
}

export async function getMyWork({
	userId,
	organizationId,
	organizationSlug,
	limit = 6,
}: GetMyWorkInput): Promise<MyWorkResult> {
	const isOrg = Boolean(organizationId);

	// XOR tenant filter for resources owned directly by a user (project, doc, task, pipeline).
	// In user context: strictly personal (organizationId: null + userId).
	// In org context: scope to organizationId; most buckets also require the user to be
	// the owner/assignee so "My Work" remains personal even inside an org.
	const userScopedProject = isOrg
		? { organizationId, deletedAt: null, userId }
		: { organizationId: null, deletedAt: null, userId };

	// Scope for a UserStory assigned to the current user (stories don't carry
	// userId/organizationId directly — filter via the parent project).
	const storyProjectScope = isOrg
		? { organizationId, deletedAt: null }
		: { organizationId: null, deletedAt: null, userId };

	const [
		inProgressStories,
		needsReviewStories,
		needsReviewDocs,
		blockedTasks,
		blockedPipelines,
		blockedDocs,
		draftProjects,
		draftStories,
	] = await Promise.all([
		// ───── In Progress ─────────────────────────────────────────────
		findRecentMyWorkStories(
			{
				assigneeId: userId,
				project: storyProjectScope,
				draftingStage: { in: ["ACTIVE_ANALYSIS", "DRAFT"] },
			},
			limit,
		),

		// ───── Needs Review ────────────────────────────────────────────
		findRecentMyWorkStories(
			{
				assigneeId: userId,
				project: storyProjectScope,
				draftingStage: "SANITY_CHECK",
			},
			limit,
		),
		db.projectDocument.findMany({
			where: {
				...(isOrg
					? { organizationId }
					: { organizationId: null, userId }),
				status: "REVIEW",
			},
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

		// ───── Blocked ─────────────────────────────────────────────────
		db.agentTask.findMany({
			where: {
				userId,
				...(isOrg ? { organizationId } : { organizationId: null }),
				status: { in: ["failed", "error", "FAILED", "ERROR"] },
			},
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
		db.sDLCPipeline.findMany({
			where: {
				userId,
				...(isOrg ? { organizationId } : { organizationId: null }),
				status: { in: ["failed", "error", "FAILED", "ERROR"] },
			},
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				name: true,
				status: true,
				currentStage: true,
				updatedAt: true,
			},
		}),
		db.projectDocument.findMany({
			where: {
				...(isOrg
					? { organizationId }
					: { organizationId: null, userId }),
				status: "FAILED",
			},
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

		// ───── Drafts ──────────────────────────────────────────────────
		db.project.findMany({
			where: { ...userScopedProject, status: "DRAFT" },
			orderBy: { updatedAt: "desc" },
			take: limit,
			select: {
				id: true,
				name: true,
				updatedAt: true,
			},
		}),
		findRecentMyWorkStories(
			{
				assigneeId: userId,
				project: storyProjectScope,
				draftingStage: "PLACEHOLDER",
			},
			limit,
		),
	]);

	const inProgressItems: MyWorkItem[] = inProgressStories.map((s) => ({
		id: s.id,
		kind: "feature",
		title: s.title,
		identifier: s.identifier,
		projectId: s.projectId,
		projectName: s.project.name,
		status: s.status?.name ?? s.draftingStage,
		href: storyHref(organizationSlug, s.projectId, s.id),
		updatedAt: s.lastEditedAt ?? s.createdAt,
	}));

	const needsReviewItems: MyWorkItem[] = [
		...needsReviewStories.map<MyWorkItem>((s) => ({
			id: s.id,
			kind: "feature",
			title: s.title,
			identifier: s.identifier,
			projectId: s.projectId,
			projectName: s.project.name,
			status: "Sanity Check",
			href: storyHref(organizationSlug, s.projectId, s.id),
			updatedAt: s.lastEditedAt ?? s.createdAt,
		})),
		...needsReviewDocs.map<MyWorkItem>((d) => ({
			id: d.id,
			kind: "document",
			title: d.title,
			identifier: d.type,
			projectId: d.projectId,
			projectName: d.project.name,
			status: "Review",
			href: documentHref(organizationSlug, d.projectId, d.id),
			updatedAt: d.updatedAt,
		})),
	]
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
		.slice(0, limit);

	const blockedItems: MyWorkItem[] = [
		...blockedTasks.map<MyWorkItem>((t) => ({
			id: t.id,
			kind: "task",
			title: formatAgentName(t.agentId),
			subtitle: t.error ?? t.stage ?? null,
			status: "Failed",
			href: agentTaskHref(organizationSlug),
			updatedAt: t.updatedAt,
		})),
		...blockedPipelines.map<MyWorkItem>((p) => ({
			id: p.id,
			kind: "pipeline",
			title: p.name,
			subtitle: p.currentStage ?? null,
			status: "Failed",
			href: pipelineHref(organizationSlug),
			updatedAt: p.updatedAt,
		})),
		...blockedDocs.map<MyWorkItem>((d) => ({
			id: d.id,
			kind: "document",
			title: d.title,
			identifier: d.type,
			projectId: d.projectId,
			projectName: d.project.name,
			status: "Generation failed",
			href: documentHref(organizationSlug, d.projectId, d.id),
			updatedAt: d.updatedAt,
		})),
	]
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
		.slice(0, limit);

	const draftItems: MyWorkItem[] = [
		...draftProjects.map<MyWorkItem>((p) => ({
			id: p.id,
			kind: "project",
			title: p.name,
			status: "Draft",
			href: projectHref(organizationSlug, p.id),
			updatedAt: p.updatedAt,
		})),
		...draftStories.map<MyWorkItem>((s) => ({
			id: s.id,
			kind: "feature",
			title: s.title,
			identifier: s.identifier,
			projectId: s.projectId,
			projectName: s.project.name,
			status: "Placeholder",
			href: storyHref(organizationSlug, s.projectId, s.id),
			updatedAt: s.lastEditedAt ?? s.createdAt,
		})),
	]
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
		.slice(0, limit);

	return {
		inProgress: { items: inProgressItems, total: inProgressItems.length },
		needsReview: {
			items: needsReviewItems,
			total: needsReviewItems.length,
		},
		blocked: { items: blockedItems, total: blockedItems.length },
		drafts: { items: draftItems, total: draftItems.length },
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
		.replace(/\b\w/g, (l) => l.toUpperCase());
}
