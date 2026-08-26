/**
 * List Organization API Keys Procedure
 *
 * Returns API keys for the organization (without the raw key values).
 * Org owners see every key; every other role only sees keys they created.
 */

import { ORPCError } from "@orpc/server";
import { listOrganizationApiKeys } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../lib/membership";

export const listOrganizationApiKeysProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_READ))
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/api-keys",
		tags: ["Organizations", "API Keys"],
		summary: "List all organization API keys",
		description: "Get all API keys for the organization",
	})
	.input(
		z.object({
			organizationId: z.string().min(1, "Organization ID is required"),
			includeInactive: z.boolean().default(false),
		}),
	)
	.output(
		z.array(
			z.object({
				id: z.string(),
				name: z.string(),
				keyPrefix: z.string(),
				scopes: z.array(z.string()),
				expiresAt: z.date().nullable(),
				lastUsedAt: z.date().nullable(),
				usageCount: z.number(),
				isActive: z.boolean(),
				createdAt: z.date(),
				createdBy: z.object({
					id: z.string(),
					name: z.string().nullable(),
					email: z.string().nullable(),
				}),
			}),
		),
	)
	.handler(async ({ context: { user, session }, input }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Check if user is a member of the organization
		// biome-ignore lint/style/noNonNullAssertion: organizationId is guaranteed by org-protected procedure
		const membership = await requireOrgMembership(user.id, organizationId!);

		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You must be a member of this organization",
			});
		}

		// Only organization owners can see every key in the org; everyone
		// else only sees keys they created themselves.
		const canSeeAllKeys = membership.role === "owner";

		const keys = await listOrganizationApiKeys({
			// biome-ignore lint/style/noNonNullAssertion: organizationId is guaranteed by org-protected procedure
			organizationId: organizationId!,
			includeInactive: input.includeInactive,
			createdByUserId: canSeeAllKeys ? undefined : user.id,
		});

		return keys.map((key) => ({
			id: key.id,
			name: key.name,
			keyPrefix: key.keyPrefix,
			scopes: key.scopes,
			expiresAt: key.expiresAt,
			lastUsedAt: key.lastUsedAt,
			usageCount: key.usageCount,
			isActive: key.isActive,
			createdAt: key.createdAt,
			createdBy: {
				id: key.createdBy.id,
				name: key.createdBy.name,
				email: key.createdBy.email,
			},
		}));
	});
