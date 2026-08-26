import { ORPCError } from "@orpc/server";
import {
	getTemplateInstanceArtifact,
	listTemplateInstanceArtifactEmailDeliveries,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertArtifactTenantAccess } from "./_tenant";

const listDeliveriesInputSchema = z.object({
	artifactId: z.string(),
	organizationId: z.string().nullable().optional(),
	/**
	 * Case-insensitive substring match on the recipient address or the
	 * sender's note. Empty / whitespace-only strings are ignored.
	 */
	search: z.string().max(200).optional(),
	/** Number of distinct *send actions* to return (each may have N recipients). */
	limit: z.number().int().min(1).max(100).default(25),
	offset: z.number().int().min(0).default(0),
});

/**
 * Per-artifact email send history. One entry per Send-button click (all
 * recipients of one click are grouped together via `sendId`). Backs the
 * "Send history" dialog next to the Send button in the Execution History
 * tab. Authorization mirrors the parent artifact: any member of the org
 * that owns the artifact (or the personal owner) can read the full log.
 */
export const listArtifactDeliveriesProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
	.input(listDeliveriesInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const artifact = await getTemplateInstanceArtifact(input.artifactId);

		if (!artifact) {
			throw new ORPCError("NOT_FOUND", {
				message: "Report artifact not found",
			});
		}

		assertArtifactTenantAccess(artifact, {
			userId: context.user.id,
			organizationId,
		});

		const { sends, total } =
			await listTemplateInstanceArtifactEmailDeliveries({
				artifactId: input.artifactId,
				search: input.search,
				limit: input.limit,
				offset: input.offset,
			});

		return {
			sends,
			total,
			hasMore: input.offset + sends.length < total,
		};
	});
