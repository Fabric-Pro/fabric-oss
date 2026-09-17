/**
 * `organizations.featureMaturationV2.get` — Feature Maturation V2 spec §9.
 *
 * Surfaces the org-level `featureMaturationV2Enabled` column to the client so
 * the feature editor can route an organization to the three-tab V2 editor.
 * The column defaults to **true** (#1797) — V2 is rolled out to every
 * organization — and remains the per-organization kill switch: an organization
 * flipped to false by SQL gets the single-document editor instead.
 * Personal-context callers do NOT hit this procedure — there is no
 * organization row to read, so the consuming hook skips the request and enrols
 * personal workspaces unconditionally (#1797).
 *
 * AUTHORIZATION: ORG_READ — same gate as `documentAssistantHistory.get`. The
 * column is a feature flag (not a secret), but org membership is still required
 * so a stranger cannot fingerprint which orgs have V2 enabled.
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../lib/membership";

export const getOrganizationFeatureMaturationV2SettingProcedure =
	tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_READ))
		.route({
			method: "GET",
			path: "/organizations/{organizationId}/feature-maturation-v2-setting",
			tags: ["Organizations"],
			summary: "Get Feature Maturation V2 feature flag",
			description:
				"Return whether the org has the three-tab Feature Maturation V2 editor enabled. The column defaults to `true`.",
		})
		.input(
			z.object({
				organizationId: z.string(),
			}),
		)
		.output(
			z.object({
				featureMaturationV2Enabled: z.boolean(),
			}),
		)
		.handler(async ({ context: { user }, input: { organizationId } }) => {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}

			const org = await db.organization.findUnique({
				where: { id: organizationId },
				select: { featureMaturationV2Enabled: true },
			});
			// `false` if the row is missing. Defensive only: membership was just
			// verified, so the row is expected to exist. This differs from the
			// column default (`true` since #1797): a missing row is not an
			// organization that was rolled out to.
			return {
				featureMaturationV2Enabled:
					org?.featureMaturationV2Enabled ?? false,
			};
		});
