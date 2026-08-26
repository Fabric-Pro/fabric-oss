import { ORPCError } from "@orpc/server";
import {
	cancelActiveTemplateInstanceExecution,
	deleteTemplateInstanceArtifactsForExecution,
	getOrganizationMembership,
	getTemplateInstanceExecution,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const cancelExecutionInputSchema = z.object({
	executionId: z.string(),
	organizationId: z.string().nullable().optional(),
});

/**
 * Cancel an in-progress report execution. Ordering matters:
 *   1. tenant-isolation gate (NOT_FOUND on any cross-tenant / non-owner personal access)
 *   2. authorization: the execution owner, or an org admin/owner for org-context runs
 *   3. guarded compare-and-set flip to CANCELLED (only while PENDING/RUNNING); a lost
 *      race / already-terminal run returns { cancelled: false } so the caller shows the
 *      real outcome
 *   4. best-effort Temporal terminate() AFTER the flip, so a terminate failure never
 *      orphans the row
 *
 * `getTemplateInstanceExecution` is an unscoped lookup, so the tenant gate — not the
 * lookup — is what enforces isolation; it must run before any owner/admin check.
 */
export const cancelExecutionProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_EXECUTE))
	.input(cancelExecutionInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const execution = await getTemplateInstanceExecution(input.executionId);

		if (!execution) {
			throw new ORPCError("NOT_FOUND", {
				message: "Report execution not found",
			});
		}

		// 1. Tenant-isolation gate — runs before authz so a cross-tenant executionId
		// (or a personal run owned by someone else) is indistinguishable from missing.
		const inTenant = organizationId
			? execution.organizationId === organizationId
			: execution.userId === context.user.id &&
				execution.organizationId === null;

		if (!inTenant) {
			throw new ORPCError("NOT_FOUND", {
				message: "Report execution not found or access denied",
			});
		}

		// 2. Authorization — the run's owner, or an admin/owner of the run's own
		// organization (checked against the stored org, never the input-resolved one).
		// A non-member resolves to NOT_FOUND, not FORBIDDEN, so an outsider cannot use
		// the error code to confirm an execution exists in an org they can't see.
		if (execution.userId !== context.user.id) {
			const membership = execution.organizationId
				? await getOrganizationMembership(
						execution.organizationId,
						context.user.id,
					)
				: null;
			if (!membership) {
				throw new ORPCError("NOT_FOUND", {
					message: "Report execution not found or access denied",
				});
			}
			if (membership.role !== "admin" && membership.role !== "owner") {
				throw new ORPCError("FORBIDDEN", {
					message: "You cannot cancel this report execution",
				});
			}
		}

		// 3. Guarded compare-and-set flip. A lost race (the run reached a terminal
		// state first) leaves the row untouched and is reported as a no-op.
		const cancelled = await cancelActiveTemplateInstanceExecution(
			execution.id,
			{
				cancelledBy: context.user.id,
			},
		);

		if (!cancelled) {
			return { cancelled: false };
		}

		// 4. Discard partial output (Q2/R10): an in-flight storeInstanceArtifact can
		// persist an artifact row (a different table than the guarded status row) up to
		// the moment of cancel. Best-effort — the read path also suppresses artifacts for
		// cancelled runs, so any stray post-cancel insert never surfaces.
		try {
			await deleteTemplateInstanceArtifactsForExecution(execution.id);
		} catch (error) {
			logger.warn("Failed to delete artifacts for cancelled execution", {
				executionId: execution.id,
				error,
			});
		}

		// 5. Best-effort termination AFTER the durable flip. terminate() cannot kill an
		// in-flight activity, and the row is already CANCELLED, so a failure here is safe
		// to swallow — the workflow also self-aborts at its next status write. Logged
		// (structured) so a stuck-after-cancel run is discoverable.
		if (execution.workflowId) {
			try {
				const client = await getTemporalClient();
				await client.workflow
					.getHandle(execution.workflowId)
					.terminate(`Cancelled by ${context.user.id}`);
			} catch (error) {
				logger.warn(
					"Failed to terminate workflow for cancelled execution",
					{
						workflowId: execution.workflowId,
						executionId: execution.id,
						error,
					},
				);
			}
		}

		return { cancelled: true };
	});
