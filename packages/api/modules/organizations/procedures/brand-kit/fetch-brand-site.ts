import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
	brandFetchAttemptSchema,
	runBrandSiteFetch,
} from "../../../../lib/brand-fetch";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertGlossyOrProposalArtifactEnabledForOrganization } from "../../../projects/lib/proposal-artifact-feature";
import { requireOrgMembership } from "../../lib/membership";

/**
 * Fetch the organization's own website for the colours it declares
 * (Fizzy #2946): its brand page, `theme-color` and manifest, into the
 * organization's site fetch row, below the Brand kit. The Brand kit itself is
 * never written.
 *
 * The website is the one stored on the Brand kit; the input carries none.
 * `automatic` marks a call the form made on its own (after a save that
 * changed the website): over the rate limit it is recorded as a failed
 * attempt instead of answering TOO_MANY_REQUESTS.
 *
 * AUTHORIZATION: `ORG_UPDATE` against the requested organization, then admin
 * or owner membership of it, then the rollout gate (GLOSSY_EDITION or
 * PROPOSAL_ARTIFACT), checked after membership so its answer tells an
 * outsider nothing.
 */
export const fetchBrandSiteProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/brand-kit/fetch-site",
		tags: ["Organizations", "Proposal artifact"],
		summary: "Fetch the organization's website brand",
		description:
			"Read the colours the organization's own website declares, from the website stored on its Brand kit, as a source below the Brand kit. Admins and owners only.",
	})
	.input(
		z.object({
			organizationId: z.string(),
			automatic: z.boolean().optional(),
		}),
	)
	.output(z.object({ attempt: brandFetchAttemptSchema.nullable() }))
	.handler(async ({ context, input, signal }) => {
		const { organizationId } = input;

		const membership = await requireOrgMembership(
			context.user.id,
			organizationId,
			["admin", "owner"],
		);
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You must be an admin or owner of this organization",
			});
		}
		await assertGlossyOrProposalArtifactEnabledForOrganization(
			organizationId,
		);

		const attempt = await runBrandSiteFetch({
			organizationId,
			userId: context.user.id,
			automatic: input.automatic ?? false,
			signal,
			context,
		});
		return { attempt };
	});
