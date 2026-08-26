/**
 * Resolve Tenant Procedure
 *
 * Validates an API key and returns the tenant context.
 * Used by agents to authenticate requests.
 */

import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
	Permissions,
	publicProcedure,
	requirePermission,
} from "../../../orpc/procedures";
import { hasAnyScope, validateApiKey } from "../lib/api-key-auth";
import { TenantContextSchema } from "../types";

export const resolveTenantProcedure = publicProcedure
	.use(requirePermission(Permissions.AGENT_EXECUTE))
	.route({
		method: "POST",
		path: "/runtime/resolve-tenant",
		tags: ["Runtime"],
		summary: "Resolve tenant from API key",
		description:
			"Validates an API key and returns the tenant context (userId, organizationId, scopes). " +
			"This endpoint is used by agents to authenticate incoming requests.",
	})
	.input(
		z.object({
			apiKey: z.string().min(20, "Invalid API key format"),
			requiredScopes: z.array(z.string()).optional(),
		}),
	)
	.output(TenantContextSchema)
	.handler(async ({ input }) => {
		const tenant = await validateApiKey(input.apiKey);

		if (!tenant) {
			throw new ORPCError("UNAUTHORIZED", {
				message: "Invalid or expired API key",
			});
		}

		// Check required scopes if specified
		if (input.requiredScopes && input.requiredScopes.length > 0) {
			if (!hasAnyScope(tenant, input.requiredScopes)) {
				throw new ORPCError("FORBIDDEN", {
					message: `API key lacks required scope. Required one of: ${input.requiredScopes.join(", ")}`,
				});
			}
		}

		return tenant;
	});
