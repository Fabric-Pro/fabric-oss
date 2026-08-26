// XOR-audited 2026-05-28 — organizationId+userId enforced on every query

import { ORPCError } from "@orpc/client";
import { db, getPendingBacklogProposal } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

interface StoredChange {
	type: "epic" | "feature" | "story" | "bug";
	action: "create" | "update";
	title: { from?: string | null; to: string };
	[key: string]: unknown;
}

interface StoredSourceMetadata {
	syncToPM?: boolean;
	pmConfig?: { mcpConfigId: string; containerId: string } | null;
	conversationId?: string | null;
	[key: string]: unknown;
}

/**
 * Dismiss a FAILED `PendingBacklogProposal` row.
 *
 * Behavior:
 *   1. Load proposal, verify status === FAILED + tenant XOR.
 *   2. In a single transaction:
 *      - Write a `PmSyncLog` row preserving the failure for audit (the
 *        Sync History tab reads from this table). `errorPayload` carries
 *        the full original change payload + the classified failure
 *        metadata so the audit row is self-contained.
 *      - Hard-delete the proposal row.
 *
 * No UserStory is touched — dismissal is a metadata-only operation. The
 * `pmAutoSyncEnabled` gate on any existing story is left untouched.
 *
 * AUTHORIZATION: `tenantProtectedProcedure` + `PROJECT_UPDATE`.
 */
export const dismissFailedProposalProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/backlog/proposals/{proposalId}/dismiss",
		tags: ["Projects", "Backlog"],
		summary: "Dismiss a failed backlog proposal",
		description:
			"Writes a PmSyncLog audit row and hard-deletes the proposal in a single transaction",
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
			success: z.boolean(),
			syncLogId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const proposal = await getPendingBacklogProposal(input.proposalId);
		if (!proposal) {
			throw new ORPCError("NOT_FOUND", {
				message: "Proposal not found",
			});
		}
		if (proposal.projectId !== input.projectId) {
			throw new ORPCError("FORBIDDEN", {
				message: "Proposal does not belong to this project",
			});
		}
		// Tenant XOR — both organizationId AND userId must match. A
		// non-matching pair leaks no row data in the error payload, only
		// the generic FORBIDDEN message.
		const resolvedOrgId = organizationId ?? null;
		const proposalOrgId = proposal.organizationId ?? null;
		if (proposalOrgId !== resolvedOrgId || proposal.userId !== user.id) {
			throw new ORPCError("FORBIDDEN", {
				message: "Proposal does not belong to this tenant",
			});
		}
		if (proposal.status !== "FAILED") {
			throw new ORPCError("CONFLICT", {
				message: `Proposal is in '${proposal.status}' state, not FAILED`,
			});
		}

		// Build the audit payload BEFORE the transaction — pure data prep
		// so the transaction stays short.
		const proposalPayload = proposal.proposal as {
			changes?: unknown;
		} | null;
		const storedChanges: StoredChange[] = Array.isArray(
			proposalPayload?.changes,
		)
			? (proposalPayload?.changes as StoredChange[])
			: [];
		const sourceMetadata = (proposal.sourceMetadata ??
			{}) as StoredSourceMetadata;
		const pmTool = sourceMetadata.pmConfig?.mcpConfigId ?? "none";
		const firstChangeTitle =
			storedChanges[0]?.title?.to?.slice(0, 500) ??
			proposal.summary.slice(0, 500);
		// PmSyncLogStatus uses FAILURE while PendingBacklogProposalStatus uses
		// FAILED — distinct enums by design.
		const errorPayload = {
			errorClass: proposal.errorClass ?? null,
			errorMessage: proposal.errorMessage ?? null,
			applyError: proposal.applyError ?? null,
			changes: storedChanges,
		};

		const syncLog = await db.$transaction(async (tx) => {
			// No UserStory mutation here — dismissal is metadata-only and
			// MUST NOT touch `pmAutoSyncEnabled` on any related story.
			const log = await tx.pmSyncLog.create({
				data: {
					direction: "push",
					entityType: "STORY",
					entityId: "",
					title: firstChangeTitle,
					pmTool,
					status: "FAILURE",
					errorPayload: errorPayload as unknown as object,
					actorUserId: user.id,
					correlationId: proposal.applyWorkflowId,
					projectId: input.projectId,
					organizationId: proposal.organizationId,
					userId: proposal.userId,
				},
			});
			await tx.pendingBacklogProposal.delete({
				where: { id: input.proposalId },
			});
			return log;
		});

		return {
			success: true,
			syncLogId: syncLog.id,
		};
	});
