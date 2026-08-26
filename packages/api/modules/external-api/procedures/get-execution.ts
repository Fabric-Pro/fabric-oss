/**
 * Get Execution Status
 *
 * Polls the status and result of an agent execution.
 * Tenant-isolated: execution must belong to the same tenant as the API key.
 */

import { config } from "@repo/config";
import { db } from "@repo/database";
import { getSignedUrl } from "@repo/storage";
import type { ExternalApiContext } from "../types";

/**
 * Validate that a storage path belongs to the caller's tenant.
 * Prevents cross-tenant artifact access via forged storagePath values.
 */
function isOwnedByTenant(
	storagePath: string,
	ctx: ExternalApiContext,
): boolean {
	const expectedPrefix = ctx.organizationId || ctx.userId;
	return storagePath.startsWith(`${expectedPrefix}/`);
}

export async function getExecution(
	executionId: string,
	ctx: ExternalApiContext,
) {
	const tenantFilter = ctx.organizationId
		? { organizationId: ctx.organizationId }
		: { userId: ctx.userId, organizationId: null };

	const execution = await db.agentDeploymentExecution.findFirst({
		where: {
			id: executionId,
			...tenantFilter,
		},
		select: {
			id: true,
			executionId: true,
			deploymentId: true,
			status: true,
			triggerType: true,
			priority: true,
			input: true,
			output: true,
			error: true,
			queuedAt: true,
			startedAt: true,
			completedAt: true,
			duration: true,
			inputTokens: true,
			outputTokens: true,
			totalCost: true,
			steps: {
				select: {
					stepNumber: true,
					stepType: true,
					name: true,
					status: true,
					startedAt: true,
					completedAt: true,
					duration: true,
				},
				orderBy: { stepNumber: "asc" },
			},
		},
	});

	if (!execution) {
		return null;
	}

	// Generate signed URLs for any artifacts in the output
	let artifacts:
		| Array<{
				id: string;
				name: string;
				mimeType: string;
				url: string;
		  }>
		| undefined;

	const output = execution.output as Record<string, unknown> | null;
	const rawArtifacts = output?.artifacts as
		| Array<{
				id: string;
				name: string;
				mimeType: string;
				storagePath: string;
		  }>
		| undefined;

	if (rawArtifacts && rawArtifacts.length > 0) {
		const bucket = config.storage.bucketNames.chatDocuments;
		artifacts = await Promise.all(
			rawArtifacts
				.filter((artifact) =>
					isOwnedByTenant(artifact.storagePath, ctx),
				)
				.map(async (artifact) => {
					const url = await getSignedUrl(artifact.storagePath, {
						bucket,
						expiresIn: 3600, // 1-hour expiry
					});
					return {
						id: artifact.id,
						name: artifact.name,
						mimeType: artifact.mimeType,
						url,
					};
				}),
		);
	}

	return {
		executionId: execution.id,
		status: execution.status,
		priority: execution.priority,
		input: execution.input,
		output: execution.output,
		error: execution.error,
		queuedAt: execution.queuedAt,
		startedAt: execution.startedAt,
		completedAt: execution.completedAt,
		durationMs: execution.duration,
		tokenUsage: {
			inputTokens: execution.inputTokens,
			outputTokens: execution.outputTokens,
			totalCost: execution.totalCost ? Number(execution.totalCost) : null,
		},
		steps: execution.steps,
		artifacts,
	};
}
