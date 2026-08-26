/**
 * List a workflow's API keys.
 *
 * Returns the identifying prefix and usage metadata, never the hash and never
 * anything from which the key could be reconstructed.
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

export const listWorkflowApiKeysProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/workflows/{workflowId}/api-keys",
		tags: ["Workflows", "API Keys"],
		summary: "List workflow API keys",
		description: "List the API keys that can trigger this workflow",
	})
	.input(
		z.object({
			workflowId: z.string(),
			organizationId: z.string().nullable().optional(),
			includeRevoked: z.boolean().default(false),
		}),
	)
	.output(
		z.array(
			z.object({
				id: z.string(),
				name: z.string(),
				keyPrefix: z.string(),
				permissions: z.array(z.string()),
				expiresAt: z.date().nullable(),
				lastUsedAt: z.date().nullable(),
				usageCount: z.number(),
				isActive: z.boolean(),
				createdAt: z.date(),
			}),
		),
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

		const keys = await db.workflowApiKey.findMany({
			where: {
				workflowId: input.workflowId,
				...(input.includeRevoked ? {} : { isActive: true }),
			},
			orderBy: { createdAt: "desc" },
			// Explicit select rather than a spread: keyHash must never leave
			// the database, and an implicit shape would leak it the moment a
			// column is added.
			select: {
				id: true,
				name: true,
				keyPrefix: true,
				permissions: true,
				expiresAt: true,
				lastUsedAt: true,
				usageCount: true,
				isActive: true,
				createdAt: true,
			},
		});

		return keys;
	});
