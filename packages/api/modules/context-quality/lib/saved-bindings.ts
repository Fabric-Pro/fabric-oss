import { createHash } from "node:crypto";
import {
	db,
	deleteSettledContextQualityRunsForProject,
	disableContextQualityBinding,
	fetchContextQualityExecutionCredentials,
	getContextQualityBinding,
	saveContextQualityBinding,
} from "@repo/database";
import {
	computeDatabricksEvaluationPrincipalFingerprint,
	createOAuthM2MProvider,
	DatabricksApiClient,
	inspectDatabricksEvaluationJob,
	validateDatabricksWorkspaceOrigin,
} from "@repo/databricks";
import {
	SavedEvaluationError,
	savedEvaluationBindingSchema,
} from "../saved-contracts";
import type { ContextQualityActor } from "./commands";
import { requireSavedEvaluationAccess } from "./saved-access";

export async function getSavedEvaluationBinding(actor: ContextQualityActor) {
	await requireSavedEvaluationAccess(actor, "configure");
	const [binding, candidates] = await Promise.all([
		getContextQualityBinding(actor),
		db.workflowIntegration.findMany({
			where: {
				organizationId: actor.organizationId,
				provider: "DATABRICKS_PLATFORM",
				isActive: true,
				workflowId: null,
				usageScope: "ORGANIZATION_SHARED",
			},
			select: { id: true, name: true, userId: true },
			orderBy: { createdAt: "desc" },
			take: 100,
		}),
	]);
	const members = await db.member.findMany({
		where: {
			organizationId: actor.organizationId,
			userId: { in: candidates.map((row) => row.userId) },
		},
		select: { userId: true },
	});
	const owners = new Set(members.map((row) => row.userId));
	const connections = candidates
		.filter((row) => owners.has(row.userId))
		.map((row) => ({ id: row.id, name: row.name }));
	return {
		connections,
		binding: binding
			? {
					id: binding.id,
					integrationId: binding.integrationId,
					workspaceOrigin: binding.workspaceOrigin,
					jobId: binding.jobId,
					experimentId: binding.experimentId,
					volumeRoot: binding.volumeRoot,
					notebookPath: binding.notebookPath,
					notebookSha256: binding.notebookSha256,
					enabled: binding.isEnabled,
					exportApprovedAt:
						binding.exportApprovedAt?.toISOString() ?? null,
					configVersion: binding.configVersion,
				}
			: null,
	};
}

/** Explicit admin export approval; no SQL warehouse or implicit global destination. */
export async function configureSavedEvaluationBinding(
	actor: ContextQualityActor,
	raw: unknown,
) {
	await requireSavedEvaluationAccess(actor, "configure");
	const parsed = savedEvaluationBindingSchema.safeParse(raw);
	if (!parsed.success)
		throw new SavedEvaluationError(
			"BAD_REQUEST",
			"Provide a valid approved Databricks evaluation destination.",
		);
	const input = parsed.data;
	if (!input.enabled) {
		await disableContextQualityBinding({ ...actor, actorId: actor.userId });
		return getSavedEvaluationBinding(actor);
	}
	let origin: string;
	try {
		origin = validateDatabricksWorkspaceOrigin(input.workspaceOrigin);
	} catch {
		throw new SavedEvaluationError(
			"BAD_REQUEST",
			"Use a supported Databricks workspace origin.",
		);
	}
	if (
		origin !== input.workspaceOrigin ||
		!/^\/Volumes\/[a-z0-9_-]+\/[a-z0-9_-]+\/[a-z0-9_-]+$/.test(
			input.volumeRoot,
		)
	)
		throw new SavedEvaluationError(
			"BAD_REQUEST",
			"Use the canonical workspace origin and an isolated Unity Catalog volume root.",
		);
	const credentials = await fetchContextQualityExecutionCredentials({
		integrationId: input.integrationId,
		organizationId: actor.organizationId,
		userId: actor.userId,
		workspaceOrigin: origin,
	});
	if (
		!credentials ||
		credentials.DATABRICKS_HOST !== origin ||
		!credentials.DATABRICKS_CLIENT_ID ||
		!credentials.DATABRICKS_CLIENT_SECRET
	)
		throw new SavedEvaluationError(
			"PRECONDITION_FAILED",
			"Select an active organization-shared Databricks platform connection with OAuth machine credentials.",
		);
	let approved: { notebookPath: string; notebookSha256: string };
	try {
		const signal = AbortSignal.timeout(30_000);
		approved = await inspectDatabricksEvaluationJob(
			{ workspaceOrigin: origin, jobId: input.jobId, credentials },
			signal,
		);
		const client = new DatabricksApiClient({
			host: origin,
			tokenProvider: createOAuthM2MProvider(
				origin,
				credentials.DATABRICKS_CLIENT_ID,
				credentials.DATABRICKS_CLIENT_SECRET,
			),
			maxRetries: 0,
		});
		await client.request(
			"GET",
			`/api/2.0/mlflow/experiments/get?experiment_id=${input.experimentId}`,
			undefined,
			{ signal },
		);
		const [, catalog, schema, volume] = input.volumeRoot
			.split("/")
			.slice(1);
		await client.request(
			"GET",
			`/api/2.1/unity-catalog/volumes/${[catalog, schema, volume].map(encodeURIComponent).join(".")}`,
			undefined,
			{ signal },
		);
	} catch {
		throw new SavedEvaluationError(
			"PRECONDITION_FAILED",
			"The connection could not verify the isolated job, notebook, experiment and volume. Check resource permissions and the approved job template.",
		);
	}
	await requireSavedEvaluationAccess(actor, "configure");
	const principalFingerprint =
		computeDatabricksEvaluationPrincipalFingerprint(
			origin,
			credentials.DATABRICKS_CLIENT_ID,
		);
	const configHash = createHash("sha256")
		.update(
			JSON.stringify({
				integrationId: input.integrationId,
				workspaceOrigin: origin,
				jobId: input.jobId,
				experimentId: input.experimentId,
				volumeRoot: input.volumeRoot,
				...approved,
				principalFingerprint,
			}),
		)
		.digest("hex");
	await saveContextQualityBinding({
		...actor,
		...input,
		...approved,
		workspaceOrigin: origin,
		isEnabled: input.enabled,
		actorId: actor.userId,
		principalFingerprint,
		configHash,
	});
	return getSavedEvaluationBinding(actor);
}

export async function disableSavedEvaluationBinding(
	actor: ContextQualityActor,
) {
	await requireSavedEvaluationAccess(actor, "configure");
	await disableContextQualityBinding({ ...actor, actorId: actor.userId });
	return getSavedEvaluationBinding(actor);
}
export async function deleteSavedEvaluationBinding(actor: ContextQualityActor) {
	await requireSavedEvaluationAccess(actor, "configure");
	const outcome = await deleteSettledContextQualityRunsForProject(actor);
	if (!outcome.deleted)
		throw new SavedEvaluationError(
			"CONFLICT",
			"Saved evaluation history cannot be removed until execution and remote input cleanup are confirmed.",
		);
	return { deleted: true as const };
}
