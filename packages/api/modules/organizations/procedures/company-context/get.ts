import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertCompanyContextReader,
	loadCompanyContextSource,
} from "./lib/access";
import {
	isCompanySourceDeleting,
	loadCompanySourceIndexState,
	needsCompanySourceReprocessing,
	resolveCurrentCompanyModel,
} from "./lib/source-state";

/**
 * Get one company context source with its content (Fizzy #2719).
 *
 * The storage key, the vector id and the Temporal ids stay server-side; a
 * file is downloaded through `createDownloadUrl`. `ready`,
 * `needsReprocessing` and `deleting` mean what they mean in `list`.
 *
 * AUTHORIZATION: `ORG_READ` against the requested organization, membership of
 * it, then the company context gate. The source is loaded by
 * `(id, organizationId)`, so another organization's id is NOT_FOUND.
 */
export const getCompanyContextSourceProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/company-context/{sourceId}",
		tags: ["Organizations", "Company context"],
		summary: "Get a company context source",
		description:
			"One company context source with its extracted or pasted content.",
	})
	.input(
		z.object({
			organizationId: z.string().min(1),
			sourceId: z.string().min(1),
		}),
	)
	.handler(async ({ context: { user }, input }) => {
		const { organizationId, sourceId } = input;
		await assertCompanyContextReader(organizationId, user.id);

		const {
			s3Path: _s3Path,
			s3Bucket: _s3Bucket,
			qdrantId: _qdrantId,
			urlScheduleId: _urlScheduleId,
			urlActiveWorkflowId,
			deletingAt,
			...source
		} = await loadCompanyContextSource(sourceId, organizationId);

		const model = await resolveCurrentCompanyModel(organizationId, user.id);
		const indexState = await loadCompanySourceIndexState(
			organizationId,
			model,
		);

		return {
			source: {
				...source,
				crawlInProgress: urlActiveWorkflowId !== null,
				deleting: isCompanySourceDeleting({ deletingAt }),
				ready: indexState.readyIds.has(source.id),
				needsReprocessing: needsCompanySourceReprocessing(
					{ ...source, urlActiveWorkflowId, deletingAt },
					indexState,
					model,
				),
			},
		};
	});
