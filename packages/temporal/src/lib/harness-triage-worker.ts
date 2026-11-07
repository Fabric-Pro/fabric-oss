import { createRequire } from "node:module";
import { rootCertificates } from "node:tls";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { ScheduleAlreadyRunning } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import {
	assertInsecureConnectionAllowed,
	getTemporalClient,
	getTemporalConfig,
} from "../client";
import type {
	HarnessTriageActivities,
	HarnessTriageWorkflowInput,
	HarnessTriageWorkflowResult,
} from "./harness-triage-contracts";

const require = createRequire(import.meta.url);
/** Dedicated worker: production builds bundle this entry point with the API-owned host. */
export async function runHarnessTriageWorker(
	activities: HarnessTriageActivities,
) {
	const config = getTemporalConfig();
	const options: Parameters<typeof NativeConnection.connect>[0] = {
		address: config.address,
	};
	if (config.apiKey) {
		options.apiKey = config.apiKey;
		options.tls = {
			serverRootCACertificate: Buffer.from(rootCertificates.join("\n")),
		};
	} else if (
		config.tls &&
		process.env.TEMPORAL_CLIENT_CERT &&
		process.env.TEMPORAL_CLIENT_KEY
	) {
		options.tls = {
			clientCertPair: {
				crt: Buffer.from(process.env.TEMPORAL_CLIENT_CERT),
				key: Buffer.from(process.env.TEMPORAL_CLIENT_KEY),
			},
		};
	} else if (config.tls) {
		options.tls = true;
	} else {
		assertInsecureConnectionAllowed("[Harness triage worker]");
	}
	const connection = await NativeConnection.connect(options);
	try {
		const client = await getTemporalClient();
		try {
			await client.schedule.create({
				scheduleId: "fabric-harness-triage-retention-v1",
				spec: { intervals: [{ every: "1 hour" }] },
				action: {
					type: "startWorkflow",
					workflowType: "harnessTriageRetentionWorkflow",
					taskQueue: "fabric-harness-triage-v1",
					args: [],
				},
			});
		} catch (error) {
			if (!(error instanceof ScheduleAlreadyRunning)) {
				throw error;
			}
			const schedule = await client.schedule
				.getHandle("fabric-harness-triage-retention-v1")
				.describe();
			if (
				schedule.state.paused ||
				schedule.action.type !== "startWorkflow" ||
				schedule.action.workflowType !==
					"harnessTriageRetentionWorkflow" ||
				schedule.action.taskQueue !== "fabric-harness-triage-v1" ||
				schedule.spec.intervals?.length !== 1 ||
				schedule.spec.intervals[0]?.every !== 3600000
			) {
				throw Error(
					"Private triage retention schedule requires operator attention.",
				);
			}
		}
		const worker = await Worker.create({
			connection,
			namespace: config.namespace,
			taskQueue: "fabric-harness-triage-v1",
			workflowsPath: require.resolve(
				"../workflows/harness-signal-triage",
			),
			activities,
			maxConcurrentActivityTaskExecutions: 4,
		});
		await worker.run();
	} finally {
		await connection.close();
	}
}

export function createHarnessTriageActivities(host: {
	execute(
		input: HarnessTriageWorkflowInput,
		workflowId: string,
		nativeRunId: string,
		signal: AbortSignal,
	): Promise<HarnessTriageWorkflowResult>;
	failed(
		input: HarnessTriageWorkflowInput,
		workflowId: string,
		nativeRunId: string,
	): Promise<void>;
	purge(): Promise<{ purged: number }>;
}): HarnessTriageActivities {
	return {
		executeHarnessTriage: async (input) => {
			const context = Context.current();
			const info = context.info;
			const execution = info.workflowExecution;
			if (!execution) {
				throw ApplicationFailure.nonRetryable(
					"Private triage requires a workflow activity.",
					"TRIAGE_WORKFLOW_REQUIRED",
				);
			}
			const heartbeat = setInterval(() => context.heartbeat(), 5000);
			try {
				return await host.execute(
					input,
					execution.workflowId,
					execution.runId,
					context.cancellationSignal,
				);
			} catch (error) {
				const code =
					error && typeof error === "object" && "code" in error
						? String(error.code)
						: "";
				const permanent =
					[
						"FORBIDDEN",
						"NOT_FOUND",
						"UNAUTHORIZED",
						"INVALID_INPUT",
					].includes(code) || context.cancellationSignal.aborted;
				if (permanent || info.attempt >= 3) {
					try {
						await host.failed(
							input,
							execution.workflowId,
							execution.runId,
						);
					} catch {
						/* Never put private host/database failures in native history. */
					}
				}
				if (permanent) {
					throw ApplicationFailure.nonRetryable(
						"Private signal review cannot continue with current access.",
						"TRIAGE_ACCESS_UNAVAILABLE",
					);
				}
				throw ApplicationFailure.retryable(
					"Private signal review is temporarily unavailable.",
					"TRIAGE_UNAVAILABLE",
				);
			} finally {
				clearInterval(heartbeat);
			}
		},
		purgeExpiredHarnessTriageContent: async () => {
			try {
				return await host.purge();
			} catch {
				throw ApplicationFailure.retryable(
					"Private review cleanup is temporarily unavailable.",
					"TRIAGE_RETENTION_UNAVAILABLE",
				);
			}
		},
	};
}
