import { createHash, randomUUID } from "node:crypto";
import {
	admitContextQualityRun,
	fetchContextQualityExecutionCredentials,
	getContextQualityBinding,
	getContextQualityRunByRequest,
	getContextQualityRunSummary,
	listContextQualityRunSummaries,
	type RecordAuditInput,
	recordAudit,
	requestContextQualityRunCancellation,
} from "@repo/database";
import {
	evaluationAdmissionKey,
	validateDatabricksWorkspaceOrigin,
} from "@repo/databricks";
import {
	CONTEXT_QUALITY_MAX_BYTES,
	contextQualityResultSchema,
	evaluateContextQuality,
} from "@repo/rag/lib/context-quality";
import { assertProjectContextSourceAccess } from "@repo/rag/lib/context-quality/project-reader";
import { getTemporalClient } from "@repo/temporal/client";
import { CONTEXT_QUALITY_TASK_QUEUE } from "@repo/temporal/task-queues";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	createSavedEvaluationSchema,
	SavedEvaluationError,
	savedEvaluationListSchema,
	savedEvaluationRunSchema,
} from "../saved-contracts";
import type { ContextQualityActor } from "./commands";
import { readProjectContextSnapshot } from "./context-reader";
import { requireSavedEvaluationAccess } from "./saved-access";

type Audit = (event: RecordAuditInput) => void;
const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
type Row = NonNullable<Awaited<ReturnType<typeof getContextQualityRunSummary>>>;
const terminal = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

async function safeRun(
	actor: ContextQualityActor,
	row: Row,
	sourceChecks?: Map<string, Promise<boolean>>,
) {
	let evidenceAvailable = true;
	const refs = row.sourceRefsJson as Array<{
		sourceId: string;
		expectedRevision: string;
	}>;
	// A historical report survives revisions, but not source deletion/revocation.
	try {
		for (const ref of refs) {
			let checked = sourceChecks?.get(ref.sourceId);
			if (!checked) {
				checked = assertProjectContextSourceAccess({
					...actor,
					sourceId: ref.sourceId,
				}).then(
					() => true,
					() => false,
				);
				sourceChecks?.set(ref.sourceId, checked);
			}
			if (!(await checked)) evidenceAvailable = false;
		}
	} catch {
		evidenceAvailable = false;
	}
	await requireSavedEvaluationAccess(actor);
	const report = evidenceAvailable
		? contextQualityResultSchema.safeParse(row.resultJson)
		: null;
	let origin: string | null = null;
	try {
		origin = validateDatabricksWorkspaceOrigin(row.workspaceOrigin ?? "");
	} catch {
		/* no untrusted native links */
	}
	const remoteRunUrl =
		evidenceAvailable &&
		origin &&
		/^\d{1,16}$/.test(row.remoteRunId ?? "") &&
		/^\d{1,16}$/.test(row.jobId ?? "")
			? `${origin}/jobs/${row.jobId}/runs/${row.remoteRunId}`
			: null;
	const mlflowRunUrl =
		evidenceAvailable &&
		origin &&
		/^[a-f0-9]{32}$/.test(row.remoteMlflowRunId ?? "") &&
		/^\d{1,16}$/.test(row.experimentId ?? "")
			? `${origin}/ml/experiments/${row.experimentId}/runs/${row.remoteMlflowRunId}`
			: null;
	return savedEvaluationRunSchema.parse({
		id: row.id,
		projectId: row.projectId,
		organizationId: row.organizationId,
		name: row.name,
		status: row.status,
		sourceRefs: refs,
		report: report?.success ? report.data : null,
		evidenceAvailable,
		errorCode: row.errorCode,
		cleanupStatus: row.cleanupStatus,
		remoteRunUrl,
		mlflowRunUrl,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		completedAt: row.completedAt?.toISOString() ?? null,
	});
}

async function ensureStarted(actor: ContextQualityActor, row: Row) {
	if (terminal.has(row.status)) return;
	try {
		const client = await getTemporalClient();
		await client.workflow.start(
			"contextQualityEvaluationWorkflow",
			withCorrelationMemo({
				taskQueue: CONTEXT_QUALITY_TASK_QUEUE,
				workflowId: row.workflowId,
				workflowExecutionTimeout: "1 hour",
				args: [
					{
						evaluationRunId: row.id,
						organizationId: actor.organizationId,
						projectId: actor.projectId,
						requesterUserId: row.requestedBy,
					},
				],
			}),
		);
	} catch (error) {
		if (
			!(
				error instanceof Error &&
				error.name === "WorkflowExecutionAlreadyStartedError"
			)
		) {
			// The admitted row is the durable outbox. Return its QUEUED state;
			// recovery/retrying the same key attaches to the same execution.
		}
	}
}

