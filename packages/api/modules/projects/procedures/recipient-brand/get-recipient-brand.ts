import { getRecipientBrand } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireGlossyOrProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";
import {
	loadRecipientBrandProject,
	presentRecipientBrand,
	recipientBrandOutputSchema,
} from "../../lib/recipient-brand";

/**
 * The project's recipient brand (Fizzy #2589, R32): the party a Glossy
 * edition is prepared for.
 *
 * `version` is what the editor sends back to confirm a change — 0 when the
 * project has none yet — so a confirmation made against a stale read comes
 * back as `conflict` instead of overwriting someone else's (KTD23).
 *
 * AUTHORIZATION: `requireGlossyOrProposalArtifactEnabled` first (GLOSSY_EDITION
 * and PROPOSAL_ARTIFACT both off → NOT_FOUND for every caller), then
 * `requireProjectPermission(DOCUMENT_READ)`, then the shared
 * recipient brand gate (rollout flag, trashed project, project access).
 */
export const getRecipientBrandProcedure = tenantProtectedProcedure
	.use(requireGlossyOrProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/recipient-brand",
		tags: ["Projects", "Glossy"],
		summary: "Get the recipient brand",
		description:
			"The name, website, logo and colors of the party this project's Glossy editions are prepared for.",
	})
	.input(z.object({ projectId: z.string() }))
	.output(
		z.object({
			version: z.number().int(),
			recipientBrand: recipientBrandOutputSchema.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		await loadRecipientBrandProject({
			projectId: input.projectId,
			userId: context.user.id,
			write: false,
		});

		const brand = await getRecipientBrand(input.projectId);
		if (!brand) {
			return { version: 0, recipientBrand: null };
		}
		return {
			version: brand.version,
			recipientBrand: await presentRecipientBrand(brand),
		};
	});
