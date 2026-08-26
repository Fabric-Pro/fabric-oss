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

import { db } from "@repo/database";

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

/** Statuses that mean "occupying a worker slot right now". */
const IN_FLIGHT_STATUSES = ["PENDING", "RUNNING"] as const;

export interface ConcurrencyCheck {
	allowed: boolean;
	inFlight: number;
	limit: number;
}

/**
 * Count a tenant's in-flight executions and compare against the cap.
 *
 * Organization-scoped when there is an organization, otherwise scoped to the
 * user — matching the XOR tenancy the rest of the module uses, so a personal
 * workflow cannot consume an organization's headroom or vice versa.
 *
 * An organization may raise its own ceiling through
 * `OrganizationDeploymentQuota.maxConcurrentExecutions`, which already exists
 * for agent deployments; reusing it avoids a second quota model.
 */
export async function checkExecutionConcurrency(args: {
	userId: string;
	organizationId?: string | null;
}): Promise<ConcurrencyCheck> {
	const tenantFilter = args.organizationId
		? { organizationId: args.organizationId }
		: { userId: args.userId, organizationId: null };

	const [inFlight, quota] = await Promise.all([
		db.workflowExecution.count({
			where: {
				...tenantFilter,
				status: { in: [...IN_FLIGHT_STATUSES] },
			},
		}),
		args.organizationId
			? db.organizationDeploymentQuota.findUnique({
					where: { organizationId: args.organizationId },
					select: { maxConcurrentExecutions: true },
				})
			: Promise.resolve(null),
	]);

	const limit =
		quota?.maxConcurrentExecutions ?? resolveDefaultConcurrencyLimit();

	return { allowed: inFlight < limit, inFlight, limit };
}
