import { listVisibleCredentials } from "@repo/database";
import { rankCredentials } from "@repo/integrations/credential-manager";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { resolveCredentialActor, toClientCredential } from "../lib/context";
import {
	clientCredentialSchema,
	credentialProviderSchema,
} from "../lib/schemas";

/**
 * Credentials the caller may see in the organization: their own, members'
 * shared ones and the organization's, ranked app-first.
 * Metadata only.
 */
export const listCredentials = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_INTEGRATIONS_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/credentials",
		tags: ["Credentials"],
		summary: "List credentials",
	})
	.input(
		z.object({
			organizationId: z.string(),
			provider: credentialProviderSchema.optional(),
			includeRevoked: z.boolean().optional(),
		}),
	)
	.output(z.object({ credentials: z.array(clientCredentialSchema) }))
	.handler(async ({ context, input }) => {
		const actor = await resolveCredentialActor(
			input.organizationId,
			context.user.id,
		);
		const rows = await listVisibleCredentials({
			organizationId: input.organizationId,
			userId: context.user.id,
			provider: input.provider,
			includeRevoked: input.includeRevoked,
		});
		return {
			credentials: rankCredentials(rows).map((row) =>
				toClientCredential(row, actor),
			),
		};
	});
