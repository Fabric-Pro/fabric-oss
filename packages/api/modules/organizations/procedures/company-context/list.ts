import { listCompanyContextSources } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertCompanyContextReader } from "./lib/access";
import {
	describeCompanyModel,
	isCompanySourceDeleting,
	loadCompanySourceIndexState,
	needsCompanySourceReprocessing,
	resolveCurrentCompanyModel,
} from "./lib/source-state";

/**
 * List the organization's company context sources (Fizzy #2719), newest
 * first and without their content.
 *
 * Each source carries its processing state as a project source does, plus:
 * - `ready`: it is retrievable — the same predicate retrieval and the
 *   empty-context notice use, under the organization's current embedding
 *   model;
 * - `needsReprocessing`: it, or one of its crawled pages, was indexed with a
 *   model that is no longer the organization's, so it is not retrieved until
 *   `reprocess` re-embeds it. A source that is merely not ready yet — still
 *   processing, or refreshing on its schedule — is not flagged;
 * - `crawlInProgress`: a crawl of the website holds its slot, whether this API
 *   started it or its refresh schedule did;
 * - `deleting`: a delete of the source has started. It stays listed until the
 *   deletion workflow removes it, is never ready or offered for
 *   re-processing, and can only be deleted again.
 *
 * `embeddingModel` is that current model, or null when no embedding provider
 * is configured (then nothing is ready).
 *
 * AUTHORIZATION: `ORG_READ` against the requested organization, membership of
 * it, then the company context gate. Any member reads; a project guest is not
 * a member.
 */
export const listCompanyContextSourcesProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/company-context",
		tags: ["Organizations", "Company context"],
		summary: "List company context sources",
		description:
			"The files, texts and websites the organization maintains about itself for Proposals and Business Cases, with each source's processing and retrieval state.",
	})
	.input(z.object({ organizationId: z.string().min(1) }))
	.handler(async ({ context: { user }, input: { organizationId } }) => {
		await assertCompanyContextReader(organizationId, user.id);

		const [sources, model] = await Promise.all([
			listCompanyContextSources(organizationId),
			resolveCurrentCompanyModel(organizationId, user.id),
		]);
		const indexState = await loadCompanySourceIndexState(
			organizationId,
			model,
		);

		return {
			sources: sources.map(
				({ _count, urlActiveWorkflowId, deletingAt, ...source }) => ({
					...source,
					urlPageCount: _count.urlPages,
					crawlInProgress: urlActiveWorkflowId !== null,
					deleting: isCompanySourceDeleting({ deletingAt }),
					ready: indexState.readyIds.has(source.id),
					needsReprocessing: needsCompanySourceReprocessing(
						{ ...source, urlActiveWorkflowId, deletingAt },
						indexState,
						model,
					),
				}),
			),
			embeddingModel: describeCompanyModel(model),
		};
	});
