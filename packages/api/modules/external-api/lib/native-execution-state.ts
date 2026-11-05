import { type Prisma, readAgentExecutionAdmission } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { classifyTemporalClientError } from "@repo/temporal/temporal-client-errors";

export type NativeReadStatus =
	| "AVAILABLE"
	| "UNAVAILABLE"
	| "NOT_FOUND"
	| "IDENTITY_UNVERIFIED"
	| "RESULT_UNAVAILABLE";

type ExecutionIdentity = {
	id: string;
	executionId: string;
	organizationId: string | null;
	userId: string;
	workflowId: string | null;
	runId: string | null;
	metadata: Prisma.JsonValue;
};
type NativeState = {
	nativeReadStatus: NativeReadStatus;
	runId?: string;
	status?: string;
	output?: unknown;
	result?: unknown;
	error?: string | null;
	progress?: unknown;
	startedAt?: Date;
	completedAt?: Date;
	durationMs?: number;
	/** Native closure does not imply the business task succeeded. */
	workflowClosed?: boolean;
};
const workflowTypes = new Set([
	"deploymentExecutionWorkflow",
	"goalOrientedAgentWorkflow",
	"nativeDeploymentExecutionWorkflow",
	"nativeGoalOrientedAgentWorkflow",
]);
function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function bounded(value: unknown): boolean {
	try {
		return (
			Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") <= 1_048_576
		);
	} catch {
		return false;
	}
}

/** Read only: a missing receipt may be observed, but this module never dispatches work. */
export async function readNativeExecutionState(
	execution: ExecutionIdentity,
	dependencies: {
		getClient?: typeof getTemporalClient;
		metadataOnly?: boolean;
	} = {},
): Promise<NativeState> {
	const admission = readAgentExecutionAdmission(execution);
	if (
		!execution.organizationId ||
		!execution.workflowId ||
		(!execution.runId && !admission)
	) {
		return { nativeReadStatus: "IDENTITY_UNVERIFIED" };
	}
	try {
		const deadline = Date.now() + 3_000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const client = await Promise.race([
			(dependencies.getClient ?? getTemporalClient)(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Native read timed out")),
					3_000,
				);
			}),
		]).finally(() => clearTimeout(timer));
		// One absolute RPC budget for describe/query/result. A running workflow's result
		// is never awaited; a closed one cannot make polling wait for new work.
		return await client.connection.withDeadline(
			deadline,
			async (): Promise<NativeState> => {
				const handle = client.workflow.getHandle(
					execution.workflowId as string,
					execution.runId ?? undefined,
				);
				let description: Awaited<ReturnType<typeof handle.describe>>;
				let recoveredStaleRun = false;
				try {
					description = await handle.describe();
				} catch (error) {
					if (
						classifyTemporalClientError(error) !== "not_found" ||
						!execution.runId ||
						!admission
					) {
						throw error;
					}
					// A stale stored run is never silently followed. Recover only through
					// the stable identity and the exact persisted admission memo below.
					description = await client.workflow
						.getHandle(execution.workflowId as string)
						.describe();
					recoveredStaleRun = true;
				}
				const observed = record(description.memo?.fabricAgentAdmission);
				const expected = admission && {
					version: 1,
					executionId: execution.id,
					organizationId: execution.organizationId,
					userId: execution.userId,
					requestHash: admission.requestHash,
				};
				if (
					!description.runId ||
					!workflowTypes.has(description.type) ||
					(execution.runId &&
						!recoveredStaleRun &&
						description.runId !== execution.runId) ||
					(admission &&
						(description.type !== admission.dispatch.workflowType ||
							!observed ||
							Object.entries(expected ?? {}).some(
								([key, value]) => observed[key] !== value,
							)))
				) {
					return { nativeReadStatus: "IDENTITY_UNVERIFIED" };
				}
				const state: NativeState = {
					nativeReadStatus: "AVAILABLE",
					runId: description.runId,
					startedAt: description.startTime,
					completedAt: description.closeTime,
					durationMs: description.closeTime
						? Math.max(
								0,
								description.closeTime.getTime() -
									description.startTime.getTime(),
							)
						: undefined,
				};
				if (dependencies.metadataOnly) {
					// A completed Temporal wrapper can contain a failed business outcome.
					// Leave that outcome unknown until its receipt or explicit result read.
					const statuses: Record<string, string> = {
						RUNNING: "RUNNING",
						FAILED: "FAILED",
						CANCELLED: "CANCELLED",
						TERMINATED: "CANCELLED",
						TIMED_OUT: "TIMED_OUT",
					};
					return {
						...state,
						workflowClosed: [
							"COMPLETED",
							"FAILED",
							"CANCELLED",
							"TERMINATED",
							"TIMED_OUT",
							"CONTINUED_AS_NEW",
						].includes(description.status.name),
						status: statuses[description.status.name] ?? "UNKNOWN",
					};
				}
				// Pin the observed run after verification. Never follow an unverified newer
				// run or Continue-As-New while reading a saved invocation's result.
				const pinned = client.workflow.getHandle(
					execution.workflowId as string,
					description.runId,
					{ followRuns: false },
				);
				if (description.status.name === "RUNNING") {
					state.status = "RUNNING";
					try {
						const progress = await pinned.query("progress");
						if (bounded(progress)) {
							state.progress = progress;
						}
					} catch {
						// Older histories need not have this query handler. Describe is still
						// authoritative for liveness; unavailable progress is not fabricated.
					}
					return state;
				}
				if (description.status.name === "COMPLETED") {
					let result: unknown;
					try {
						result = await pinned.result();
					} catch {
						return {
							...state,
							nativeReadStatus: "RESULT_UNAVAILABLE",
							status: "UNKNOWN",
						};
					}
					const value = record(result);
					if (
						!bounded(result) ||
						value?.executionId !== execution.executionId ||
						!new Set([
							"COMPLETED",
							"FAILED",
							"CANCELLED",
							"MAX_ITERATIONS_REACHED",
						]).has(String(value?.status))
					) {
						return {
							...state,
							nativeReadStatus: "RESULT_UNAVAILABLE",
							status: "UNKNOWN",
						};
					}
					return {
						...state,
						status:
							value.status === "MAX_ITERATIONS_REACHED"
								? "FAILED"
								: String(value.status),
						output:
							description.type === "goalOrientedAgentWorkflow" ||
							description.type ===
								"nativeGoalOrientedAgentWorkflow"
								? {
										...record(value.output),
										response: value.response,
										stepsExecuted: value.stepsExecuted,
										goalAchieved: value.goalAchieved,
										iterationsUsed: value.iterationsUsed,
										verificationResult:
											value.verificationResult,
									}
								: value.output,
						result,
						error:
							typeof value.error === "string"
								? value.error.slice(0, 4000)
								: null,
						durationMs:
							typeof value.durationMs === "number" &&
							Number.isFinite(value.durationMs) &&
							value.durationMs >= 0
								? value.durationMs
								: state.durationMs,
					};
				}
				const closed: Record<string, string> = {
					FAILED: "FAILED",
					CANCELLED: "CANCELLED",
					TERMINATED: "CANCELLED",
					TIMED_OUT: "TIMED_OUT",
				};
				return {
					...state,
					status: closed[description.status.name] ?? "UNKNOWN",
					error: closed[description.status.name]
						? `Workflow ${description.status.name.toLowerCase().replaceAll("_", " ")}`
						: undefined,
				};
			},
		);
	} catch (error) {
		return {
			nativeReadStatus:
				classifyTemporalClientError(error) === "not_found"
					? "NOT_FOUND"
					: "UNAVAILABLE",
		};
	}
}
