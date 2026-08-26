/**
 * Audit Log Sealing Workflow
 *
 * Scheduled hourly (see `packages/temporal/src/schedules.ts`). Advances the
 * audit_log tamper-evidence seal chain by delegating to `sealAuditLogActivity`.
 * The workflow body has zero side effects — no env reads, no `Date.now()`, no
 * Prisma calls — so replay stays deterministic. Every non-deterministic action
 * (clock, env, DB) happens inside the activity.
 *
 * Replay validation: per CLAUDE.md, any change under
 * `packages/temporal/src/workflows/**` triggers CI replay validation
 * (`.github/workflows/temporal-replay-validation.yml`) on PRs. Local re-run:
 *
 *   pnpm --filter @repo/temporal fetch:replay-histories
 *   pnpm --filter @repo/temporal test:replay
 *
 * Registration: the `audit-log-seal` schedule is registered on worker startup
 * only when `FABRIC_AUDIT_LOG_SEALING_ENABLED === "true"`. The schedule id is
 * stable so re-registration is idempotent (ScheduleAlreadyRunning catch).
 *
 * See: docs/audit-log/README.md §10
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/audit-log-seal";
import type { SealRunResult } from "../activities/audit-log-seal";

const { sealAuditLogActivity } = proxyActivities<typeof activities>({
	// The genesis run streams all history; 10 minutes is ample. Subsequent
	// hourly runs cover a single window and finish in seconds.
	startToCloseTimeout: "10 minutes",
	retry: {
		// Idempotent by construction (sequence unique). A few attempts is
		// enough; the next scheduled run continues the chain regardless.
		initialInterval: "30 seconds",
		maximumInterval: "5 minutes",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

/**
 * Audit Log Sealing workflow. Deterministic outer: one activity call.
 */
export async function auditLogSealWorkflow(): Promise<SealRunResult> {
	return await sealAuditLogActivity();
}
