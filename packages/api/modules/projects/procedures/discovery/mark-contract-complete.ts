/**
 * Mark Integration Contract Complete (plan Slice 4)
 *
 * AUTHORIZATION: requireProjectPermission(DOCUMENT_UPDATE) — project editors.
 *
 * This is the human sign-off that satisfies the DISCOVERY readiness gate:
 * the evidence provider (`hasCompleteIntegrationContract`) looks for an
 * active INTEGRATION_CONTRACT document with status COMPLETE linked to the
 * story. The document status and the run status (CONTRACT_READY →
 * COMPLETED) are written in one transaction.
 *
 * This is the ONLY way a contract's status changes: the generic document
 * update (`updateDocument` in the database package, reached from oRPC, the
 * v1 REST API and the MCP gateway) refuses a status change on an
 * INTEGRATION_CONTRACT, because a generic COMPLETE would satisfy the gate
 * while the run stayed CONTRACT_READY and kept blocking a new discovery run
 * via the one-active-per-story index.
 */

import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const markContractCompleteProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/discovery/contracts/{documentId}/complete",
		tags: ["Projects", "Features", "Discovery"],
		summary: "Mark an integration contract complete (human sign-off)",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			documentId: z.string(),
			storyId: z.string(),
			status: z.literal("COMPLETE"),
			completedRunIds: z.array(z.string()),
		}),
	)
	.handler(async ({ input, context }) => {
		const document = await db.projectDocument.findFirst({
			where: {
				id: input.documentId,
				projectId: input.projectId,
				type: "INTEGRATION_CONTRACT",
			},
			select: { id: true, storyId: true, status: true, isActive: true },
		});
		if (!document) {
			throw new ORPCError("NOT_FOUND", {
				message: "Integration contract not found in this project",
			});
		}
		if (!document.storyId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "This contract is not linked to a feature.",
			});
		}
		if (!document.isActive) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This contract has been superseded by a newer discovery run.",
			});
		}

		const completedRunIds = await db.$transaction(async (tx) => {
			await tx.projectDocument.update({
				where: { id: document.id },
				data: { status: "COMPLETE", lastEditedBy: context.user.id },
			});
			const runs = await tx.discoveryRun.findMany({
				where: { documentId: document.id, status: "CONTRACT_READY" },
				select: { id: true },
			});
			if (runs.length > 0) {
				await tx.discoveryRun.updateMany({
					where: { id: { in: runs.map((run) => run.id) } },
					data: { status: "COMPLETED" },
				});
			}
			return runs.map((run) => run.id);
		});

		return {
			documentId: document.id,
			storyId: document.storyId,
			status: "COMPLETE" as const,
			completedRunIds,
		};
	});
