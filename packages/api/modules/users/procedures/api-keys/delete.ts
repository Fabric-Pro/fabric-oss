/**
 * Delete User API Key Procedure
 *
 * Permanently deletes an API key.
 */

import { deleteUserApiKey } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const deleteUserApiKeyProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "DELETE",
		path: "/users/api-keys/{id}",
		tags: ["Users", "API Keys"],
		summary: "Delete an API key",
		description: "Permanently delete an API key",
	})
	.input(
		z.object({
			id: z.string().min(1, "API key ID is required"),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			message: z.string(),
		}),
	)
	.handler(async ({ context: { user }, input }) => {
		const result = await deleteUserApiKey(input.id, user.id);

		if (result.count === 0) {
			return {
				success: false,
				message: "API key not found or already deleted",
			};
		}

		return {
			success: true,
			message: "API key deleted successfully",
		};
	});
