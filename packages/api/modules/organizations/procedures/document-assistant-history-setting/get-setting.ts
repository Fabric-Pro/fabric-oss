/**
 * `organizations.documentAssistantHistory.get` — spec §3.11 FR-27.
 *
 * Surfaces the org-level `documentAssistantHistoryEnabled` flag to the
 * client so the document editor / history drawer affordance can hide
 * itself when the org has opted out. Personal-context callers do NOT
 * hit this procedure — the consuming hook short-circuits to `true`
 * before invoking, because Better Auth's `getFullOrganization` does
 * not carry the column and there is no row to read for personal scope.
 *
 * AUTHORIZATION: ORG_READ — same gate as `delegationSettings.get`. The
 * column is not sensitive (it is a feature flag, not a secret), but we
 * still require org membership so a stranger cannot fingerprint orgs.
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

export const getOrganizationDocumentAssistantHistorySettingProcedure =
	tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_READ))
		.route({
			method: "GET",
			path: "/organizations/{organizationId}/document-assistant-history-setting",
			tags: ["Organizations"],
			summary: "Get document-assistant history feature flag",
			description:
				"Return whether the org has the document-assistant chat-history feature enabled (spec FR-27). Default is `true`.",
		})
		.input(
			z.object({
				organizationId: z.string(),
			}),
		)
		.output(
			z.object({
				documentAssistantHistoryEnabled: z.boolean(),
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
				select: { documentAssistantHistoryEnabled: true },
			});
			// Default to `true` if the row is missing (defensive — should not
			// happen because membership was just verified, but keeps the
			// contract aligned with the schema default).
			return {
				documentAssistantHistoryEnabled:
					org?.documentAssistantHistoryEnabled ?? true,
			};
		});