export async function getContextQualityRunCapabilities(
	actor: ContextQualityActor,
) {
	const access = await requireSavedEvaluationAccess(actor);
	const binding = await getContextQualityBinding(actor);
	let configured = Boolean(binding?.isEnabled && binding.exportApprovedAt);
	if (configured && binding)
		configured = Boolean(
			await fetchContextQualityExecutionCredentials({
				...actor,
				integrationId: binding.integrationId,
				workspaceOrigin: binding.workspaceOrigin,
				principalFingerprint: binding.principalFingerprint,
			}),
		);
	return {
		configured,
		canCreate: configured && access.canWrite,
		canCancel: access.canWrite,
		canConfigure: access.canConfigure,
		bindingId: binding?.id,
		reason: configured
			? null
			: "An administrator must connect and approve a Databricks evaluation job for this project.",
	};
}

export async function createContextQualityRun(
	actor: ContextQualityActor,
	raw: unknown,
	audit: Audit = recordAudit,
) {
	await requireSavedEvaluationAccess(actor, "write");
	const parsed = createSavedEvaluationSchema.safeParse(raw);
	if (!parsed.success)
		throw new SavedEvaluationError(
			"BAD_REQUEST",
			"Use a valid bounded saved evaluation request.",
		);
	const input = parsed.data;
	const name = input.name ?? "Context quality evaluation";
	const requestHash = digest(
		JSON.stringify({
			bindingId: input.bindingId,
			name,
			evaluation: input.evaluation,
		}),
	);
	const existing = await getContextQualityRunByRequest({
		...actor,
		requestedBy: actor.userId,
		idempotencyKey: input.idempotencyKey,
	});
	if (existing) {
		if (existing.requestHash !== requestHash)
			throw new SavedEvaluationError(
				"CONFLICT",
				"This request key already identifies a different evaluation.",
			);
		await ensureStarted(actor, existing);
		return { run: await safeRun(actor, existing) };
	}
	const binding = await getContextQualityBinding(actor);
	if (
		!binding ||
		binding.id !== input.bindingId ||
		!binding.isEnabled ||
		!binding.exportApprovedAt
	)
		throw new SavedEvaluationError(
			"PRECONDITION_FAILED",
			"Approve an enabled evaluation destination for this project first.",
		);
	const credentials = await fetchContextQualityExecutionCredentials({
		...actor,
		integrationId: binding.integrationId,
		workspaceOrigin: binding.workspaceOrigin,
		principalFingerprint: binding.principalFingerprint,
	});
	if (!credentials)
		throw new SavedEvaluationError(
			"PRECONDITION_FAILED",
			"The approved organization connection is unavailable.",
		);
	const sources = [];
	for (const reference of input.evaluation.sources)
		sources.push(
			await readProjectContextSnapshot({ ...actor, ...reference }),
		);
	const snapshot = {
		version: input.evaluation.version,
		sources: sources.map((source) => ({
			id: source.sourceId,
			revision: source.revision,
			content: source.content,
		})),
		cases: input.evaluation.cases,
	};
	const snapshotPayload = JSON.stringify(snapshot);
	if (Buffer.byteLength(snapshotPayload, "utf8") > CONTEXT_QUALITY_MAX_BYTES)
		throw new SavedEvaluationError(
			"BAD_REQUEST",
			"Evaluation snapshot exceeds the processing limit.",
		);
	let report: ReturnType<typeof evaluateContextQuality>;
	try {
		report = evaluateContextQuality(snapshot);
	} catch {
		throw new SavedEvaluationError(
			"BAD_REQUEST",
			"The evaluation snapshot is invalid.",
		);
	}
	for (const reference of input.evaluation.sources)
		await readProjectContextSnapshot({ ...actor, ...reference });
	await requireSavedEvaluationAccess(actor, "write");
	const id = randomUUID();
	const payloadHash = digest(snapshotPayload);
	const admitted = await admitContextQualityRun({
		...actor,
		id,
		requestedBy: actor.userId,
		name,
		idempotencyKey: input.idempotencyKey,
		requestHash,
		bindingId: binding.id,
		bindingConfigHash: binding.configHash,
		sourceRefsJson: input.evaluation.sources,
		snapshotPayload,
		payloadHash,
		snapshotHash: report.snapshotHash,
		scorerVersion: report.scorerVersion,
		localResultJson: report,
		workflowId: `context-quality-${id}`,
		dispatchToken: evaluationAdmissionKey(
			{
				workspaceOrigin: binding.workspaceOrigin,
				jobId: binding.jobId,
				experimentId: binding.experimentId,
				volumePath: binding.volumeRoot,
				notebookPath: binding.notebookPath,
				notebookSha256: binding.notebookSha256,
			},
			{
				fabricRunId: id,
				payloadHash,
				snapshotPath: `${binding.volumeRoot}/${id}.json`,
				experimentId: binding.experimentId,
			},
		),
		deadlineAt: new Date(Date.now() + 45 * 60_000),
		snapshotExpiresAt: new Date(Date.now() + 60 * 60_000),
	});
	if (!admitted.run)
		throw new SavedEvaluationError(
			"CONFLICT",
			"The evaluation could not be admitted.",
		);
	if (admitted.created)
		audit({
			action: "project.context_quality.run_requested",
			actor: { type: "user", userId: actor.userId },
			organizationId: actor.organizationId,
			projectId: actor.projectId,
			resource: { type: "context_quality_run", id: admitted.run.id },
			metadata: { bindingId: binding.id },
		});
	await ensureStarted(actor, admitted.run);
	return { run: await safeRun(actor, admitted.run) };
}

