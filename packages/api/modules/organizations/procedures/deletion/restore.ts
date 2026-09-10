import { ORPCError } from "@orpc/server";
import { db, restoreOrganization } from "@repo/database";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { protectedProcedure } from "../../../../orpc/procedures";
import { revokeOrganizationDeletionTokens } from "../../lib/deletion-token";

/**
 * Bring a deactivated organization back (Fizzy #2462, AC-6).
 *
 * `protectedProcedure` and an explicit membership check, for the same reason as
 * `confirm`: the caller cannot possibly have this organization as their active
 * one — it refuses at tenant resolution, which is the entire point of the
 * corridor. So the tenant middleware cannot supply the target and the id has to
 * be an input. What keeps that safe is that the lookup below is filtered by the
 * caller's OWN membership, so naming someone else's organization finds nothing.
 *
 * Gated on `ORG_DELETE` rather than a restore permission of its own, matching
 * `restore-project.ts`, which does the same thing deliberately. It means an
 * organization can never end up with someone who is able to destroy it but not
 * to undo that.
 */
export const restoreOrganizationProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/organizations/deletion/restore",
		tags: ["Organizations"],
		summary: "Restore an organization inside its retention window",
	})
	.input(z.object({ organizationId: z.string().min(1) }))
	.handler(async ({ input, context }) => {
		const membership = await db.member.findFirst({
			where: {
				organizationId: input.organizationId,
				userId: context.user.id,
			},
			select: {
				role: true,
				organization: {
					select: {
						id: true,
						name: true,
						slug: true,
						deletedAt: true,
					},
				},
			},
		});

		// NOT_FOUND rather than FORBIDDEN for a non-member: confirming that an
		// organization exists is itself information a non-member should not get.
		if (!membership?.organization) {
			throw new ORPCError("NOT_FOUND", {
				message: "Organization not found",
			});
		}

		if (
			!hasPermission(
				resolveOrgPermissions(membership.role),
				Permissions.ORG_DELETE,
			)
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only an organization owner can restore this organization.",
			});
		}

		if (!membership.organization.deletedAt) {
			throw new ORPCError("BAD_REQUEST", {
				message: "This organization is not deleted.",
			});
		}

		const organization = await restoreOrganization({
			organizationId: input.organizationId,
		});

		// A link minted before the restore must not still be spendable, or a
		// stale mail could re-delete what someone just deliberately brought back.
		await revokeOrganizationDeletionTokens(input.organizationId);

		recordAuditFromRequest(context, {
			action: "org.restored",
			category: "org",
			organizationId: organization.id,
			resource: {
				type: "organization",
				id: organization.id,
				name: organization.name ?? null,
			},
			metadata: { slug: organization.slug ?? null },
		});

		return {
			success: true,
			organization: {
				id: organization.id,
				name: organization.name,
				slug: organization.slug,
			},
		};
	});
