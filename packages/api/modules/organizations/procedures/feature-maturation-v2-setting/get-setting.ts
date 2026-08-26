/**
 * `organizations.featureMaturationV2.get` — Feature Maturation V2 spec §9.
 *
 * Surfaces the org-level `featureMaturationV2Enabled` flag (default **false**,
 * PR #1643) to the client so the feature editor can route a flagged org to the
 * three-tab V2 editor and leave a non-flagged org on the unchanged v1
 * single-doc `StoryWorkspace`. Personal-context callers do NOT hit this
 * procedure — the consuming hook short-circuits to `false` before invoking,
 * because Better Auth's `getFullOrganization` does not carry the column and
 * personal features stay v1 (§9).
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
				"Return whether the org has the three-tab Feature Maturation V2 editor enabled. Default is `false`.",
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
			// Default to `false` if the row is missing (defensive — membership
			// was just verified, but keeps the contract aligned with the schema
			// default: V2 is opt-in, off until an org turns it on).
			return {
				featureMaturationV2Enabled:
					org?.featureMaturationV2Enabled ?? false,
			};
		});
