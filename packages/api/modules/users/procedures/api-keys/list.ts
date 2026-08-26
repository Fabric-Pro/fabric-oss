/**
 * List User API Keys Procedure
 *
 * Returns all API keys for the current user (without the raw key values).
 */

import { listUserApiKeys } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const listUserApiKeysProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_READ_SELF))
	.route({
		method: "GET",
		path: "/users/api-keys",
		tags: ["Users", "API Keys"],
		summary: "List all API keys",
		description: "Get all API keys for the current user",
	})
	.input(
		z
			.object({
				includeInactive: z.boolean().default(false),
			})
			.optional(),
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
			}),
		),
	)
	.handler(async ({ context: { user }, input }) => {
		const keys = await listUserApiKeys({
			userId: user.id,
			includeInactive: input?.includeInactive ?? false,
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
		}));
	});
