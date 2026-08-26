/**
 * Request-Span Retention Workflow
 *
 * Scheduled every 24h (see `packages/temporal/src/schedules.ts`). Purges
 * `request_span` rows older than `FABRIC_REQUEST_SPAN_RETENTION_DAYS`
 * (default 7) by delegating to `purgeExpiredRequestSpansActivity`. The
 * workflow itself contains zero side effects — no env reads, no `Date.now()`,
 * no Prisma calls — so replay stays deterministic (every state change happens
 * inside the activity).
 *
 * SOC 2 C1.2 (data retention / disposal).
 *
 * Registration: the schedule `request-span-retention` is registered on worker
 * startup BY DEFAULT (request spans are ephemeral debug data with a documented
 * TTL); set `FABRIC_REQUEST_SPAN_RETENTION_ENABLED=false` to opt out. The
 * schedule id is stable so re-registration is idempotent.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/request-span-retention";

const { purgeExpiredRequestSpansActivity } = proxyActivities<typeof activities>(
	{
		startToCloseTimeout: "10 minutes",
		retry: {
			// Idempotent in effect — a retry after partial progress just deletes
			// whatever still falls past the cutoff.
			initialInterval: "30 seconds",
			maximumInterval: "5 minutes",
			backoffCoefficient: 2,
			maximumAttempts: 3,
		},
	},
);

export async function requestSpanRetentionWorkflow(): Promise<{
	deletedCount: number;
	cutoffAt: string;
	retentionDays: number;
	hitSafetyCap: boolean;
}> {
	return await purgeExpiredRequestSpansActivity();
}
