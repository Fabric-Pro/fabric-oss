/**
 * Weave Execution Watchdog Activities
 *
 * The activities behind `weaveExecutionWatchdogWorkflow` — the 5-minute
 * cron that catches `WeaveExecution` / `CodingRun` rows whose workflows
 * exited ungracefully (force-terminated, OOM, worker crash, dropped
 * connection) and never got their non-cancellable cleanup block to run.
 *
 * Activity boundary: every Prisma write and Temporal client call lives
 * here, NOT in the workflow. The workflow only orchestrates the
 * sequencing so it stays replay-safe under the post-1.16 SDK rules.
 */

import { db, recordAudit } from "@repo/database";
import type { Client } from "@temporalio/client";
import { getTemporalClient } from "../../client";

export interface StaleWeaveRow {
	kind: "weave" | "coding_run";
	id: string;
	sessionId: string | null;
	provider: string;
	userId: string;
	organizationId: string | null;
	workflowId: string;
	startedAtMs: number;
}

export interface FindStaleWeaveSessionsInput {
	staleAfterMinutes: number;
	batchSize: number;
}

export interface FindStaleWeaveSessionsOutput {
	rows: StaleWeaveRow[];
}

const WEAVE_NON_TERMINAL = [
	"PENDING",
	"RUNNING",
	"PAUSED",
	"CHECKPOINT",
] as const;
const CODING_NON_TERMINAL = [
	"QUEUED",
	"STARTING",
	"RUNNING",
	"AWAITING_REVIEW",
	"PR_OPENED",
] as const;

/**
 * Scan both tables for non-terminal rows whose `startedAt` is older than
 * the configured ceiling. Returns at most `batchSize` rows per table to
 * keep each watchdog tick bounded; if the system is in trouble we'd
 * rather make incremental progress than try and fail to clean up
 * thousands of rows in one tick.
 *
 * Reads `WEAVE_MAX_RUN_MINUTES` from env when `input.staleAfterMinutes`
 * is 0 / undefined / negative, so the workflow body stays free of
 * `process.env` reads (which are non-deterministic in Temporal workflows
 * under SDK 1.16 + reuseV8Context).
 */
export async function findStaleWeaveSessions(
	input: FindStaleWeaveSessionsInput,
): Promise<FindStaleWeaveSessionsOutput> {
	const envCeiling = Number.parseInt(
		process.env.WEAVE_MAX_RUN_MINUTES ?? "120",
		10,
	);
	const effectiveMinutes =
		input.staleAfterMinutes > 0
			? input.staleAfterMinutes
			: Number.isFinite(envCeiling) && envCeiling > 0
				? envCeiling
				: 120;
	const cutoff = new Date(Date.now() - effectiveMinutes * 60_000);

	const [weaveRows, codingRows] = await Promise.all([
		db.weaveExecution.findMany({
			where: {
				status: { in: WEAVE_NON_TERMINAL as unknown as never[] },
				startedAt: { lt: cutoff, not: null },
			},
			take: input.batchSize,
			select: {
				id: true,
				sandboxSessionId: true,
				userId: true,
				organizationId: true,
				startedAt: true,
				workflowId: true,
			},
		}),
		db.codingRun.findMany({
			where: {
				status: { in: CODING_NON_TERMINAL as unknown as never[] },
				startedAt: { lt: cutoff, not: null },
			},
			take: input.batchSize,
			select: {
				id: true,
				providerSessionId: true,
				userId: true,
				organizationId: true,
				startedAt: true,
				provider: true,
				workflowId: true,
			},
		}),
	]);

	const rows: StaleWeaveRow[] = [
		...weaveRows
			.filter((r) => r.startedAt !== null && r.workflowId.length > 0)
			.map<StaleWeaveRow>((r) => ({
				kind: "weave",
				id: r.id,
				sessionId: r.sandboxSessionId,
				// WeaveExecution doesn't persist provider; the workflow that
				// owns this row only delegates to BACKGROUND_AGENTS today.
				provider: "BACKGROUND_AGENTS",
				userId: r.userId,
				organizationId: r.organizationId,
				workflowId: r.workflowId,
				// biome-ignore lint/style/noNonNullAssertion: filtered above
				startedAtMs: r.startedAt!.getTime(),
			})),
		...codingRows
			.filter((r) => r.startedAt !== null && !!r.workflowId)
			.map<StaleWeaveRow>((r) => ({
				kind: "coding_run",
				id: r.id,
				sessionId: r.providerSessionId,
				provider: r.provider,
				userId: r.userId,
				organizationId: r.organizationId,
				// biome-ignore lint/style/noNonNullAssertion: filtered above
				workflowId: r.workflowId!,
				// biome-ignore lint/style/noNonNullAssertion: filtered above
				startedAtMs: r.startedAt!.getTime(),
			})),
	];

	return { rows };
}

export interface CancelWeaveExecutionViaSignalInput {
	workflowId: string;
	kind: "weave" | "coding_run";
	/** Override the default 60s wait — handy for tests. */
	waitForTerminalMs?: number;
}

