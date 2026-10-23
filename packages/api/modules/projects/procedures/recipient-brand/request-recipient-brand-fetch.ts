import { z } from "zod";
import {
	brandFetchAttemptSchema,
	runRecipientBrandFetch,
} from "../../../../lib/brand-fetch";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireGlossyOrProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";
import { loadRecipientBrandProject } from "../../lib/recipient-brand";

/**
 * Fetch the recipient's website into the project's recipient suggestion
 * (Fizzy #2946): a logo, colours and the name the site declares, shown as
 * fetched and not applied until a member confirms a field. The recipient
 * brand itself is never written.
 *
 * The website is the one stored on the recipient brand; the input carries
 * none. `automatic` marks a call the Style tab made on its own: over the
 * rate limit it is recorded as a failed attempt instead of answering
 * TOO_MANY_REQUESTS.
 *
 * AUTHORIZATION: `requireGlossyOrProposalArtifactEnabled` first (both
 * rollouts off → NOT_FOUND for every caller), then
 * `requireProjectPermission(DOCUMENT_UPDATE)`, then the recipient brand's
 * write gate, which requires edit access and membership of the owning
 * organization, so a project guest with an editor role is FORBIDDEN.
 */
export const requestRecipientBrandFetchProcedure = tenantProtectedProcedure
	.use(requireGlossyOrProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/recipient-brand/request-fetch",
		tags: ["Projects", "Proposal artifact"],
		summary: "Fetch the recipient's website brand",
		description:
			"Read a logo, colours and name from the website stored on the project's recipient brand, as a suggestion to confirm; nothing is applied. Organization members with edit access only.",
	})
	.input(
		z.object({
			projectId: z.string(),
			automatic: z.boolean().optional(),
		}),
	)
	.output(z.object({ attempt: brandFetchAttemptSchema.nullable() }))
	.handler(async ({ input, context, signal }) => {
		const { organizationId } = await loadRecipientBrandProject({
			projectId: input.projectId,
			userId: context.user.id,
			write: true,
		});

		const attempt = await runRecipientBrandFetch({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			automatic: input.automatic ?? false,
			signal,
			context,
		});
		return { attempt };
	});
