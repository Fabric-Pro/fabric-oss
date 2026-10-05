/**
 * List Connected Agents Procedure
 *
 * The coding agents the current user has signed in, one row per agent and
 * grant: an organization, or one project and the organization hosting it. A
 * grant nothing can still sign in with is not listed. No token or secret is
 * involved: a connection is the consent the person gave, and revoking it ends
 * every token issued under it.
 */

import { listOAuthConnections } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

// The caller's own consents, across organizations; the same self-read
// permission the personal API keys list declares.
export const listOAuthConnectionsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_READ_SELF))
	.route({
		method: "GET",
		path: "/users/oauth-connections",
		tags: ["Users", "Connected agents"],
		summary: "List connected agents",
		description:
			"Get the coding agents the current user has signed in to Fabric.",
	})
	.input(z.object({}).optional())
	.output(
		z.array(
			z.object({
				consentId: z.string(),
				clientName: z.string().nullable(),
				organizationId: z.string().nullable(),
				organizationName: z.string().nullable(),
				projectId: z.string().nullable(),
				projectName: z.string().nullable(),
				audience: z.enum(["mcp", "api"]).nullable(),
				scopes: z.array(z.string()),
				createdAt: z.date().nullable(),
			}),
		),
	)
	.handler(async ({ context: { user } }) => listOAuthConnections(user.id));
