import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	db,
	fetchContextQualityExecutionCredentials,
	Permissions,
} from "@repo/database";
import {
	CONTEXT_QUALITY_RUN_STATUSES,
	CONTEXT_QUALITY_TERMINAL_STATUSES,
	type ContextQualityRunPatch,
	type ContextQualityRunStatus,
	getContextQualityRunForWorker,
	purgeSettledContextQualityRunSnapshot,
	transitionContextQualityRun,
} from "@repo/database/prisma/queries/projects/context-quality-runs";
import {
	computeDatabricksEvaluationPrincipalFingerprint,
	DatabricksEvaluationClient,
	DatabricksEvaluationError,
	type EvaluationJobBinding,
	type EvaluationRunIdentity,
	evaluationSnapshotPath,
} from "@repo/databricks";
import {
	contextQualityResultSchema,
	evaluateContextQuality,
} from "@repo/rag/lib/context-quality";
import { resolveEffectiveProjectPermissions } from "@repo/rag/lib/context-quality/project-access";
import {
	assertProjectContextSourceAccess,
	readProjectContextSnapshot,
} from "@repo/rag/lib/context-quality/project-reader";
import { decryptApiKey } from "@repo/utils";
import { CancelledFailure } from "@temporalio/common";
import { z } from "zod";
import type {
	ContextQualityEvaluationWorkflowInput,
	ContextQualityEvaluationWorkflowOutput,
} from "../lib/context-quality-types";
import {
	activityCancellationSignal,
	requestAbortSignal,
	withHeartbeatTicker,
} from "./lib/activity-liveness";

type Run = NonNullable<
	Awaited<ReturnType<typeof getContextQualityRunForWorker>>
>;
const refSchema = z
	.array(
		z.strictObject({
			sourceId: z.string().min(1).max(128),
			expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
		}),
	)
	.min(1)
	.max(8);
const bindingSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	projectId: z.string(),
	integrationId: z.string(),
	workspaceOrigin: z.string(),
	jobId: z.string(),
	experimentId: z.string(),
	volumeRoot: z.string(),
	notebookPath: z.string(),
	notebookSha256: z.string().regex(/^[a-f0-9]{64}$/),
	principalFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	configHash: z.string(),
	configVersion: z.number().int(),
});
type FrozenBinding = z.infer<typeof bindingSchema>;
const receiptSchema = z.strictObject({
	version: z.literal(1),
	fabricRunId: z.string(),
	payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
	experimentId: z.string(),
	mlflowRunId: z.string().regex(/^[a-f0-9]{32}$/),
	report: contextQualityResultSchema,
});
const ACTIVE = new Set([
	"QUEUED",
	"EXPORTING",
	"DISPATCHING",
	"RUNNING",
	"CANCEL_REQUESTED",
	"RECONCILIATION_REQUIRED",
]);
const NATIVE = new Set([
	"PENDING",
	"RUNNING",
	"TERMINATING",
	"TERMINATED",
	"SKIPPED",
	"INTERNAL_ERROR",
	"BLOCKED",
	"WAITING_FOR_RETRY",
	"QUEUED",
]);

class EvaluationStopped extends Error {
	constructor(readonly code: string) {
		super("Context evaluation cannot continue.");
	}
}
class StateRace extends Error {}

