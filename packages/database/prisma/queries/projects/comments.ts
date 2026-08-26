import { db, type Prisma } from "../../client";

export type ProjectCommentAuthorType = "USER" | "AGENT";

/**
 * Stable id for the canonical Fabric Agent system user. Agent comment replies
 * are persisted with this id as `authorId` so they don't cascade-delete with
 * the user who summoned them. The seed/idempotent ensure helper creates the
 * row on first use.
 */
export const FABRIC_SYSTEM_USER_ID = "fabric-system";

export async function ensureFabricSystemUser() {
	return db.user.upsert({
		where: { id: FABRIC_SYSTEM_USER_ID },
		create: {
			id: FABRIC_SYSTEM_USER_ID,
			name: "Fabric",
			email: "fabric-system@fabric.local",
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		update: {},
		select: { id: true },
	});
}

export interface CreateStoryCommentInput {
	storyId: string;
	authorId: string;
	content: string;
	authorType?: ProjectCommentAuthorType;
	parentId?: string | null;
	sourceCommentId?: string | null;
	workflowId?: string | null;
	organizationId?: string | null;
	metadata?: Prisma.InputJsonValue;
}

export interface CreateTaskCommentInput {
	taskId: string;
	authorId: string;
	content: string;
	authorType?: ProjectCommentAuthorType;
	parentId?: string | null;
	sourceCommentId?: string | null;
	workflowId?: string | null;
	organizationId?: string | null;
	metadata?: Prisma.InputJsonValue;
}

const commentSelect = {
	id: true,
	content: true,
	authorType: true,
	authorId: true,
	parentId: true,
	sourceCommentId: true,
	workflowId: true,
	metadata: true,
	createdAt: true,
	updatedAt: true,
	author: {
		select: {
			id: true,
			name: true,
			image: true,
			email: true,
		},
	},
} as const;

export async function listStoryComments(input: {
	storyId: string;
	organizationId?: string | null;
}) {
	return db.userStoryComment.findMany({
		where: {
			storyId: input.storyId,
			organizationId: input.organizationId ?? null,
			deletedAt: null,
		},
		orderBy: { createdAt: "asc" },
		select: commentSelect,
	});
}

export async function listTaskComments(input: {
	taskId: string;
	organizationId?: string | null;
}) {
	return db.storyTaskComment.findMany({
		where: {
			taskId: input.taskId,
			organizationId: input.organizationId ?? null,
			deletedAt: null,
		},
		orderBy: { createdAt: "asc" },
		select: commentSelect,
	});
}

export async function createStoryComment(input: CreateStoryCommentInput) {
	return db.userStoryComment.create({
		data: {
			storyId: input.storyId,
			authorId: input.authorId,
			content: input.content,
			authorType: input.authorType ?? "USER",
			parentId: input.parentId ?? undefined,
			sourceCommentId: input.sourceCommentId ?? undefined,
			workflowId: input.workflowId ?? undefined,
			organizationId: input.organizationId ?? null,
			metadata: input.metadata,
		},
		select: commentSelect,
	});
}

export async function createTaskComment(input: CreateTaskCommentInput) {
	return db.storyTaskComment.create({
		data: {
			taskId: input.taskId,
			authorId: input.authorId,
			content: input.content,
			authorType: input.authorType ?? "USER",
			parentId: input.parentId ?? undefined,
			sourceCommentId: input.sourceCommentId ?? undefined,
			workflowId: input.workflowId ?? undefined,
			organizationId: input.organizationId ?? null,
			metadata: input.metadata,
		},
		select: commentSelect,
	});
}

const RECENT_DUPLICATE_WINDOW_MS = 10_000;

export async function findRecentDuplicateStoryComment(input: {
	storyId: string;
	authorId: string;
	content: string;
	organizationId?: string | null;
	parentId?: string | null;
}) {
	return db.userStoryComment.findFirst({
		where: {
			storyId: input.storyId,
			authorId: input.authorId,
			authorType: "USER",
			content: input.content,
			organizationId: input.organizationId ?? null,
			parentId: input.parentId ?? null,
			deletedAt: null,
			createdAt: {
				gte: new Date(Date.now() - RECENT_DUPLICATE_WINDOW_MS),
			},
		},
		orderBy: { createdAt: "desc" },
		select: commentSelect,
	});
}

export async function findRecentDuplicateTaskComment(input: {
	taskId: string;
	authorId: string;
	content: string;
	organizationId?: string | null;
	parentId?: string | null;
}) {
	return db.storyTaskComment.findFirst({
		where: {
			taskId: input.taskId,
			authorId: input.authorId,
			authorType: "USER",
			content: input.content,
			organizationId: input.organizationId ?? null,
			parentId: input.parentId ?? null,
			deletedAt: null,
			createdAt: {
				gte: new Date(Date.now() - RECENT_DUPLICATE_WINDOW_MS),
			},
		},
		orderBy: { createdAt: "desc" },
		select: commentSelect,
	});
}

export async function markStoryCommentWorkflowQueued(input: {
	commentId: string;
	workflowId: string;
	organizationId?: string | null;
	metadata?: Prisma.InputJsonValue;
}) {
	return db.userStoryComment.update({
		where: { id: input.commentId },
		data: {
			workflowId: input.workflowId,
			metadata: input.metadata,
		},
		select: commentSelect,
	});
}

export async function markTaskCommentWorkflowQueued(input: {
	commentId: string;
	workflowId: string;
	organizationId?: string | null;
	metadata?: Prisma.InputJsonValue;
}) {
	return db.storyTaskComment.update({
		where: { id: input.commentId },
		data: {
			workflowId: input.workflowId,
			metadata: input.metadata,
		},
		select: commentSelect,
	});
}

export async function getStoryCommentForAgentReply(input: {
	commentId: string;
	organizationId?: string | null;
}) {
	return db.userStoryComment.findFirst({
		where: {
			id: input.commentId,
			organizationId: input.organizationId ?? null,
			deletedAt: null,
		},
		include: {
			story: {
				include: {
					project: { select: { id: true, name: true } },
				},
			},
		},
	});
}

export async function getTaskCommentForAgentReply(input: {
	commentId: string;
	organizationId?: string | null;
}) {
	return db.storyTaskComment.findFirst({
		where: {
			id: input.commentId,
			organizationId: input.organizationId ?? null,
			deletedAt: null,
		},
		include: {
			task: {
				include: {
					story: {
						include: {
							project: { select: { id: true, name: true } },
						},
					},
				},
			},
		},
	});
}
