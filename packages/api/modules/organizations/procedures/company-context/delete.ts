import { ORPCError } from "@orpc/server";
import { db, getCompanyContextSourceMeta } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { contextAuditResourceName } from "../../../projects/lib/context-metadata-audit";
import {
	assertCompanyContextEditor,
	isCrawlInFlight,
	loadCompanyContextSourceMeta,
} from "./lib/access";
import { startCompanyContextDeletion } from "./lib/workflows";

/**
 * What a source reads while its deletion runs, beside the tombstone. Not
 * COMPLETED, so anything reading only the status sees it as not usable
 * either. Terminal rather than in flight, so nothing reads it as processing.
 */
const DELETING_STATUS = "FAILED" as const;

/** Recorded beside the status; only seen if the deletion does not finish. */
const COMPANY_SOURCE_DELETING_MESSAGE =
	"This source is being deleted. If it is still listed, delete it again.";

/**
 * Remove a source from the organization's company context (Fizzy #2719) — the
 * company twin of `projects.contexts.delete`.
 *
 * A website source whose crawl is queued or running — one this API started,
 * or a scheduled refresh holding the crawl slot — answers CONFLICT until the
 * crawl is cancelled, as a project's does: a running crawl would keep writing
 * pages against a deleted source, and leave pages and vectors behind.
 *
 * The deletion itself is durable: a workflow removes the website's refresh
 * schedule, the source's vectors — its own and every crawled page's — then
 * its stored file, then the row, whose pages go with it. The row is left for
 * the workflow to delete, because it needs it for those steps; nothing is
 * removed here before the workflow has started, so a start that fails leaves
 * the source whole, schedule included — but tombstoned, see below.
 *
 * Before the start the source is tombstoned: `deletingAt` is set, beside a
 * "being deleted" status. From then on it is out of retrieval, and nothing
 * starts new work on it — re-processing, a re-sync, a scheduled crawl — nor
 * marks it embedded or completed; a run already going finds its late writes
 * refused and removes the vectors it wrote. The tombstone is written in one
 * conditional write, only while the source is not tombstoned, no crawl holds
 * it and its status is the one checked above: a crawl or re-sync that claims
 * the source in between wins and the delete answers CONFLICT. Of two deletes
 * racing for one source exactly one tombstones it; both then start the same
 * deterministic deletion, so neither answers success unless a deletion is
 * known to run. A start that fails keeps the tombstone — its outcome may be
 * unknown, with the deletion already under way — and asks for the delete to
 * be repeated.
 *
 * A source already tombstoned — an earlier delete whose workflow gave up —
 * starts its deletion again, whatever its status: nothing can claim a
 * tombstoned source, so an in-flight status on one is a late write, not a
 * running crawl. The deletion workflow's id is deterministic per source, so a
 * deletion still running answers "already started", which is success too.
 *
 * AUTHORIZATION: `ORG_UPDATE` against the requested organization, admin or
 * owner of it, then the company context gate. The source is loaded by
 * `(id, organizationId)`, so another organization's id is NOT_FOUND.
 */
export const deleteCompanyContextSourceProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "DELETE",
		path: "/organizations/{organizationId}/company-context/{sourceId}",
		tags: ["Organizations", "Company context"],
		summary: "Delete a company context source",
		description:
			"Remove a source from the organization's company context, with its crawled pages, stored file and search index entries.",
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
		const deletion = {
			source,
			organizationId,
			userId: user.id,
			contextName: contextAuditResourceName(source),
			deletedBy: user.name || user.email || user.id,
		};

		if (source.deletingAt !== null) {
			await startDeletionKeepingTombstone(deletion);
			return { success: true as const, sourceId };
		}

		if (isCrawlInFlight(source)) {
			throw new ORPCError("CONFLICT", {
				message:
					"Processing is currently running for this website. Cancel it before deleting the source.",
			});
		}

		const deletingAt = new Date();
		const { count: marked } = await db.companyContextSource.updateMany({
			where: {
				id: sourceId,
				organizationId,
				deletingAt: null,
				extractionStatus: source.extractionStatus,
				urlActiveWorkflowId: null,
			},
			data: {
				deletingAt,
				extractionStatus: DELETING_STATUS,
				extractionError: COMPANY_SOURCE_DELETING_MESSAGE,
			},
		});
		if (marked === 0) {
			const current = await getCompanyContextSourceMeta(
				sourceId,
				organizationId,
			);
			if (!current?.deletingAt) {
				throw new ORPCError("CONFLICT", {
					message:
						"This source changed while it was being deleted. Reload the page and try again.",
				});
			}
			// Another delete tombstoned it first. It may not have reached its
			// start, so start the same deterministic deletion rather than
			// trusting the tombstone alone.
		}

		await startDeletionKeepingTombstone(deletion);
		return { success: true as const, sourceId };
	});

/**
 * Start the source's deletion workflow; one already running counts as
 * started. A failure never clears the tombstone: a start can reach Temporal
 * and still time out here, so the deletion may already be removing vectors
 * and files, and a source put back in use would lose them mid-flight. The
 * tombstoned source stays out of retrieval, and deleting it again retries.
 */
async function startDeletionKeepingTombstone(
	deletion: Parameters<typeof startCompanyContextDeletion>[0],
): Promise<void> {
	try {
		await startCompanyContextDeletion(deletion);
	} catch (error) {
		logger.error(
			`[CompanyContext] Failed to start deletion of company source ${deletion.source.id}: ${error}`,
		);
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message:
				"Failed to start deleting the source. Delete it again to retry.",
		});
	}
}
