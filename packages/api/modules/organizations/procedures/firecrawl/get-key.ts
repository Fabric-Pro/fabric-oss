import { ORPCError } from "@orpc/server";
import { getOrganizationFirecrawlConfig } from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../lib/membership";

export const getOrganizationFirecrawlKeyProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_READ))
	.route({
		method: "GET",
		path: "/organizations/:organizationId/firecrawl/key",
		tags: ["Organizations"],
		summary: "Get organization Firecrawl API key",
		description: "Get the decrypted Firecrawl API key for viewing/copying",
	})
	.input(
		z.object({
			organizationId: z.string(),
		}),
	)
	.output(
		z.object({
			apiKey: z.string(),
		}),
	)
	.handler(async ({ context: { user }, input: { organizationId } }) => {
		// Verify user is a member of the organization
		const membership = await verifyOrganizationMembership(
			organizationId,
			user.id,
		);

		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You are not a member of this organization",
			});
		}

		const config = await getOrganizationFirecrawlConfig(organizationId);

		if (!config?.firecrawlApiKey) {
			throw new ORPCError("NOT_FOUND", {
				message:
					"No Firecrawl API key configured for this organization",
			});
		}

		// Decrypt and return the API key
		const apiKey = decryptApiKey(config.firecrawlApiKey);

		return {
			apiKey,
		};
	});
