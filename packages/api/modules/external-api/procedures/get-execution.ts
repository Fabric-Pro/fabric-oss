/**
 * Get Execution Status
 *
 * Polls the status and result of an agent execution.
 * Tenant-isolated: execution must belong to the same tenant as the API key.
 */

import { config } from "@repo/config";
import {
	db,
	getAgentTemplateInstanceForRead,
	getProjectAccessContext,
	isProjectSoftDeleted,
	readAgentExecutionAdmission,
} from "@repo/database";
import { getSignedUrl } from "@repo/storage";
import { readNativeExecutionState } from "../lib/native-execution-state";
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

export async function canReadAgentExecution(
	executionId: string,
	ctx: ExternalApiContext,
) {
	if (!ctx.organizationId) {
		return false;
	}
	const row = await db.agentDeploymentExecution.findFirst({
		where: {
			id: executionId,
			userId: ctx.userId,
			organizationId: ctx.organizationId,
		},
		select: {
			metadata: true,
			deployment: {
				select: {
					instanceId: true,
					userId: true,
					organizationId: true,
				},
			},
		},
	});
	if (
		!row ||
		row.deployment.userId !== ctx.userId ||
		row.deployment.organizationId !== ctx.organizationId
	) {
		return false;
	}
	const scoped = await getAgentTemplateInstanceForRead({
		instanceId: row.deployment.instanceId,
		userId: ctx.userId,
		organizationId: ctx.organizationId,
	});
	if (
		!scoped ||
		(ctx.boundProjectId && scoped.projectId !== ctx.boundProjectId)
	) {
		return false;
	}
	const admittedProject =
		readAgentExecutionAdmission(row)?.dispatch.projectId;
	if (admittedProject) {
		if (ctx.boundProjectId && ctx.boundProjectId !== admittedProject) {
			return false;
		}
		const access = await getProjectAccessContext(
			admittedProject,
			ctx.userId,
		);
		if (
			access?.organizationId !== ctx.organizationId ||
			(await isProjectSoftDeleted(admittedProject))
		) {
			return false;
		}
	}
	return true;
}

/** Revalidate before every emitted chunk; cancelling the transform cancels its source. */
export function authorizeAgentExecutionStream(
	stream: ReadableStream<Uint8Array>,
	executionId: string,
	ctx: ExternalApiContext,
) {
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			async transform(chunk, controller) {
				if (!(await canReadAgentExecution(executionId, ctx))) {
					throw new Error("Execution access revoked");
				}
				controller.enqueue(chunk);
			},
		}),
	);
}

export async function getExecution(
	executionId: string,
	ctx: ExternalApiContext,
) {
	if (!ctx.scopes.includes("agents:read") && !ctx.scopes.includes("*")) {
		return null;
	}
	if (!(await canReadAgentExecution(executionId, ctx))) {
		return null;
	}
	const tenantFilter = {
		organizationId: ctx.organizationId,
		userId: ctx.userId,
	};

	const execution = await db.agentDeploymentExecution.findFirst({
		where: {
			id: executionId,
			...tenantFilter,
		},
		select: {
			id: true,
			executionId: true,
			deploymentId: true,
			userId: true,
			organizationId: true,
			metadata: true,
			workflowId: true,
			runId: true,
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
	const native = await readNativeExecutionState(execution);
	// A role, project grant or binding may change while Temporal is being read.
	if (!(await canReadAgentExecution(executionId, ctx))) {
		return null;
	}
	const nativeStateAvailable = native.status !== undefined;
	const archived = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(
		execution.status,
	);
	const status = native.status ?? (archived ? execution.status : "UNKNOWN");
	const output = nativeStateAvailable
		? (native.output ?? null)
		: execution.output;

	// Generate signed URLs for any artifacts in the output
	let artifacts:
		| Array<{
				id: string;
				name: string;
				mimeType: string;
				url: string;
		  }>
		| undefined;

	// Retain archived artifacts even when the authoritative result is newer than
	// the row projection. Every storage path is still checked before signing.
	const rawArtifacts = [execution.output, native.output].flatMap((value) => {
		const items = (value as Record<string, unknown> | null)?.artifacts;
		if (!Array.isArray(items)) {
			return [];
		}
		return items.filter(
			(
				artifact,
			): artifact is {
				id: string;
				name: string;
				mimeType: string;
				storagePath: string;
			} =>
				artifact !== null &&
				typeof artifact === "object" &&
				typeof artifact.id === "string" &&
				typeof artifact.name === "string" &&
				typeof artifact.mimeType === "string" &&
				typeof artifact.storagePath === "string",
		);
	});

	if (rawArtifacts && rawArtifacts.length > 0) {
		const bucket = config.storage.bucketNames.chatDocuments;
		artifacts = await Promise.all(
			rawArtifacts
				.filter(
					(artifact, index, all) =>
						all.findIndex(
							(item) => item.storagePath === artifact.storagePath,
						) === index,
				)
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

	if (!(await canReadAgentExecution(executionId, ctx))) {
		return null;
	}

	return {
		executionId: execution.id,
		deploymentId: execution.deploymentId,
		workflowId: execution.workflowId,
		runId: native.runId ?? execution.runId,
		admissionStatus:
			native.runId || execution.runId || archived
				? "CONFIRMED"
				: "UNRESOLVED",
		status,
		executionStateSource: nativeStateAvailable ? "temporal" : "database",
		nativeStateAvailable,
		nativeReadStatus: native.nativeReadStatus,
		lastRecordedStatus: execution.status,
		progress: native.progress,
		result: native.result,
		priority: execution.priority,
		input: execution.input,
		output,
		error: nativeStateAvailable ? (native.error ?? null) : execution.error,
		queuedAt: execution.queuedAt,
		startedAt: native.startedAt ?? execution.startedAt,
		completedAt: nativeStateAvailable
			? (native.completedAt ?? null)
			: execution.completedAt,
		durationMs: nativeStateAvailable
			? (native.durationMs ?? null)
			: execution.duration,
		tokenUsage: {
			inputTokens: execution.inputTokens,
			outputTokens: execution.outputTokens,
			totalCost: execution.totalCost ? Number(execution.totalCost) : null,
		},
		steps: execution.steps,
		artifacts,
	};
}
