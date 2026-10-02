import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertCompanyContextEditor,
	isCrawlInFlight,
	loadCompanyContextSourceMeta,
} from "./lib/access";
import { isWorkflowGone } from "./lib/workflows";

/**
 * Cancel a company website source's in-flight crawl (Fizzy #2719) — the
 * company twin of `projects.contexts.cancelUrlSourceCrawl`. A scheduled
 * refresh is cancelled the same way as a crawl this API started: it holds the
 * same slot.
 *
 * The workflow id is read from the source row's crawl slot. The workflow
 * finalizes the source itself on cancellation — pages indexed so far are
 * kept — and clears that id, after which the source can be deleted or
 * re-synced. A workflow Temporal no longer runs (it finished between the
 * click and the cancel, or left its id behind) answers ALREADY_FINISHED and
 * clears the stale id: a recorded id alone makes the source read as in
 * flight, so a stale one would otherwise block every later action.
 *
 * AUTHORIZATION: `ORG_UPDATE` against the requested organization, admin or
 * owner of it, then the company context gate. The source is loaded by
 * `(id, organizationId)`.
 */
export const cancelCompanyContextUrlSourceCrawlProcedure =
	tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.ORG_UPDATE, {
				requireOrganization: true,
			}),
		)
		.route({
			method: "POST",
			path: "/organizations/{organizationId}/company-context/{sourceId}/url-source/cancel",
			tags: ["Organizations", "Company context"],
			summary: "Cancel a company context website crawl",
			description:
				"Cancel the crawl in progress for a company context website source. Pages indexed so far are kept.",
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
			if (source.type !== "LINK") {
				throw new ORPCError("BAD_REQUEST", {
					message: "Only a website source has a crawl to cancel",
				});
			}
			if (!isCrawlInFlight(source)) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"No processing is currently in progress for this website.",
				});
			}

			const workflowId = source.urlActiveWorkflowId;
			if (!workflowId) {
				logger.warn(
					`[CompanyContext] Company source ${sourceId} is ${source.extractionStatus} but records no crawl to cancel`,
				);
				throw new ORPCError("BAD_REQUEST", {
					message:
						"This crawl cannot be cancelled. Wait for it to finish, or contact support if it is stuck.",
				});
			}

			try {
				const client = await getTemporalClient();
				await client.workflow.getHandle(workflowId).cancel();
				logger.info(
					`[CompanyContext] Sent cancel to ${workflowId} for company source ${sourceId}`,
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				if (isWorkflowGone(error)) {
					logger.warn(
						`[CompanyContext] Crawl ${workflowId} is no longer running — likely finished already; clearing it from company source ${sourceId}`,
					);
					// Only while the slot still holds that id: a crawl that
					// claimed it since is live.
					await db.companyContextSource
						.updateMany({
							where: {
								id: sourceId,
								organizationId,
								type: "LINK",
								urlActiveWorkflowId: workflowId,
							},
							data: { urlActiveWorkflowId: null },
						})
						.catch(() => {
							/* a stale id only delays the next action */
						});
					return { sourceId, status: "ALREADY_FINISHED" as const };
				}
				logger.error(
					`[CompanyContext] Failed to cancel ${workflowId}: ${message}`,
				);
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: `Failed to cancel processing: ${message}`,
				});
			}

			return { sourceId, status: "CANCELLING" as const };
		});
