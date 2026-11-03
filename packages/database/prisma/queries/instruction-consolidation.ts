/**
 * Moving a code repository's AI files into a separate instructions
 * repository (specs/2026-10-21-ai-artifacts-hub §5.2, P4). One row per run;
 * the newest row is the project's current state. USER_OWNED and
 * project-scoped: writes copy the parent project's tenancy, reads filter by
 * projectId, and callers resolve project access before calling in.
 */

import {
	db,
	type InstructionConsolidation,
	type InstructionConsolidationStatus,
	type Prisma,
} from "../client";

export type InstructionConsolidationStep =
	| "CREATED"
	| "COPYING"
	| "CONFIGURING"
	| "CLEANUP"
	| "DONE";

/** One confirmed file: `to` null removes an identical duplicate only. */
export type InstructionConsolidationFile = {
	from: string;
	to: string | null;
	transform?: "scope-header";
};

export async function createInstructionConsolidation(input: {
	projectId: string;
	userId: string;
	organizationId: string | null;
	sourceIntegrationId: string;
	targetIntegrationId: string;
	targetRepositoryUrl: string;
	files: InstructionConsolidationFile[];
}): Promise<InstructionConsolidation> {
	return db.instructionConsolidation.create({
		data: {
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId,
			sourceIntegrationId: input.sourceIntegrationId,
			targetIntegrationId: input.targetIntegrationId,
			targetRepositoryUrl: input.targetRepositoryUrl,
			files: input.files as unknown as Prisma.InputJsonArray,
			fileCount: input.files.length,
		},
	});
}

export async function getInstructionConsolidation(
	id: string,
	projectId: string,
): Promise<InstructionConsolidation | null> {
	return db.instructionConsolidation.findFirst({ where: { id, projectId } });
}

export async function getLatestInstructionConsolidation(
	projectId: string,
): Promise<InstructionConsolidation | null> {
	return db.instructionConsolidation.findFirst({
		where: { projectId },
		orderBy: { createdAt: "desc" },
	});
}

/** A run still in progress blocks a second one for the same project. */
export async function getRunningInstructionConsolidation(
	projectId: string,
): Promise<InstructionConsolidation | null> {
	return db.instructionConsolidation.findFirst({
		where: { projectId, status: "RUNNING" },
		orderBy: { createdAt: "desc" },
	});
}

export async function updateInstructionConsolidation(
	id: string,
	projectId: string,
	data: {
		status?: InstructionConsolidationStatus;
		step?: InstructionConsolidationStep;
		sourceCommitSha?: string;
		copiedCommitSha?: string;
		cleanupPullRequestUrl?: string;
		error?: string | null;
	},
): Promise<void> {
	await db.instructionConsolidation.updateMany({
		where: { id, projectId },
		data,
	});
}
