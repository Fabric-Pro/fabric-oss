// XOR-audited 2026-06-11 — organizationId+userId enforced on every query

import { ORPCError } from "@orpc/client";
import {
	finalizeBacklogUpdateSession,
	getPendingBacklogProposal,
	recordAudit,
	stopApplyingProposal,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Cancel a `PendingBacklogProposal` that is stuck mid-apply.
 *
 * The companion to the stuck-apply watchdog (which auto-recovers after
 * `FABRIC_BACKLOG_APPLY_STALE_MINUTES`, default 15): this gives the user an
 * *immediate* out when an apply hangs, so they're never stuck waiting on the
 * cron.
 *
 * Behaviour (robust against a down / unreachable worker):
 *   1. Load proposal, verify project + tenancy.
 *   2. Verify it's actually mid-apply: `status === "PENDING"` AND
 *      `applyStartedAt` set. An awaiting-review proposal has no apply to
 *      cancel — that's a dismiss / reject, not a cancel.
 *   3. Best-effort terminate the apply workflow (swallowed — it may already be
 *      dead / closed / never have started).
 *   4. Compare-and-set `PENDING → FAILED` (errorClass "Cancelled"). The guard
 *      means a workflow finalize that lands first wins and this no-ops.
 *   5. Finalize the session-history row + emit `backlog.proposal.cancelled`.
 *
 * Reuses the FAILED terminal state (not a new enum value) so the existing
 * Retry / Dismiss inbox controls keep working on a cancelled proposal.
 *
 * AUTHORIZATION: `tenantProtectedProcedure` + `PROJECT_UPDATE` — mirrors the
 * retry / dismiss recovery procedures.
 */
export const cancelPendingProposalProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/backlog/proposals/{proposalId}/cancel",
		tags: ["Projects", "Backlog"],
		summary: "Cancel a backlog proposal stuck mid-apply",
		description:
			"Stops a proposal whose apply workflow is hung or never started: best-effort terminates the workflow and flips the row to FAILED so it can be retried or dismissed.",
	})
	.input(
		z.object({
			projectId: z.string(),
			proposalId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			cancelled: z.boolean(),
			message: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// 1. Load proposal + verify scope.
		const proposal = await getPendingBacklogProposal(input.proposalId);
		if (!proposal) {
			throw new ORPCError("NOT_FOUND", { message: "Proposal not found" });
		}
		if (proposal.projectId !== input.projectId) {
			throw new ORPCError("FORBIDDEN", {
				message: "Proposal does not belong to this project",
			});
		}
		// Tenant XOR — compare BOTH the organizationId AND the userId; never
		// short-circuit on a single key.
		const resolvedOrgId = organizationId ?? null;
		const proposalOrgId = proposal.organizationId ?? null;
		if (proposalOrgId !== resolvedOrgId || proposal.userId !== user.id) {
			throw new ORPCError("FORBIDDEN", {
				message: "Proposal does not belong to this tenant",
			});
		}

		// 2. Must be mid-apply. An awaiting-review proposal (no applyStartedAt)
		//    isn't applying — there's nothing to cancel (use dismiss / reject).
		if (proposal.status !== "PENDING" || proposal.applyStartedAt === null) {
			throw new ORPCError("CONFLICT", {
				message:
					proposal.status === "PENDING"
						? "This proposal isn't applying."
						: `Proposal is already '${proposal.status}'.`,
			});
		}

		// 3. Best-effort terminate the (likely-hung) apply workflow so it can't
		//    finalize after we flip the row. Swallowed: it may already be
		//    closed / never started / the worker may be unreachable.
		if (proposal.applyWorkflowId) {
			try {
				const client = await getTemporalClient();
				await client.workflow
					.getHandle(proposal.applyWorkflowId)
					.terminate("cancelled_by_user");
			} catch {
				// Non-fatal — the DB flip below is the real cancel.
			}
		}

		// 4. Compare-and-set PENDING → FAILED. If a workflow finalize raced us
		//    and already moved the row out of PENDING, `count === 0`.
		const stopped = await stopApplyingProposal({
			proposalId: input.proposalId,
			errorClass: "Cancelled",
			errorMessage: "Cancelled by you. You can retry it.",
		});
		if (stopped === 0) {
			return {
				cancelled: false,
				message: "This apply already finished.",
			};
		}

		// 5. Mirror the terminal status onto the session-history row
		//    (best-effort; no-op when no session exists).
		await finalizeBacklogUpdateSession({
			pendingProposalId: input.proposalId,
			status: "FAILED",
		}).catch(() => {
			// Non-fatal: a stuck session row only affects the history tab.
		});

		recordAudit({
			action: "backlog.proposal.cancelled",
			category: "backlog",
			severity: "info",
			outcome: "success",
			actor: { type: "user", userId: user.id },
			organizationId: resolvedOrgId,
			projectId: input.projectId,
			resource: { type: "backlog_proposal", id: input.proposalId },
			metadata: {
				applyWorkflowId: proposal.applyWorkflowId,
			},
		});

		return { cancelled: true, message: "Apply cancelled." };
	});
