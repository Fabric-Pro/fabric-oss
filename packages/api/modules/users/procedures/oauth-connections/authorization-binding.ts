/**
 * Read What An Agent's Authorization Is Bound To
 *
 * The consent page of an agent that was connected from a project shows that
 * project, and the organization hosting it, instead of asking for an
 * organization. The authorization endpoint of the plugin drops the project from
 * the query the page carries, so the page asks for it here by the two values it
 * does have: the client and the PKCE challenge.
 *
 * Only the signed-in person's own view: a project the caller cannot read, one
 * that does not exist and one that is deleted are all answered `project: null`
 * with `bound: true`, so the page says "no access" and nothing about which of
 * the three it was.
 *
 * The project comes with its audience because the page repeats both when it
 * answers the consent: the server refuses an answer that is not for what the
 * page showed.
 */

import {
	findLiveOAuthAuthorizationResource,
	resolveOAuthProjectGrantTarget,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const getOAuthAuthorizationBindingProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_READ_SELF))
	.route({
		method: "GET",
		path: "/users/oauth-authorization-binding",
		tags: ["Users", "Connected agents"],
		summary: "Read the project an agent's authorization is for",
		description:
			"Get the project, and its organization, that an agent asked to be signed in for, when it asked for one.",
	})
	.input(
		z.object({
			clientId: z.string().min(1),
			codeChallenge: z.string().min(1),
		}),
	)
	.output(
		z.object({
			bound: z.boolean(),
			project: z
				.object({
					id: z.string(),
					name: z.string(),
					audience: z.enum(["mcp", "api"]),
					organizationId: z.string(),
					organizationName: z.string(),
				})
				.nullable(),
		}),
	)
	.handler(async ({ context: { user }, input }) => {
		const binding = await findLiveOAuthAuthorizationResource(
			input.clientId,
			input.codeChallenge,
		);
		if (!binding) {
			return { bound: false, project: null };
		}

		const target = await resolveOAuthProjectGrantTarget(
			user.id,
			binding.projectId,
		);
		return {
			bound: true,
			project: target
				? {
						id: target.projectId,
						name: target.projectName,
						audience: binding.audience,
						organizationId: target.organizationId,
						organizationName: target.organizationName,
					}
				: null,
		};
	});
