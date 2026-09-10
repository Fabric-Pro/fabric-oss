import { ORPCError } from "@orpc/server";
import {
	db,
	ORGANIZATION_RETENTION_DAYS,
	softDeleteOrganization,
} from "@repo/database";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { protectedProcedure } from "../../../../orpc/procedures";
import {
	consumeOrganizationDeletionToken,
	revokeOrganizationDeletionTokens,
} from "../../lib/deletion-token";

/**
 * Step two: spend the emailed token and put the organization into the corridor
 * (Fizzy #2462, AC-6).
 *
 * `protectedProcedure`, NOT `tenantProtectedProcedure`, and that is deliberate.
 * The person arrives here by following a link from their mail client, so their
 * session's active organization may be anything at all — or nothing. The token
 * names the organization; the session only has to prove who is holding it.
 *
 * Which means the permission check cannot come from the tenant middleware and is
 * done explicitly below, against the caller's membership in the organization the
 * token names. Re-checked at redemption rather than trusted from mint time: an
 * owner can be demoted in the hour a token is valid, and a demoted owner must
 * not still be able to spend one.
 */
export const confirmOrganizationDeletionProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/organizations/deletion/confirm",
		tags: ["Organizations"],
		summary: "Confirm a requested deletion and deactivate the organization",
	})
	.input(z.object({ token: z.string().min(1) }))
	.handler(async ({ input, context }) => {
		const payload = await consumeOrganizationDeletionToken(input.token);

		// One message for unknown, expired, already-spent and malformed. Telling
		// someone which way their token failed tells an attacker the same thing,
		// and none of the four is separately actionable for an honest user.
		if (!payload) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This confirmation link is no longer valid. Start the deletion again to get a new one.",
			});
		}

		if (payload.userId !== context.user.id) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"This confirmation link was issued to a different account.",
			});
		}

		const membership = await db.member.findFirst({
			where: {
				organizationId: payload.organizationId,
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

		if (!membership?.organization) {
			throw new ORPCError("NOT_FOUND", {
				message: "Organization not found",
			});
		}

		// The same permission the request step required, resolved again now.
		if (
			!hasPermission(
				resolveOrgPermissions(membership.role),
				Permissions.ORG_DELETE,
			)
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only an organization owner can delete this organization.",
			});
		}

		// Someone else already confirmed it. Report success rather than an
		// error: the caller asked for it to be deleted and it is deleted.
		if (membership.organization.deletedAt) {
			return {
				success: true,
				organizationName: membership.organization.name,
				retentionDays: ORGANIZATION_RETENTION_DAYS,
				alreadyDeleted: true,
			};
		}

		const organization = await softDeleteOrganization({
			organizationId: payload.organizationId,
			deletedByUserId: context.user.id,
		});

		// Any other outstanding link for this organization dies here, so a
		// second tab or a forwarded mail cannot re-delete after a restore.
		await revokeOrganizationDeletionTokens(payload.organizationId);

		recordAuditFromRequest(context, {
			action: "org.deleted",
			category: "org",
			organizationId: payload.organizationId,
			resource: {
				type: "organization",
				id: payload.organizationId,
				name: organization.name ?? null,
			},
			metadata: {
				softDeleted: true,
				scheduledPermanentDeleteAt:
					organization.scheduledPermanentDeleteAt?.toISOString() ??
					null,
			},
		});

		return {
			success: true,
			organizationName: organization.name,
			retentionDays: ORGANIZATION_RETENTION_DAYS,
			scheduledPermanentDeleteAt: organization.scheduledPermanentDeleteAt,
			alreadyDeleted: false,
		};
	});