function canonical(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
function scope(input: ContextQualityEvaluationWorkflowInput) {
	return {
		organizationId: input.organizationId,
		projectId: input.projectId,
		runId: input.evaluationRunId,
	};
}
function frozen(run: Run): FrozenBinding {
	const parsed = bindingSchema.safeParse(run.bindingConfigJson);
	if (
		!parsed.success ||
		parsed.data.organizationId !== run.organizationId ||
		parsed.data.projectId !== run.projectId ||
		parsed.data.configHash !== run.bindingConfigHash
	) {
		throw new EvaluationStopped("INVALID_BINDING");
	}
	return parsed.data;
}
function remoteBinding(binding: FrozenBinding): EvaluationJobBinding {
	return {
		workspaceOrigin: binding.workspaceOrigin,
		jobId: binding.jobId,
		experimentId: binding.experimentId,
		volumePath: binding.volumeRoot,
		notebookPath: binding.notebookPath,
		notebookSha256: binding.notebookSha256,
	};
}
function identity(run: Run, binding: FrozenBinding): EvaluationRunIdentity {
	return {
		fabricRunId: run.id,
		payloadHash: run.payloadHash,
		snapshotPath: evaluationSnapshotPath(remoteBinding(binding), run.id),
		experimentId: binding.experimentId,
	};
}
function status(value: string): ContextQualityRunStatus {
	if (!(CONTEXT_QUALITY_RUN_STATUSES as readonly string[]).includes(value)) {
		throw new EvaluationStopped("INVALID_RUN_STATE");
	}
	return value as ContextQualityRunStatus;
}

export interface ContextQualityEvaluationDependencies {
	load: typeof getContextQualityRunForWorker;
	transition: typeof transitionContextQualityRun;
	readSource: typeof readProjectContextSnapshot;
	assertSourceAccess: typeof assertProjectContextSourceAccess;
	assertCanExecute: (run: Run) => Promise<void>;
	purgeSnapshot: typeof purgeSettledContextQualityRunSnapshot;
	credentials: (
		binding: FrozenBinding,
		run: Run,
		cleanupOnly: boolean,
	) => Promise<Record<string, string> | null>;
	client: (
		binding: FrozenBinding,
		credentials: Record<string, string>,
	) => Pick<
		DatabricksEvaluationClient,
		| "qualifyJob"
		| "uploadSnapshot"
		| "admit"
		| "getRun"
		| "findAdmittedRun"
		| "cancel"
		| "output"
		| "deleteSnapshot"
	>;
	now: () => Date;
	sleep: (milliseconds: number) => Promise<unknown>;
}

async function credentialsFor(
	binding: FrozenBinding,
	run: Run,
	cleanupOnly: boolean,
) {
	if (!cleanupOnly) {
		return fetchContextQualityExecutionCredentials({
			integrationId: binding.integrationId,
			organizationId: run.organizationId,
			userId: run.requestedBy,
			workspaceOrigin: binding.workspaceOrigin,
			principalFingerprint: binding.principalFingerprint,
		});
	}
	// A revoked actor cannot dispatch/read sources. Exact receipt cleanup still
	// removes their already-exported file using its original approved principal.
	const row = await db.workflowIntegration.findFirst({
		where: {
			id: binding.integrationId,
			organizationId: run.organizationId,
			provider: "DATABRICKS_PLATFORM",
			workflowId: null,
		},
		select: { credentials: true },
	});
	if (!row) {
		return null;
	}
	try {
		const value = z
			.object({
				host: z.string(),
				clientId: z.string(),
				clientSecret: z.string(),
			})
			.parse(JSON.parse(decryptApiKey(row.credentials)));
		return {
			DATABRICKS_HOST: value.host,
			DATABRICKS_CLIENT_ID: value.clientId,
			DATABRICKS_CLIENT_SECRET: value.clientSecret,
		};
	} catch {
		return null;
	}
}
const defaults: ContextQualityEvaluationDependencies = {
	load: getContextQualityRunForWorker,
	purgeSnapshot: purgeSettledContextQualityRunSnapshot,
	transition: transitionContextQualityRun,
	readSource: readProjectContextSnapshot,
	assertSourceAccess: assertProjectContextSourceAccess,
	assertCanExecute: async (run) => {
		const access = await resolveEffectiveProjectPermissions(
			run.projectId,
			run.requestedBy,
		);
		if (
			!access ||
			access.organizationId !== run.organizationId ||
			access.organizationDeleted ||
			!access.permissions.includes(Permissions.PROJECT_UPDATE) ||
			!access.permissions.includes(Permissions.CONTEXT_READ)
		)
			throw new Error("Current project edit access is required.");
	},
	credentials: credentialsFor,
	client: (binding, credentials) =>
		new DatabricksEvaluationClient({
			binding: remoteBinding(binding),
			credentials,
		}),
	now: () => new Date(),
	sleep: (milliseconds) =>
		delay(milliseconds, undefined, {
			signal: activityCancellationSignal(),
		}),
};

/** Dependency seam lets retry/cancel/permission races be tested without cloud access. */
export function createContextQualityEvaluationActivities(
	overrides: Partial<ContextQualityEvaluationDependencies> = {},
) {
	const deps = { ...defaults, ...overrides };
	async function load(
		input: ContextQualityEvaluationWorkflowInput,
	): Promise<Run> {
		const run = await deps.load(scope(input));
		if (!run || run.requestedBy !== input.requesterUserId) {
			throw new EvaluationStopped("RUN_UNAVAILABLE");
		}
		return run;
	}
	async function change(
		run: Run,
		patch: ContextQualityRunPatch,
	): Promise<Run> {
		const result = await deps.transition({
			organizationId: run.organizationId,
			projectId: run.projectId,
			runId: run.id,
			expectedStateVersion: run.stateVersion,
			fromStatuses: [status(run.status)],
			patch,
		});
		if (!result.updated || !result.run) {
			throw new StateRace();
		}
		if (
			(CONTEXT_QUALITY_TERMINAL_STATUSES as readonly string[]).includes(
				result.run.status,
			)
		)
			await deps.purgeSnapshot({
				organizationId: run.organizationId,
				projectId: run.projectId,
				runId: run.id,
			});
		return result.run;
	}
	async function client(
		run: Run,
		binding: FrozenBinding,
		cleanupOnly = false,
	) {
		const credentials = await deps.credentials(binding, run, cleanupOnly);
		if (
			!credentials ||
			credentials.DATABRICKS_HOST !== binding.workspaceOrigin ||
			computeDatabricksEvaluationPrincipalFingerprint(
				binding.workspaceOrigin,
				credentials.DATABRICKS_CLIENT_ID ?? "",
			) !== binding.principalFingerprint
		) {
			throw new EvaluationStopped("CONNECTION_UNAVAILABLE");
		}
		return deps.client(binding, credentials);
	}
	async function authorize(run: Run, pins: boolean) {
		if (run.cancelRequestedAt) {
			throw new EvaluationStopped("CANCEL_REQUESTED");
		}
		if (
			deps.now() >= run.deadlineAt ||
			deps.now() >= run.snapshotExpiresAt
		) {
			throw new EvaluationStopped("DEADLINE_EXCEEDED");
		}
		try {
			await deps.assertCanExecute(run);
		} catch {
			throw new EvaluationStopped("PROJECT_ACCESS_REVOKED");
		}
		const binding = frozen(run);
		if (
			!run.binding ||
			!run.binding.isEnabled ||
			!run.binding.exportApprovedAt ||
			run.binding.configHash !== run.bindingConfigHash ||
			run.binding.configVersion !== binding.configVersion
		) {
			throw new EvaluationStopped("BINDING_REVOKED");
		}
		const refs = refSchema.safeParse(run.sourceRefsJson);
		if (!refs.success) {
			throw new EvaluationStopped("INVALID_SNAPSHOT");
		}
		for (const ref of refs.data) {
			try {
				const input = {
					organizationId: run.organizationId,
					projectId: run.projectId,
					userId: run.requestedBy,
					sourceId: ref.sourceId,
				};
				if (pins) {
					await deps.readSource({
						...input,
						expectedRevision: ref.expectedRevision,
					});
				} else {
					await deps.assertSourceAccess(input);
				}
			} catch {
				throw new EvaluationStopped(
					pins
						? "SOURCE_CHANGED_OR_REVOKED"
						: "SOURCE_ACCESS_REVOKED",
				);
			}
		}
	}
	async function rememberRemote(
		input: ContextQualityEvaluationWorkflowInput,
		remoteRunId: string,
	): Promise<Run> {
		for (let attempt = 0; attempt < 4; attempt++) {
			const run = await load(input);
			if (run.remoteRunId === remoteRunId) {
				return run;
			}
			try {
				return await change(run, { remoteRunId });
			} catch (error) {
				if (!(error instanceof StateRace)) {
					throw error;
				}
			}
		}
		throw new EvaluationStopped("STORE_UNAVAILABLE");
	}
	async function erase(
		input: ContextQualityEvaluationWorkflowInput,
	): Promise<Run> {
		let run = await load(input);
		if (
			(CONTEXT_QUALITY_TERMINAL_STATUSES as readonly string[]).includes(
				run.status,
			)
		) {
			await deps.purgeSnapshot(scope(input));
			run = await load(input);
		}
		if (
			run.cleanupStatus === "CONFIRMED" ||
			run.cleanupStatus === "NOT_REQUIRED"
		) {
			return run;
		}
		try {
			const binding = frozen(run);
			const transport = await client(run, binding, true);
			await transport.deleteSnapshot(
				identity(run, binding),
				requestAbortSignal(15_000),
			);
			run = await load(input);
			return await change(run, {
				cleanupStatus: "CONFIRMED",
				cleanupErrorCode: null,
			});
		} catch {
			run = await load(input);
			try {
				return await change(run, {
					cleanupStatus: "BLOCKED",
					cleanupErrorCode: "REMOTE_ERASURE_UNCONFIRMED",
				});
			} catch {
				return run;
			}
		}
	}
	async function settle(
		input: ContextQualityEvaluationWorkflowInput,
		errorCode = "CANCEL_REQUESTED",
	): Promise<ContextQualityEvaluationWorkflowOutput> {
		let run = await load(input);
		if (
			(CONTEXT_QUALITY_TERMINAL_STATUSES as readonly string[]).includes(
				run.status,
			)
		) {
			await erase(input);
			return { status: run.status };
		}
		const neverDispatched =
			!run.remoteRunId &&
			(run.status === "QUEUED" ||
				run.status === "EXPORTING" ||
				run.remoteState === "NOT_DISPATCHED" ||
				run.cleanupStatus === "NOT_REQUIRED");
		let confirmed = neverDispatched;
		try {
			if (!neverDispatched) {
				const binding = frozen(run);
				const transport = await client(run, binding, true);
				const key = identity(run, binding);
				let nativeId = run.remoteRunId;
				if (!nativeId && !confirmed) {
					nativeId = await transport.findAdmittedRun(
						key,
						run.createdAt,
						requestAbortSignal(15_000),
						{
							pageToken: run.remoteLookupPageToken,
							checkpoint: async (token) => {
								run = await change(await load(input), {
									remoteLookupPageToken: token,
								});
							},
						},
					);
				}
				if (nativeId) {
					run = await rememberRemote(input, nativeId);
					for (let i = 0; i < 8; i++) {
						const state = await transport.getRun(
							nativeId,
							key,
							requestAbortSignal(10_000),
						);
						if (!state.parametersMatch) {
							throw new EvaluationStopped("REMOTE_PROTOCOL");
						}
						if (state.terminal) {
							confirmed = true;
							run = await change(run, {
								remoteState: NATIVE.has(state.lifecycle)
									? state.lifecycle
									: "UNKNOWN",
							});
							break;
						}
						if (i === 0) {
							await transport.cancel(
								nativeId,
								requestAbortSignal(10_000),
							);
						}
						await deps.sleep(1000);
					}
				}
			}
		} catch {
			confirmed = neverDispatched;
		}
		run = await erase(input);
		const terminal = confirmed
			? run.cancelRequestedAt || errorCode === "CANCEL_REQUESTED"
				? "CANCELLED"
				: "FAILED"
			: "RECONCILIATION_REQUIRED";
		try {
			run = await change(run, {
				status: terminal,
				errorCode,
				...(confirmed ? { completedAt: deps.now() } : {}),
			});
		} catch {
			run = await load(input);
		}
		return { status: run.status };
	}
	async function execute(
		input: ContextQualityEvaluationWorkflowInput,
	): Promise<ContextQualityEvaluationWorkflowOutput> {
		let run = await load(input);
		try {
			if (!ACTIVE.has(run.status)) {
				await erase(input);
				return { status: run.status };
			}
			if (run.cancelRequestedAt) {
				return await settle(input);
			}
			await authorize(run, false);
			const binding = frozen(run);
			const transport = await client(run, binding);
			const key = identity(run, binding);
			if (
				!run.remoteRunId &&
				(run.status === "DISPATCHING" ||
					run.status === "RECONCILIATION_REQUIRED")
			) {
				const found = await transport.findAdmittedRun(
					key,
					run.createdAt,
					requestAbortSignal(15_000),
					{
						pageToken: run.remoteLookupPageToken,
						checkpoint: async (token) => {
							run = await change(await load(input), {
								remoteLookupPageToken: token,
							});
						},
					},
				);
				if (found) {
					run = await rememberRemote(input, found);
				}
			}
			if (!run.remoteRunId) {
				await authorize(run, true);
				if (
					!run.snapshotPayload ||
					createHash("sha256")
						.update(run.snapshotPayload, "utf8")
						.digest("hex") !== run.payloadHash
				) {
					throw new EvaluationStopped("INVALID_SNAPSHOT");
				}
				const payload = run.snapshotPayload;
				const ambiguousAdmission =
					run.remoteState === "ADMISSION_PENDING";
				const computed = evaluateContextQuality(JSON.parse(payload));
				if (
					computed.snapshotHash !== run.snapshotHash ||
					canonical(computed) !==
						canonical(
							contextQualityResultSchema.parse(
								run.localResultJson,
							),
						)
				) {
					throw new EvaluationStopped("INVALID_SNAPSHOT");
				}
				await transport.qualifyJob(requestAbortSignal(20_000));
				run = await load(input);
				await authorize(run, true);
				await client(run, binding);
				if (!ambiguousAdmission) {
					run = await change(run, {
						status: "EXPORTING",
						remoteState: "NOT_DISPATCHED",
						cleanupStatus: "PENDING",
						remoteInputPath: key.snapshotPath,
						startedAt: run.startedAt ?? deps.now(),
					});
				} else {
					// A reconciliation retry may recreate an already-erased file.
					// Record the new erasure obligation before uploading any bytes.
					run = await change(run, {
						status: "EXPORTING",
						cleanupStatus: "PENDING",
						remoteInputPath: key.snapshotPath,
					});
				}
				await transport.uploadSnapshot(
					key,
					payload,
					requestAbortSignal(20_000),
				);
				run = await load(input);
				await authorize(run, true);
				await transport.qualifyJob(requestAbortSignal(20_000));
				run = await load(input);
				await authorize(run, true);
				await client(run, binding);
				run = await change(run, {
					status: "DISPATCHING",
					remoteState: "ADMISSION_PENDING",
				});
				const remoteId = await transport.admit(
					key,
					requestAbortSignal(20_000),
				);
				run = await rememberRemote(input, remoteId);
			}
			if (run.status !== "RUNNING") {
				run = await change(run, { status: "RUNNING" });
			}
			while (true) {
				run = await load(input);
				await authorize(run, false);
				// Recheck the exact shared connection and principal at every poll.
				const pollingTransport = await client(run, binding);
				if (!run.remoteRunId) {
					throw new EvaluationStopped("REMOTE_PROTOCOL");
				}
				const state = await pollingTransport.getRun(
					run.remoteRunId,
					key,
					requestAbortSignal(15_000),
				);
				if (!state.parametersMatch) {
					throw new EvaluationStopped("REMOTE_PROTOCOL");
				}
				const remoteState = NATIVE.has(state.lifecycle)
					? state.lifecycle
					: "UNKNOWN";
				if (run.remoteState !== remoteState) {
					run = await change(run, { remoteState });
				}
				if (state.terminal) {
					if (state.result !== "SUCCESS" || !state.taskRunId) {
						throw new EvaluationStopped("REMOTE_EVALUATION_FAILED");
					}
					const raw = await pollingTransport.output(
						state.taskRunId,
						requestAbortSignal(15_000),
					);
					const receipt = receiptSchema.parse(raw);
					if (
						receipt.fabricRunId !== run.id ||
						receipt.payloadHash !== run.payloadHash ||
						receipt.experimentId !== binding.experimentId ||
						canonical(receipt.report) !==
							canonical(
								contextQualityResultSchema.parse(
									run.localResultJson,
								),
							)
					) {
						throw new EvaluationStopped("RESULT_MISMATCH");
					}
					run = await load(input);
					await authorize(run, false);
					await client(run, binding);
					run = await change(run, {
						status: "SUCCEEDED",
						resultJson: receipt.report,
						remoteMlflowRunId: receipt.mlflowRunId,
						providerReceiptJson: {
							version: 1,
							fabricRunId: run.id,
							payloadHash: run.payloadHash,
							experimentId: binding.experimentId,
							mlflowRunId: receipt.mlflowRunId,
						},
						completedAt: deps.now(),
						errorCode: null,
					});
					await erase(input);
					return { status: run.status };
				}
				await deps.sleep(2000);
			}
		} catch (error) {
			if (activityCancellationSignal()?.aborted) {
				throw new CancelledFailure("Context evaluation cancelled.");
			}
			if (error instanceof StateRace) {
				run = await load(input);
				if (run.cancelRequestedAt) {
					return settle(input);
				}
				throw new Error(
					"Context evaluation state changed; retry the same run.",
				);
			}
			if (
				error instanceof DatabricksEvaluationError &&
				error.code === "REMOTE_UNAVAILABLE" &&
				(error.status === undefined ||
					error.status === 408 ||
					error.status === 429 ||
					error.status >= 500)
			) {
				run = await load(input);
				if (!run.cancelRequestedAt && deps.now() < run.deadlineAt)
					throw new Error(
						"Context evaluation temporarily unavailable; retry the same admission.",
					);
			}
			const code =
				error instanceof EvaluationStopped
					? error.code
					: error instanceof DatabricksEvaluationError
						? error.code
						: "EVALUATION_UNAVAILABLE";
			return settle(input, code);
		}
	}
	return { execute, settle };
}

export async function executeSavedContextQualityEvaluation(
	input: ContextQualityEvaluationWorkflowInput,
): Promise<ContextQualityEvaluationWorkflowOutput> {
	try {
		return await withHeartbeatTicker(
			() => createContextQualityEvaluationActivities().execute(input),
			{ details: { phase: "context-quality-evaluation" } },
		);
	} catch (error) {
		if (error instanceof CancelledFailure) {
			throw error;
		}
		throw new Error("Context evaluation activity could not complete.");
	}
}

export async function settleCancelledContextQualityEvaluation(
	input: ContextQualityEvaluationWorkflowInput,
): Promise<ContextQualityEvaluationWorkflowOutput> {
	try {
		return await createContextQualityEvaluationActivities().settle(input);
	} catch {
		throw new Error("Context evaluation cleanup could not be confirmed.");
	}
}
