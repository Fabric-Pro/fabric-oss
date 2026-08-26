import { ORPCError } from "@orpc/server";
import {
	approveNewsletterSend,
	db,
	getNewsletterSendForSendPhase,
	newsletterContentSchema,
	removedHighlightIndexesSchema,
} from "@repo/database";
import { getTemporalClient, isTemporalAvailable } from "@repo/temporal";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { classifyReviewOutcome } from "../lib/review-outcome";

/**
 * A row that cannot take this decision. `currentStatus` rides along so the
 * client can log/telemeter what it actually hit; the human explanation is the
 * message, which `classifyReviewOutcome` has already tailored to the state.
 */
function reviewConflict(message: string, currentStatus: string | null) {
	return new ORPCError("CONFLICT", { message, data: { currentStatus } });
}

/**
 * Guards the two paths that actually reach Temporal — the fresh transition and
 * the APPROVED re-kick.
 *
 * Deliberately NOT a blanket preflight. It used to run before the row was even
 * read, which meant an already-SENT row answered "Temporal is not available"
 * instead of the neutral "already sent" notice — a red banner on a stale row,
 * i.e. the exact thing #2172 exists to remove (Copilot review). A conflict and
 * an already-sent no-op need no workflow, so they must not depend on Temporal
 * being reachable.
 *
 * On the fresh path it still has to run BEFORE the conditional update commits:
 * transitioning to APPROVED and only then discovering we cannot dispatch would
 * strand the send, which is why the check existed early in the first place.
 */
async function requireTemporal() {
	if (!(await isTemporalAvailable())) {
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Temporal is not available",
		});
	}
}

async function startApprovedSendWorkflow(
	sendId: string,
	projectId: string,
	projectName: string,
) {
	const client = await getTemporalClient();
	try {
		await client.workflow.start("sendApprovedNewsletterWorkflow", {
			...withCorrelationMemo({
				taskQueue: "fabric-worker",
				workflowId: `newsletter-send-${sendId}-approved`,
				args: [{ sendId, projectId, projectName }],
				workflowExecutionTimeout: "15m",
			}),
		});
	} catch (err) {
		// Deterministic id already running (concurrent/retry approve) → no-op.
		if (err instanceof WorkflowExecutionAlreadyStartedError) {
			return;
		}
		throw err;
	}
}

export const approveSendProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			sendId: z.string(),
			removedHighlightIndexes: removedHighlightIndexesSchema.default([]),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const project = await db.project.findFirst({
			where: organizationId
				? { id: input.projectId, organizationId }
				: {
						id: input.projectId,
						organizationId: null,
						userId: context.user.id,
					},
			select: { id: true, name: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		const row = await getNewsletterSendForSendPhase(input.sendId);
		if (!row || row.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", { message: "Send not found" });
		}

		// A stale review row is the NORMAL case here, not an error: the pending
		// list is cached, so by the time Approve is clicked the send may already
		// have been approved (another tab, a colleague, a double-click) or sent.
		// Classify instead of failing (Fizzy #2172).
		const preflight = classifyReviewOutcome("approve", row.status);
		if (preflight.kind === "incompatible") {
			throw reviewConflict(preflight.message, row.status);
		}
		if (preflight.kind === "satisfied") {
			// Recovery path: an already-APPROVED row may have been stranded by a
			// workflow.start that failed AFTER the DB transition, so re-kick the
			// deterministic id. Frozen indexes are authoritative — any re-submitted
			// removedHighlightIndexes is ignored.
			//
			// SENT/PARTIAL deliberately start NOTHING: they are terminal, and
			// dispatching there is precisely the double-send this gate exists to
			// prevent (AC4). The status check is what keeps the two apart — and
			// is why only this branch needs Temporal.
			if (row.status === "APPROVED") {
				await requireTemporal();
				await startApprovedSendWorkflow(
					input.sendId,
					project.id,
					project.name,
				);
			}
			return {
				sendId: input.sendId,
				approved: true,
				outcome: "already_resolved" as const,
				notice: preflight.notice,
			};
		}

		// Validate the removed set against the frozen content BEFORE transitioning.
		const content = newsletterContentSchema.parse(row.content);
		const maxIndex = content.highlights.length;
		if (input.removedHighlightIndexes.some((i) => i >= maxIndex)) {
			throw new ORPCError("BAD_REQUEST", {
				message: "removedHighlightIndexes out of range",
			});
		}

		// Last check before the point of no return: once the row flips to
		// APPROVED it is never rolled back (see the forward-only recovery note
		// below), so an unreachable Temporal has to stop the request here rather
		// than after the transition has already committed.
		await requireTemporal();

		// Atomic PENDING_APPROVAL → APPROVED + audit (closes the approve/reject race
		// AND commits the audit row in the same tx as the decision).
		const { approved } = await approveNewsletterSend({
			sendId: input.sendId,
			removedHighlightIndexes: input.removedHighlightIndexes,
			audit: {
				reviewedByUserId: context.user.id,
				actorEmail: context.user.email ?? null,
				actorName: context.user.name ?? null,
				organizationId: project.organizationId ?? null,
				projectId: input.projectId,
			},
		});
		if (!approved) {
			// Raced between the read above and this conditional update — the row
			// moved on. Re-read to report what it actually became rather than
			// asserting "no longer awaiting review" without looking.
			//
			// No workflow is started on this branch even when the winner left the
			// row APPROVED: that approver owns the dispatch, and a row stranded by
			// their failed start is already surfaced in the review list as
			// "Sending…" with a Retry action.
			const current = await getNewsletterSendForSendPhase(input.sendId);
			const raced = classifyReviewOutcome(
				"approve",
				current?.status ?? "",
			);
			if (raced.kind === "satisfied") {
				return {
					sendId: input.sendId,
					approved: true,
					outcome: "already_resolved" as const,
					notice: raced.notice,
				};
			}
			throw reviewConflict(
				raced.kind === "incompatible"
					? raced.message
					: // "proceed" means the row reads PENDING_APPROVAL again, which
						// no transition produces. Report the race honestly instead of
						// claiming a state we did not observe.
						"This newsletter was decided by someone else while you were reviewing it.",
				current?.status ?? null,
			);
		}

		try {
			await startApprovedSendWorkflow(
				input.sendId,
				project.id,
				project.name,
			);
		} catch (err) {
			// Forward-only recovery: do NOT roll back. An ambiguous start error may
			// mean Temporal ACCEPTED the deterministic workflow (client/RPC failed
			// after the server took it); rolling APPROVED → PENDING_APPROVAL could
			// reopen the row for reject/retry while the worker is already delivering
			// (Codex re-review). Leave it APPROVED — it shows as "Sending…" in the
			// pending list and the idempotent re-kick (approve on APPROVED) recovers
			// a genuinely unstarted send; a truly-running one finalizes itself.
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to start send: ${err instanceof Error ? err.message : "Unknown error"}`,
			});
		}
		return {
			sendId: input.sendId,
			approved: true,
			outcome: "approved" as const,
			notice: null,
		};
	});
