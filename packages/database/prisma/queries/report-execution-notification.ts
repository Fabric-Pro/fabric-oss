/**
 * Helper that emits the one-shot REPORT_COMPLETED / REPORT_FAILED in-app
 * notification when a report (template instance) execution reaches a terminal
 * status. Called from the temporal execution workflow via a retryable activity.
 * Fizzy #1692.
 *
 * Design (spec: docs/superpowers/specs/2026-06-22-report-run-notifications-design.md):
 *   - Exactly-once: the per-execution claim (notificationEmittedAt) and the
 *     notification.create run in a SINGLE db.$transaction, so duplicates are
 *     impossible under worker-crash / ambiguous-commit / read-archive races. The
 *     claim predicate also requires the PERSISTED status to equal the announced
 *     status, so a notification cannot commit if the status write never landed.
 *   - Tenant + link correct without a slug lookup: organizationId is copied from
 *     the execution; the link is stored context-relative and the inbox re-bases it
 *     from organizationId (resolveNotificationLink).
 *
 * Enum values are passed as string literals (matching project-service-alert-digest.ts);
 * the Prisma create types accept them.
 */
import { db } from "../client";

export interface EmitReportExecutionNotificationInput {
	executionId: string;
	status: "COMPLETED" | "FAILED";
}

export async function emitReportExecutionNotification(
	input: EmitReportExecutionNotificationInput,
): Promise<void> {
	const { executionId, status } = input;

	// Defensive — only terminal statuses emit a completion notification.
	if (status !== "COMPLETED" && status !== "FAILED") {
		return;
	}

	const execution = await db.templateInstanceExecution.findUnique({
		where: { id: executionId },
		select: {
			userId: true,
			organizationId: true,
			instanceId: true,
			notificationEmittedAt: true,
			instance: { select: { name: true } },
		},
	});

	// No recipient — nothing a retry can fix; return (never throw).
	if (!execution || !execution.userId) {
		return;
	}
	// Fast-path idempotent skip — avoids opening a tx when already emitted.
	if (execution.notificationEmittedAt) {
		return;
	}

	const userId = execution.userId;
	const organizationId = execution.organizationId;
	const instanceId = execution.instanceId;
	const instanceName = execution.instance?.name ?? "Report";
	const isSuccess = status === "COMPLETED";

	const title = isSuccess
		? `Report "${instanceName}" is ready`
		: `Report "${instanceName}" failed`;
	// The failure snippet is intentionally GENERIC — the raw workflow error must
	// not reach the bell (it can contain stack markers, paths, workflow/activity
	// names, opaque IDs; the report UI sanitizes via humanizeReportError, which
	// lives in apps/web and cannot be imported here). The humanized details live in
	// the linked Execution History tab (sourced from execution.error). AC2 only
	// requires the bell to indicate failure and link to those details.
	const snippet = isSuccess
		? "Your report finished generating"
		: "Open Execution History to see what went wrong";

	// Context-relative link — the inbox prepends /app or /app/{slug} from the
	// notification's organizationId (resolveNotificationLink). BOTH links carry an
	// explicit ?tab so the destination is unambiguous even on same-instance
	// navigation: success → Overview (shows the artifact), failure → Execution
	// History. A tab-less link could not reset a manually-changed tab (the param
	// would not change), so success must say ?tab=overview, not omit it.
	const link = isSuccess
		? `report-templates/instances/${instanceId}?tab=overview`
		: `report-templates/instances/${instanceId}?tab=history`;

	// No raw error in the payload — the notification list API returns the payload
	// to the client, so it is UI-reachable. Diagnostics stay in execution.error.
	const payload = { executionId, instanceId, instanceName, status };

	// Atomic claim + create — exactly-once, read/archive-independent. The claim
	// predicate also requires the persisted status to match `status`, so a
	// notification cannot commit if the status write never landed (the FAILED path
	// in the workflow swallows status-write failures). count === 0 ⇒ already
	// claimed OR not in the announced status yet ⇒ skip. Any error rolls back the
	// whole tx and rethrows so the caller can retry a clean re-run.
	await db.$transaction(async (tx) => {
		const { count } = await tx.templateInstanceExecution.updateMany({
			where: { id: executionId, status, notificationEmittedAt: null },
			data: { notificationEmittedAt: new Date() },
		});
		if (count === 0) {
			return;
		}
		await tx.notification.create({
			data: {
				userId,
				organizationId,
				type: isSuccess ? "REPORT_COMPLETED" : "REPORT_FAILED",
				category: "SYSTEM",
				title,
				snippet,
				link,
				payload,
			},
		});
	});
}
