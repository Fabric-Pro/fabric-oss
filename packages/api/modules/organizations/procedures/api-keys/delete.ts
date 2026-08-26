/**
 * Delete Organization API Key Procedure
 *
 * Permanently deletes an organization API key. Org owners can delete any key;
 * admins can only delete keys they created themselves.
 */

import { ORPCError } from "@orpc/server";
import { db, deleteOrganizationApiKey } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../lib/membership";

export const deleteOrganizationApiKeyProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DELETE))
	.route({
		method: "DELETE",
		path: "/organizations/{organizationId}/api-keys/{id}",
		tags: ["Organizations", "API Keys"],
		summary: "Delete an organization API key",
		description: "Permanently delete an organization API key",
	})
	.input(
		z.object({
			organizationId: z.string().min(1, "Organization ID is required"),
			id: z.string().min(1, "API key ID is required"),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			message: z.string(),
		}),
	)
	.handler(async ({ context, input }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Check if user is admin/owner of the organization
		const membership = await requireOrgMembership(
			user.id,
			// biome-ignore lint/style/noNonNullAssertion: organizationId is guaranteed by org-protected procedure
			organizationId!,
			["owner", "admin"],
		);

		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "Only organization admins can delete API keys",
			});
		}

		// Owners can delete any key; admins can only delete keys they created.
		const canDeleteAnyKey = membership.role === "owner";

		// Snapshot the key's user-meaningful identifier (name) BEFORE the
		// delete fires so the audit row carries a useful label (D11).
		const snapshot = await db.organizationApiKey.findFirst({
			where: {
				id: input.id,
				// biome-ignore lint/style/noNonNullAssertion: organizationId is guaranteed by org-protected procedure
				organizationId: organizationId!,
			},
			select: { name: true, scopes: true },
		});

		const result = await deleteOrganizationApiKey(
			input.id,
			// biome-ignore lint/style/noNonNullAssertion: organizationId is guaranteed by org-protected procedure
			organizationId!,
			canDeleteAnyKey ? undefined : user.id,
		);

		if (result.count === 0) {
			return {
				success: false,
				message: "API key not found or already deleted",
			};
		}

		// Audit-log emission. Spec uses the "revoked" verb; the
		// procedure path is "delete" because the row is hard-deleted, but the
		// security-meaningful event is revocation of the credential.
		recordAuditFromRequest(context, {
			action: "org.api_key.revoked",
			category: "org",
			organizationId,
			resource: {
				type: "api_key",
				id: input.id,
				name: snapshot?.name ?? null,
			},
			metadata: {
				scopes: snapshot?.scopes ?? null,
			},
		});

		return {
			success: true,
			message: "API key deleted successfully",
		};
	});
