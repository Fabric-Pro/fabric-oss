/**
 * Per-tenant cap on workflow executions in flight at once.
 *
 * Nothing bounded this. A workflow's Temporal id is unique per execution row,
 * so the same workflow could be started unboundedly in parallel — a hot
 * webhook, a retry storm from a caller, or a loop in a script would each hold
 * as many worker slots as they could create rows for, starving every other
 * tenant on the shared `workflow-builder` queue.
 *
 * The cap is on *concurrency*, not on total runs: it delays nothing that
 * finishes promptly and only refuses when a tenant already has more work in
 * flight than the queue should give any one of them.
 */

import {
	db,
	type Prisma,
	reserveWorkflowExecution,
	type WorkflowExecution,
	type WorkflowTriggerType,
} from "@repo/database";

/**
 * Fallback ceiling for a single tenant's in-flight executions.
 *
 * Sized against the worker's own limits rather than guessed:
 * `maxConcurrentActivityTaskExecutions` is 10 on the workflow-builder worker,
 * so a tenant at this cap can already saturate it. Generous enough that no
 * legitimate use hits it, low enough that one tenant cannot monopolise the
 * queue.
 */
export const FALLBACK_MAX_CONCURRENT_EXECUTIONS = 25;

/**
 * The instance-wide default, overridable by `WORKFLOW_MAX_CONCURRENT_EXECUTIONS`.
 *
 * The number above is a judgement, not a measurement — it is sized against the
 * worker's concurrency rather than observed load. Making it an environment
 * override means that if it turns out wrong under real traffic it can be
 * corrected without a deploy. An organization's own
 * `OrganizationDeploymentQuota` still takes precedence over both.
 *
 * Read per call rather than cached at module load, so a reloaded config (or a
 * test) sees the current value.
 */
export function resolveDefaultConcurrencyLimit(): number {
	const raw = process.env.WORKFLOW_MAX_CONCURRENT_EXECUTIONS;
	if (!raw) {
		return FALLBACK_MAX_CONCURRENT_EXECUTIONS;
	}
	const parsed = Number.parseInt(raw, 10);
	// A malformed or nonsensical override must not silently disable the guard.
	if (!Number.isFinite(parsed) || parsed < 1) {
		console.warn(
			`[Workflows] Ignoring invalid WORKFLOW_MAX_CONCURRENT_EXECUTIONS="${raw}"; using ${FALLBACK_MAX_CONCURRENT_EXECUTIONS}`,
		);
		return FALLBACK_MAX_CONCURRENT_EXECUTIONS;
	}
	return parsed;
}

/**
 * The ceiling for one tenant: an organization's own
 * `OrganizationDeploymentQuota.maxConcurrentExecutions` (the quota model that
 * already exists for agent deployments — reusing it avoids a second one),
 * otherwise the instance default.
 */
export async function resolveExecutionConcurrencyLimit(
	organizationId?: string | null,
): Promise<number> {
	const quota = organizationId
		? await db.organizationDeploymentQuota.findUnique({
				where: { organizationId },
				select: { maxConcurrentExecutions: true },
			})
		: null;
	return quota?.maxConcurrentExecutions ?? resolveDefaultConcurrencyLimit();
}

export type ConcurrencyReservation =
	| {
			allowed: true;
			execution: WorkflowExecution;
			inFlight: number;
			limit: number;
	  }
	| { allowed: false; inFlight: number; limit: number };

/**
 * Create the PENDING execution row for a run, or refuse because the tenant
 * is at its cap — atomically, so the cap holds under concurrent starts.
 *
 * This replaced a count-then-insert pair (`checkExecutionConcurrency` followed
 * by `createWorkflowExecution`) that every starter performed as two separate
 * statements: N concurrent requests at `limit - 1` all observed one free slot
 * and all inserted. The reservation itself lives in `@repo/database`
 * (`reserveWorkflowExecution`), which explains why it holds a lock; this
 * wrapper only resolves the tenant's limit.
 *
 * Every trigger surface — the in-app start, the v1 REST trigger, the webhook,
 * the chat-confirmed start and the MCP gateway tool — goes through this, so
 * the cap means the same thing on all of them.
 */
export async function createExecutionWithinConcurrencyCap(args: {
	userId: string;
	organizationId?: string | null;
	data: {
		workflowId: string;
		version: number;
		triggerType: WorkflowTriggerType;
		triggerInput?: Prisma.InputJsonValue;
	};
}): Promise<ConcurrencyReservation> {
	const limit = await resolveExecutionConcurrencyLimit(args.organizationId);
	const result = await reserveWorkflowExecution({
		userId: args.userId,
		organizationId: args.organizationId,
		limit,
		data: args.data,
	});
	if (!result.reserved) {
		return {
			allowed: false,
			inFlight: result.inFlight,
			limit: result.limit,
		};
	}
	return {
		allowed: true,
		execution: result.execution,
		inFlight: result.inFlight,
		limit: result.limit,
	};
}

/** The refusal every surface phrases the same way. */
export function concurrencyRefusalMessage(reservation: {
	inFlight: number;
	limit: number;
}): string {
	return `This workspace already has ${reservation.inFlight} workflow executions running (limit ${reservation.limit}). Wait for one to finish, or cancel one.`;
}
