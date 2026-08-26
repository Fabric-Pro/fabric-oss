import { ORPCError } from "@orpc/server";
import { getOrganizationAttachmentRetention } from "@repo/database";
import { DEFAULT_ATTACHMENT_RETENTION_DAYS } from "@repo/utils/attachment";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../lib/membership";

/**
 * Get an organization's default attachment retention window (Fizzy #1749).
 *
 * `effectiveDefault` is the server default the organization falls back to when
 * it has no override. It is returned rather than left to the client so the
 * settings form can show what would apply without holding its own copy of the
 * policy value — there is exactly one definition of it, in `@repo/utils`.
 *
 * AUTHORIZATION: Requires organization membership (any role may read).
 */
export const getOrganizationAttachmentRetentionProcedure =
	tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_READ))
		.route({
			method: "GET",
			path: "/organizations/{organizationId}/attachment-retention",
			tags: ["Organizations"],
			summary: "Get organization attachment retention window",
			description:
				"How long soft-deleted attachments are kept before permanent deletion, for projects that do not set their own window.",
		})
		.input(
			z.object({
				organizationId: z.string(),
			}),
		)
		.output(
			z.object({
				attachmentRetentionDays: z.number().nullable(),
				effectiveDefault: z.number(),
				settingChangedAt: z.date().nullable(),
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

			const stored =
				await getOrganizationAttachmentRetention(organizationId);
			return {
				attachmentRetentionDays: stored.attachmentRetentionDays,
				effectiveDefault: DEFAULT_ATTACHMENT_RETENTION_DAYS,
				settingChangedAt: stored.attachmentRetentionDaysUpdatedAt,
			};
		});
