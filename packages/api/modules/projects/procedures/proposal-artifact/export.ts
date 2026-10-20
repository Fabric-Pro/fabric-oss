import { randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { isProposalInternalReader } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient, PROPOSAL_EXPORT_TASK_QUEUE } from "@repo/temporal";
import {
	PROPOSAL_EXPORT_FORMATS,
	PROPOSAL_EXPORT_ID_PREFIX,
	PROPOSAL_EXPORT_MEMO_KEY,
	PROPOSAL_EXPORT_UNSUPPORTED_CODE,
	PROPOSAL_EXPORT_WORKFLOW_TYPE,
	type ProposalExportMemo,
	type ProposalExportWorkflowInput,
} from "@repo/temporal/proposal-export-types";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { checkRateLimit } from "../../../../lib/rate-limit";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadProposalExportDocument } from "../../lib/proposal-artifact-access";

/**
 * Exports per user per window. Each one holds a headless browser in the
 * worker for seconds, so the bound is per person, whoever's organization
 * owns the document.
 */
export const PROPOSAL_EXPORT_RATE_LIMIT = {
	limit: 10,
	windowMs: 10 * 60_000,
} as const;

/**
 * Room for both of the activity's attempts, their backoff and the queue
 * wait; past it the workflow is closed and the status read reports it.
 */
const PROPOSAL_EXPORT_EXECUTION_TIMEOUT = "10 minutes";

function proposalExportRateLimitKey(userId: string): string {
	return `proposal-export:user:${userId}`;
}

/**
 * Start a server-side export of a client-document Proposal to PDF or Word
 * (Fizzy #2946). Members and project guests alike may export what they can
 * read: the worker reads the brand through the guest-safe resolver, so style
 * direction and Brand kit guidance never reach the file, and the scrubber
 * removes citation markers and any Source Index.
 *
 * In order: `DOCUMENT_READ`; the project, the document's place in it and the
 * caller's reach (NOT_FOUND on any failure, one message); then the
 * client-document predicate, whose failure is BAD_REQUEST with
 * {@link PROPOSAL_EXPORT_UNSUPPORTED_CODE} so the menu falls back to the
 * export every other document uses. Deliberately no Proposal-artifact gate
 * middleware: it would answer NOT_FOUND for a gate-off organization, and a
 * gate-off Proposal must keep exporting the way it does today.
 *
 * The returned id is the workflow's id; its memo binds it to the caller,
 * organization, project and document, so the status read needs no table.
 */
export const exportProposalProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/exports",
		tags: ["Projects", "Proposal artifact"],
		summary: "Export the Proposal",
		description:
			"Starts a PDF or Word export of a client-document Proposal and returns its id. Poll the export's status for a download link.",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			format: z.enum(PROPOSAL_EXPORT_FORMATS),
		}),
	)
	.output(z.object({ exportId: z.string() }))
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const { document, organizationId, isClientDocument } =
			await loadProposalExportDocument({
				projectId: input.projectId,
				documentId: input.documentId,
				userId,
			});
		if (!isClientDocument) {
			throw new ORPCError("BAD_REQUEST", {
				message: "This document is exported in the browser.",
				data: { code: PROPOSAL_EXPORT_UNSUPPORTED_CODE },
			});
		}

		const rateLimit = await checkRateLimit(
			proposalExportRateLimitKey(userId),
			PROPOSAL_EXPORT_RATE_LIMIT.limit,
			PROPOSAL_EXPORT_RATE_LIMIT.windowMs,
		);
		if (!rateLimit.allowed) {
			if (rateLimit.statusCode === 503) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "Rate limit service temporarily unavailable",
				});
			}
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `Too many exports. Please try again in ${rateLimit.resetInSeconds} seconds.`,
				data: { retryAfter: rateLimit.resetInSeconds },
			});
		}

		// A member of the owning organization reads the internal tabs; anyone
		// else who reached this far is a project guest.
		const isGuest = !(await isProposalInternalReader({
			organizationId,
			documentType: document.type,
			userId,
		}));

		const exportId = `${PROPOSAL_EXPORT_ID_PREFIX}${randomBytes(16).toString("hex")}`;
		const memo: ProposalExportMemo = {
			userId,
			organizationId,
			projectId: input.projectId,
			documentId: document.id,
			format: input.format,
		};
		const workflowInput: ProposalExportWorkflowInput = {
			exportId,
			...memo,
		};
		try {
			const client = await getTemporalClient();
			await client.workflow.start(
				PROPOSAL_EXPORT_WORKFLOW_TYPE,
				withCorrelationMemo({
					taskQueue: PROPOSAL_EXPORT_TASK_QUEUE,
					workflowId: exportId,
					workflowExecutionTimeout: PROPOSAL_EXPORT_EXECUTION_TIMEOUT,
					workflowIdConflictPolicy: "FAIL",
					workflowIdReusePolicy: "REJECT_DUPLICATE",
					memo: { [PROPOSAL_EXPORT_MEMO_KEY]: memo },
					args: [workflowInput],
				}),
			);
		} catch (error) {
			logger.error(
				{
					event: "proposal_export.start_failed",
					organizationId,
					projectId: input.projectId,
					documentId: document.id,
					exportId,
					errorName: error instanceof Error ? error.name : "unknown",
				},
				"The Proposal export could not be started",
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "The export could not be started.",
			});
		}

		recordAuditFromRequest(context, {
			action: "project.proposal_artifact.export_started",
			category: "project",
			outcome: "success",
			organizationId,
			projectId: input.projectId,
			resource: { type: "project_document", id: document.id, name: null },
			metadata: { format: input.format, exportId, guest: isGuest },
		});

		return { exportId };
	});