/**
 * Try the polite path first: send the workflow's own cancel signal and
 * wait up to `waitForTerminalMs` for it to reach a terminal state. The
 * workflow's `try/finally` runs the cleanup activity, the audit row is
 * written via the happy path, and we never have to force-terminate.
 *
 * Returns `true` when the workflow acknowledged. The caller falls
 * through to `terminateWeaveWorkflow` when this returns `false`.
 */
export async function cancelWeaveExecutionViaSignal(
	input: CancelWeaveExecutionViaSignalInput,
): Promise<boolean> {
	const waitMs = input.waitForTerminalMs ?? 60_000;
	let client: Client;
	try {
		client = await getTemporalClient();
	} catch {
		return false;
	}

	try {
		const handle = client.workflow.getHandle(input.workflowId);
		const signalName =
			input.kind === "weave" ? "cancel" : "cancelCodingRun";
		await handle.signal(signalName);

		const terminated = await Promise.race<boolean>([
			handle
				.result()
				.then(() => true)
				.catch(() => true),
			new Promise<boolean>((resolve) =>
				setTimeout(() => resolve(false), waitMs),
			),
		]);
		return terminated;
	} catch {
		// Workflow may not exist any more (already terminated / never
		// started). Let the caller decide whether to terminate.
		return false;
	}
}

export interface TerminateWeaveWorkflowInput {
	workflowId: string;
	reason: string;
}

/**
 * Force-terminate the workflow. Idempotent: a workflow that's already
 * terminal is a no-op (we swallow the resulting error).
 */
export async function terminateWeaveWorkflow(
	input: TerminateWeaveWorkflowInput,
): Promise<void> {
	let client: Client;
	try {
		client = await getTemporalClient();
	} catch {
		return;
	}
	try {
		await client.workflow
			.getHandle(input.workflowId)
			.terminate(input.reason);
	} catch {
		// Already terminal / non-existent — fine.
	}
}

export interface MarkWeaveExecutionStaleInput {
	kind: "weave" | "coding_run";
	id: string;
	/**
	 * Tenant the row belongs to. Threaded through to the audit-log entry
	 * so the warning lands inside the org's audit scope rather than
	 * leaking into the system namespace.
	 */
	organizationId: string | null;
	sessionId: string | null;
	runDurationMs: number;
}

/**
 * Flip the row to `TERMINATED_STALE` only if it's still in a
 * non-terminal status — uses `updateMany` with a status guard so we
 * don't overwrite a terminal state the workflow's own `finally` block
 * may have raced us to. When the guard prevents the update
 * (`count === 0`), we skip the audit entry too — the workflow already
 * wrote a `terminated_on_exit` entry, and a duplicate
 * `terminated_stale` would be misleading noise.
 */
export async function markWeaveExecutionStale(
	input: MarkWeaveExecutionStaleInput,
): Promise<void> {
	const ceilingEnv =
		input.kind === "weave"
			? "WEAVE_MAX_RUN_MINUTES"
			: "CODING_RUN_MAX_MINUTES";
	const reasonMessage = `killed by watchdog: exceeded ${ceilingEnv}`;

	let updatedCount = 0;
	if (input.kind === "weave") {
		const result = await db.weaveExecution
			.updateMany({
				where: {
					id: input.id,
					status: { in: WEAVE_NON_TERMINAL as unknown as never[] },
				},
				data: {
					status: "TERMINATED_STALE",
					error: reasonMessage,
					completedAt: new Date(),
				},
			})
			.catch(() => ({ count: 0 }));
		updatedCount = result.count;
	} else {
		const result = await db.codingRun
			.updateMany({
				where: {
					id: input.id,
					status: { in: CODING_NON_TERMINAL as unknown as never[] },
				},
				data: {
					status: "TERMINATED_STALE",
					lastError: reasonMessage,
				},
			})
			.catch(() => ({ count: 0 }));
		updatedCount = result.count;
	}

	if (updatedCount === 0) {
		// Workflow's own finally already flipped the row to a terminal
		// state — the polite teardown won the race (and its cleanup
		// activity also reconciles the parent plan). No stale-kill audit
		// needed.
		return;
	}

	if (input.kind === "weave") {
		// The stale execution leaves its parent plan wedged in RUNNING —
		// restore it to APPROVED so the plan's Execute buttons come back
		// and `hasActivePlans` unblocks. Guarded (status: RUNNING) and
		// swallowed in the activity's existing idempotency style: the
		// stale-kill audit below must still be written even if this
		// reconcile fails.
		await db.weavePlan
			.updateMany({
				where: {
					status: "RUNNING",
					executions: { some: { id: input.id } },
				},
				data: { status: "APPROVED" },
			})
			.catch(() => {
				// Swallow — the next watchdog tick can retry.
			});
	}

	recordAudit({
		action: "weave.session.terminated_stale",
		category: "weave",
		severity: "warning",
		outcome: "success",
		actor: { type: "system", nameSnapshot: "weave-watchdog" },
		organizationId: input.organizationId,
		resource:
			input.kind === "weave"
				? { type: "weave_execution", id: input.id }
				: { type: "coding_run", id: input.id },
		metadata: {
			sessionId: input.sessionId,
			runDurationMs: input.runDurationMs,
			reason: reasonMessage,
		},
	});
}
