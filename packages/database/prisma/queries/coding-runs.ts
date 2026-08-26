/**
 * Coding Runs Queries
 *
 * Database queries for CodingRun and CodingRunEvent models.
 * All queries follow the XOR tenant isolation pattern:
 * - Personal context: userId is set, organizationId is NULL
 * - Org context: organizationId is set
 */

import { db } from "../client";
import type {
	CodingRunExecutionChannel,
	CodingRunProvider,
	CodingRunStatus,
	Prisma,
} from "../generated/client";

function getTenantFilter(params: {
	userId: string;
	organizationId?: string | null;
}) {
	if (params.organizationId) {
		return { organizationId: params.organizationId };
	}
	return { userId: params.userId, organizationId: null };
}

export async function createCodingRun(params: {
	projectId: string;
	storyId: string;
	storyTaskId?: string;
	userId: string;
	organizationId?: string | null;
	weaveExecutionId?: string;
	executionChannel?: CodingRunExecutionChannel;
	provider?: CodingRunProvider;
	repositoryUrl?: string;
	repositoryOwner?: string;
	repositoryName?: string;
	targetBranch?: string;
	workingDirectory?: string;
	externalUrl?: string;
	externalStatus?: string;
	providerMetadata?: Prisma.InputJsonValue;
	promptText?: string;
	workflowId?: string;
}) {
	return db.codingRun.create({
		data: {
			projectId: params.projectId,
			storyId: params.storyId,
			storyTaskId: params.storyTaskId,
			userId: params.userId,
			organizationId: params.organizationId ?? undefined,
			weaveExecutionId: params.weaveExecutionId,
			executionChannel: params.executionChannel ?? "BACKGROUND_AGENTS",
			provider: params.provider ?? "BACKGROUND_AGENTS",
			repositoryUrl: params.repositoryUrl,
			repositoryOwner: params.repositoryOwner,
			repositoryName: params.repositoryName,
			targetBranch: params.targetBranch,
			workingDirectory: params.workingDirectory,
			externalUrl: params.externalUrl,
			externalStatus: params.externalStatus,
			providerMetadata: params.providerMetadata,
			promptText: params.promptText,
			workflowId: params.workflowId,
		},
	});
}

export async function getCodingRun(
	id: string,
	userId: string,
	organizationId?: string | null,
) {
	const tenantFilter = getTenantFilter({ userId, organizationId });
	return db.codingRun.findFirst({
		where: { id, ...tenantFilter },
		include: {
			events: { orderBy: { createdAt: "asc" } },
			story: { select: { id: true, title: true, identifier: true } },
			storyTask: { select: { id: true, title: true, identifier: true } },
		},
	});
}

export async function listCodingRunsForStory(
	storyId: string,
	userId: string,
	organizationId?: string | null,
) {
	const tenantFilter = getTenantFilter({ userId, organizationId });
	return db.codingRun.findMany({
		where: { storyId, ...tenantFilter },
		include: {
			storyTask: { select: { id: true, title: true, identifier: true } },
		},
		orderBy: { createdAt: "desc" },
	});
}

export async function listCodingRunsForTask(
	storyTaskId: string,
	userId: string,
	organizationId?: string | null,
) {
	const tenantFilter = getTenantFilter({ userId, organizationId });
	return db.codingRun.findMany({
		where: { storyTaskId, ...tenantFilter },
		orderBy: { createdAt: "desc" },
	});
}

export async function updateCodingRunStatus(
	id: string,
	status: CodingRunStatus,
	data?: {
		providerSessionId?: string;
		pullRequestUrl?: string;
		pullRequestNumber?: number;
		pullRequestBranch?: string;
		externalUrl?: string;
		externalStatus?: string;
		providerMetadata?: Prisma.InputJsonValue;
	},
) {
	return db.codingRun.update({
		where: { id },
		data: {
			status,
			...data,
		},
	});
}

export async function addCodingRunEvent(
	codingRunId: string,
	eventType: string,
	payload?: Record<string, unknown>,
	providerEventId?: string,
) {
	return db.codingRunEvent.create({
		data: {
			codingRunId,
			eventType,
			payloadJson: (payload as Prisma.InputJsonValue) ?? undefined,
			providerEventId,
		},
	});
}

export async function getLatestCodingRunForStory(
	storyId: string,
	userId: string,
	organizationId?: string | null,
) {
	const tenantFilter = getTenantFilter({ userId, organizationId });
	return db.codingRun.findFirst({
		where: { storyId, ...tenantFilter },
		orderBy: { createdAt: "desc" },
		select: {
			id: true,
			weaveExecutionId: true,
			executionChannel: true,
			provider: true,
			status: true,
			providerSessionId: true,
			pullRequestUrl: true,
			pullRequestNumber: true,
			externalUrl: true,
			createdAt: true,
		},
	});
}
