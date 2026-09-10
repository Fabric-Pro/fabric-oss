import { ORPCError } from "@orpc/server";
import {
	db,
	ORGANIZATION_RETENTION_DAYS,
	softDeleteOrganization,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import { adminProcedure } from "../../../orpc/procedures";

/**
 * Platform-admin deletion of any organization (Fizzy #2462).
 *
 * Exists because the admin console used to call the auth library's
 * `/organization/delete`, which is now refused so the retention window cannot be
 * skipped. Rather than granting the console an exemption, it gets the same
 * corridor: the organization is deactivated, stays restorable for the retention
 * window, and is purged by the same scheduled worker. A platform admin deleting
 * a tenant by mistake is exactly as recoverable as an owner doing it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is require the emailed confirmation the
 * owner-facing flow requires. That link proves the requester is the person who
 * asked, by sending it to the account's own address — which cannot work here,
 * because a platform admin is acting on an organization they typically hold no
 * membership in and whose owner they are not. The proof that replaces it is
 * `adminProcedure` itself plus the audit row written below, which names the
 * acting admin.
 */
export const adminDeleteOrganizationProcedure = adminProcedure
	.route({
		method: "POST",
		path: "/admin/organizations/delete",
		tags: ["Admin"],
		summary:
			"Deactivate an organization, with the standard retention window",
	})
	.input(z.object({ organizationId: z.string().min(1) }))
	.handler(async ({ input, context }) => {
		const organization = await db.organization.findUnique({
			where: { id: input.organizationId },
			select: { id: true, name: true, slug: true, deletedAt: true },
		});

		if (!organization) {
			throw new ORPCError("NOT_FOUND", {
				message: "Organization not found",
			});
		}

		// Re-deleting must not restart the clock — that would quietly extend the
		// life of something already scheduled to go.
		if (organization.deletedAt) {
			throw new ORPCError("CONFLICT", {
				message: "This organization is already scheduled for deletion.",
			});
		}

		const deleted = await softDeleteOrganization({
			organizationId: organization.id,
			deletedByUserId: context.user.id,
		});

		recordAuditFromRequest(context, {
			action: "org.deleted",
			category: "org",
			organizationId: organization.id,
			resource: {
				type: "organization",
				id: organization.id,
				name: organization.name ?? null,
			},
			metadata: {
				softDeleted: true,
				viaPlatformAdmin: true,
				scheduledPermanentDeleteAt:
					deleted.scheduledPermanentDeleteAt?.toISOString() ?? null,
			},
		});

		return {
			success: true,
			retentionDays: ORGANIZATION_RETENTION_DAYS,
			scheduledPermanentDeleteAt: deleted.scheduledPermanentDeleteAt,
		};
	});
