/**
 * Chat Artifact Database Queries
 *
 * CRUD operations for persisted chat artifacts (research reports, code,
 * documents, data). Uses XOR tenant isolation pattern.
 */

import { db } from "../client";

// =============================================================================
// Types
// =============================================================================

/** Artifact types matching the ChatArtifactType enum in schema */
export type ChatArtifactTypeValue =
	| "RESEARCH_REPORT"
	| "CODE"
	| "DOCUMENT"
	| "DATA"
	| "CHART"
	| "FILE"
	| "SUMMARY";

export interface CreateChatArtifactInput {
	userId: string;
	organizationId?: string | null;
	conversationId?: string;
	instanceId?: string;
	projectId?: string;
	type: ChatArtifactTypeValue;
	title: string;
	description?: string;
	content?: string;
	mimeType?: string;
	s3Path?: string;
	s3Bucket?: string;
	fileSize?: number;
	metadata?: Record<string, unknown>;
}

export interface ListChatArtifactsInput {
	userId: string;
	organizationId?: string | null;
	projectId?: string;
	conversationId?: string;
	type?: ChatArtifactTypeValue;
	limit?: number;
	offset?: number;
}

function buildArtifactTenantFilter(
	userId: string,
	organizationId?: string | null,
) {
	return organizationId
		? { userId, organizationId }
		: { userId, organizationId: null };
}

// =============================================================================
// Create
// =============================================================================

export async function createChatArtifact(input: CreateChatArtifactInput) {
	return (db as any).chatArtifact.create({
		data: {
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			conversationId: input.conversationId,
			instanceId: input.instanceId,
			projectId: input.projectId,
			type: input.type,
			title: input.title,
			description: input.description,
			content: input.content,
			mimeType: input.mimeType ?? "text/markdown",
			s3Path: input.s3Path,
			s3Bucket: input.s3Bucket,
			fileSize: input.fileSize,
			metadata: input.metadata ?? undefined,
		},
	});
}

// =============================================================================
// Read
// =============================================================================

export async function getChatArtifact(
	id: string,
	userId: string,
	organizationId?: string | null,
) {
	return (db as any).chatArtifact.findFirst({
		where: {
			id,
			...buildArtifactTenantFilter(userId, organizationId),
		},
	});
}

export async function listChatArtifacts(input: ListChatArtifactsInput) {
	const { userId, organizationId, projectId, conversationId, type } = input;
	const limit = input.limit ?? 50;
	const offset = input.offset ?? 0;

	// XOR tenant isolation
	const where: Record<string, unknown> = buildArtifactTenantFilter(
		userId,
		organizationId,
	);

	if (projectId) {
		where.projectId = projectId;
	}
	if (conversationId) {
		where.conversationId = conversationId;
	}
	if (type) {
		where.type = type;
	}

	const [artifacts, total] = await Promise.all([
		(db as any).chatArtifact.findMany({
			where,
			orderBy: { createdAt: "desc" },
			take: limit,
			skip: offset,
			select: {
				id: true,
				type: true,
				title: true,
				description: true,
				mimeType: true,
				fileSize: true,
				conversationId: true,
				projectId: true,
				indexedAt: true,
				createdAt: true,
				updatedAt: true,
			},
		}),
		(db as any).chatArtifact.count({ where }),
	]);

	return { artifacts, total };
}

// =============================================================================
// Update
// =============================================================================

export async function attachArtifactToProject(
	artifactId: string,
	projectId: string,
	userId: string,
	organizationId?: string | null,
) {
	return (db as any).chatArtifact.updateMany({
		where: {
			id: artifactId,
			...buildArtifactTenantFilter(userId, organizationId),
		},
		data: { projectId },
	});
}

export async function markArtifactIndexed(
	artifactId: string,
	qdrantId: string,
) {
	return (db as any).chatArtifact.update({
		where: { id: artifactId },
		data: {
			indexedAt: new Date(),
			qdrantId,
		},
	});
}

// =============================================================================
// Delete
// =============================================================================

export async function deleteChatArtifact(
	id: string,
	userId: string,
	organizationId?: string | null,
) {
	return (db as any).chatArtifact.deleteMany({
		where: {
			id,
			...buildArtifactTenantFilter(userId, organizationId),
		},
	});
}

export async function deleteProjectArtifacts(
	projectId: string,
	userId: string,
) {
	return (db as any).chatArtifact.deleteMany({
		where: { projectId, userId },
	});
}
