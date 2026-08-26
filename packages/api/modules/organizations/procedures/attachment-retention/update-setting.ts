import { ORPCError } from "@orpc/server";
import { updateOrganizationAttachmentRetention } from "@repo/database";
import {
	MAX_ATTACHMENT_RETENTION_DAYS,
	MIN_ATTACHMENT_RETENTION_DAYS,
} from "@repo/utils/attachment";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../lib/membership";

/**
 * Update an organization's default attachment retention window (Fizzy #1749).
 *
 * Projects inherit this unless they set their own. Shortening it permanently
 * deletes hidden attachments once a 7-day grace period elapses; there is no
 * restore surface.
 *
 * AUTHORIZATION: Requires organization admin or owner role.
 */
export const updateOrganizationAttachmentRetentionProcedure =
	tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_UPDATE))
		.route({
			method: "PUT",
			path: "/organizations/{organizationId}/attachment-retention",
			tags: ["Organizations"],
			summary: "Update organization attachment retention window",
			description:
				"Set or clear the organization-wide retention window for soft-deleted attachments. null restores the server default.",
		})
		.input(
			z.object({
				organizationId: z.string(),
				attachmentRetentionDays: z
					.number()
					.int()
					.min(MIN_ATTACHMENT_RETENTION_DAYS)
					.max(MAX_ATTACHMENT_RETENTION_DAYS)
					.nullable(),
			}),
		)
		.output(
			z.object({
				success: z.boolean(),
				attachmentRetentionDays: z.number().nullable(),
			}),
		)
		.handler(
			async ({
				context,
				input: { organizationId, attachmentRetentionDays },
			}) => {
				// Only admins/owners may change org retention: this window
				// governs irreversible deletion across every inheriting project.
				const membership = await requireOrgMembership(
					context.user.id,
					organizationId,
					["admin", "owner"],
				);
				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message:
							"You must be an admin or owner of this organization",
					});
				}

				const result = await updateOrganizationAttachmentRetention({
					organizationId,
					attachmentRetentionDays,
				});

				// Two positional args, and it is SYNCHRONOUS (returns void) — do
				// not await it. The actor is taken from `context`, which is why
				// this handler destructures `context` whole rather than
				// `context: { user }`.
				recordAuditFromRequest(context, {
					action: "org.settings.updated",
					category: "org",
					organizationId,
					resource: {
						type: "organization",
						id: organizationId,
						name: null,
					},
					metadata: {
						setting: "attachmentRetentionDays",
						value: result.attachmentRetentionDays,
					},
				});

				return {
					success: true,
					attachmentRetentionDays: result.attachmentRetentionDays,
				};
			},
		);
