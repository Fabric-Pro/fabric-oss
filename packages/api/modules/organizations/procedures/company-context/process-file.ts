import { ORPCError } from "@orpc/server";
import {
	claimCompanyFileSourceForProcessing,
	releaseCompanyContextSourceClaim,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertCompanyContextEditor,
	loadCompanyContextSourceMeta,
} from "./lib/access";
import { isCompanySourceDeleting } from "./lib/source-state";
import {
	isWorkflowAlreadyStarted,
	startCompanyFileProcessing,
} from "./lib/workflows";

const FILE_DELETING_MESSAGE =
	"This file is being deleted, so it cannot be processed.";

/**
 * Start extracting and embedding an uploaded company context file
 * (Fizzy #2719) — the company twin of `projects.contexts.processFile`.
 *
 * The file is claimed before anything starts, in one write that sets it
 * EXTRACTING only while it is still PENDING and not being deleted. A delete
 * that tombstones the file between the read and the claim wins: the claim
 * misses, the request answers CONFLICT and nothing starts. So does a request
 * that loses the claim to another one processing the same file. The workflow
 * id is deterministic per source as well, so a start that finds the first
 * run still going reports it as in progress rather than starting a second. A
 * start that fails puts the file back to PENDING — unless a delete has
 * tombstoned it since, whose status then stays. A company source has no Job
 * Hub row; its state lives on the source.
 *
 * AUTHORIZATION: `ORG_UPDATE` against the requested organization, admin or
 * owner of it, then the company context gate. The source is loaded by
 * `(id, organizationId)`.
 */
export const processCompanyContextFileProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/company-context/{sourceId}/process",
		tags: ["Organizations", "Company context"],
		summary: "Process an uploaded company context file",
		description:
			"Start text extraction and embedding for a company context file whose upload has finished.",
	})
	.input(
		z.object({
			organizationId: z.string().min(1),
			sourceId: z.string().min(1),
		}),
	)
	.handler(async ({ context: { user }, input }) => {
		const { organizationId, sourceId } = input;
		await assertCompanyContextEditor(organizationId, user.id);

		const source = await loadCompanyContextSourceMeta(
			sourceId,
			organizationId,
		);
		if (source.type !== "FILE" || !source.s3Path) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Only an uploaded file can be processed",
			});
		}
		if (isCompanySourceDeleting(source)) {
			throw new ORPCError("CONFLICT", { message: FILE_DELETING_MESSAGE });
		}
		if (source.extractionStatus !== "PENDING") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot process a source with status: ${source.extractionStatus}`,
			});
		}

		if (
			!(await claimCompanyFileSourceForProcessing({
				id: sourceId,
				organizationId,
			}))
		) {
			// Tombstoned, or claimed by another request, since the read.
			const current = await loadCompanyContextSourceMeta(
				sourceId,
				organizationId,
			);
			throw new ORPCError("CONFLICT", {
				message: isCompanySourceDeleting(current)
					? FILE_DELETING_MESSAGE
					: `Cannot process a source with status: ${current.extractionStatus}`,
			});
		}

		try {
			await startCompanyFileProcessing({
				sourceId,
				organizationId,
				userId: user.id,
			});
		} catch (error) {
			if (isWorkflowAlreadyStarted(error)) {
				return {
					sourceId,
					status: "EXTRACTING" as const,
					message: "File processing already in progress",
				};
			}

			await releaseCompanyContextSourceClaim({
				id: sourceId,
				organizationId,
				status: "PENDING",
			});
			logger.error(
				`[CompanyContext] Failed to start processing for company source ${sourceId}: ${error}`,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to start file processing",
			});
		}

		return {
			sourceId,
			status: "EXTRACTING" as const,
			message: "File processing started",
		};
	});
