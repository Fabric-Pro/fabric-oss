import { ORPCError } from "@orpc/server";
import { db, ORGANIZATION_RETENTION_DAYS } from "@repo/database";
import { logger } from "@repo/logs";
import { sendEmail } from "@repo/mail";
import { getBaseUrl } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { createOrganizationDeletionToken } from "../../lib/deletion-token";

/**
 * Step one of deleting an organization: ask for it (Fizzy #2462).
 *
 * **This procedure deletes nothing.** It checks that the caller may delete, that
 * they typed the organization's name correctly, and then emails them a
 * single-use link. The organization stays completely live until that link is
 * opened — which is what makes the flow safe to trigger by accident.
 *
 * The typed name is re-checked HERE even though the dialog already blocks on it.
 * The client check is an affordance; this one is the gate. Anything that only
 * happens in the browser has not happened.
 */
export const requestOrganizationDeletionProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DELETE))
	.route({
		method: "POST",
		path: "/organizations/deletion/request",
		tags: ["Organizations"],
		summary: "Request deletion and send the confirmation email",
	})
	.input(
		z.object({
			// What the person typed into the dialog. Named for what it is so a
			// future reader does not mistake it for an identifier.
			typedOrganizationName: z.string().min(1),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(undefined, context.session);

		// Defensive only. `tenantProtectedProcedure` + `requirePermission`
		// already refuse a workspace-less caller before this handler runs, and
		// that refusal owns the shared marker sentence — deliberately NOT
		// retyped here, because a source-scanning test pins the set of sites
		// that emit it (see lib/missing-organization-context.ts). This exists to
		// narrow the type, and says something different if it is ever reached.
		if (!organizationId) {
			throw new ORPCError("FORBIDDEN", {
				message: "No organization resolved for this request.",
			});
		}

		const organization = await db.organization.findUnique({
			where: { id: organizationId },
			select: { id: true, name: true, deletedAt: true },
		});

		if (!organization) {
			throw new ORPCError("NOT_FOUND", {
				message: "Organization not found",
			});
		}

		// Already in the corridor. Re-requesting must not restart the clock —
		// that would silently extend the life of something already scheduled to
		// go, and a person watching the countdown would see it jump.
		if (organization.deletedAt) {
			throw new ORPCError("CONFLICT", {
				message: "This organization is already scheduled for deletion.",
			});
		}

		if (input.typedOrganizationName.trim() !== organization.name) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"The name you typed does not match this organization's name.",
			});
		}

		const { token, expiresAt } = await createOrganizationDeletionToken({
			organizationId: organization.id,
			userId: context.user.id,
		});

		const url = new URL(
			"/organizations/confirm-deletion",
			getBaseUrl(),
		);
		url.searchParams.set("token", token);

		try {
			await sendEmail({
				to: context.user.email,
				templateId: "organizationDeletionConfirm",
				context: {
					organizationName: organization.name,
					url: url.toString(),
					retentionDays: ORGANIZATION_RETENTION_DAYS,
				},
			});
		} catch (error) {
			// Surfaced rather than swallowed: the whole flow depends on this
			// mail arriving, and a silent failure would leave someone waiting
			// for a link that was never sent.
			logger.error("[OrgDeletion] confirmation email failed", {
				organizationId: organization.id,
				error: String(error),
			});

			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"We could not send the confirmation email. Please try again.",
			});
		}

		return {
			sent: true,
			// The address is echoed so the UI can say where to look without
			// guessing, and the expiry so it can say how long they have.
			sentTo: context.user.email,
			expiresAt,
		};
	});
