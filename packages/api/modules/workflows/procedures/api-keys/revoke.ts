/**
 * Revoke a workflow API key.
 *
 * Deactivates rather than deletes: the verifier filters on `isActive`, so a
 * revoked key stops working immediately, and keeping the row preserves the
 * usage record of a key that may have been leaked — which is exactly what you
 * want to look at after revoking one.
 */

import { ORPCError } from "@orpc/server";
import { db, hasWorkflowAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

export const revokeWorkflowApiKeyProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/workflows/{workflowId}/api-keys/{keyId}/revoke",
		tags: ["Workflows", "API Keys"],
		summary: "Revoke a workflow API key",
		description: "Deactivate an API key so it can no longer trigger runs",
	})
	.input(
		z.object({
			workflowId: z.string(),
			keyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			revoked: z.boolean(),
			message: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		const hasAccess = await hasWorkflowAccess(
			input.workflowId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("NOT_FOUND", { message: "Workflow not found" });
		}

		// Scoped to the workflow so a key id from another workflow cannot be
		// revoked by guessing it.
		const key = await db.workflowApiKey.findFirst({
			where: { id: input.keyId, workflowId: input.workflowId },
		});

		if (!key) {
			throw new ORPCError("NOT_FOUND", { message: "API key not found" });
		}

		if (!key.isActive) {
			return { revoked: false, message: "Key was already revoked" };
		}

		await db.workflowApiKey.update({
			where: { id: key.id },
			data: { isActive: false },
		});

		return { revoked: true };
	});