export async function listContextQualityRuns(
	actor: ContextQualityActor,
	raw: unknown = {},
) {
	await requireSavedEvaluationAccess(actor);
	const input = savedEvaluationListSchema.safeParse(raw);
	if (!input.success)
		throw new SavedEvaluationError(
			"BAD_REQUEST",
			"Use a valid evaluation history cursor and page size.",
		);
	const page = await listContextQualityRunSummaries({
		...actor,
		...input.data,
	});
	const sourceChecks = new Map<string, Promise<boolean>>();
	const runs = await Promise.all(
		page.runs.map((row) => safeRun(actor, row, sourceChecks)),
	);
	await requireSavedEvaluationAccess(actor);
	return { runs, nextCursor: page.nextCursor };
}
export async function getContextQualityRun(
	actor: ContextQualityActor,
	input: { runId: string },
) {
	await requireSavedEvaluationAccess(actor);
	const row = await getContextQualityRunSummary({
		...actor,
		runId: input.runId,
	});
	if (!row)
		throw new SavedEvaluationError(
			"NOT_FOUND",
			"Evaluation not found in this project.",
		);
	return { run: await safeRun(actor, row) };
}
export async function cancelContextQualityRun(
	actor: ContextQualityActor,
	input: { runId: string },
	audit: Audit = recordAudit,
) {
	await requireSavedEvaluationAccess(actor, "write");
	const row = await requestContextQualityRunCancellation({
		...actor,
		runId: input.runId,
	});
	if (!row)
		throw new SavedEvaluationError(
			"NOT_FOUND",
			"Evaluation not found in this project.",
		);
	if (!terminal.has(row.status)) {
		await ensureStarted(actor, row);
		try {
			await (await getTemporalClient()).workflow
				.getHandle(row.workflowId)
				.cancel();
		} catch {
			/* durable cancelRequestedAt is authoritative */
		}
	}
	audit({
		action: "project.context_quality.cancel_requested",
		actor: { type: "user", userId: actor.userId },
		organizationId: actor.organizationId,
		projectId: actor.projectId,
		resource: { type: "context_quality_run", id: input.runId },
	});
	return getContextQualityRun(actor, input);
}
export async function compareContextQualityRuns(
	actor: ContextQualityActor,
	input: { baselineId: string; candidateId: string },
) {
	const [{ run: baseline }, { run: candidate }] = await Promise.all([
		getContextQualityRun(actor, { runId: input.baselineId }),
		getContextQualityRun(actor, { runId: input.candidateId }),
	]);
	const a = baseline.report;
	const b = candidate.report;
	const differences = {
		dataset: !a || !b || a.datasetHash !== b.datasetHash,
		configuration: !a || !b || a.configurationHash !== b.configurationHash,
		scorer: !a || !b || a.scorerVersion !== b.scorerVersion,
	};
	const compatible = Boolean(
		a && b && !Object.values(differences).some(Boolean),
	);
	return {
		baseline,
		candidate,
		compatible,
		differences,
		passedDelta:
			compatible && a && b ? b.counts.passed - a.counts.passed : null,
	};
}
