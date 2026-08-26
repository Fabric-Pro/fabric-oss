/**
 * Bulk fetch of provider health for the Settings → Integrations page.
 *
 * Returns every registered `IntegrationProviderRegistry` row plus the
 * most-recent active incident summary (FIRING / ACKNOWLEDGED) for each.
 * One DB call surfaces 30 rows in under 200ms.
 *
 * Auth: `protectedProcedure` — every authenticated user can read provider
 * health. The data is non-tenant-scoped (a provider outage affects every
 * org equally).
 */
import { listProviderHealth } from "@repo/database";
import { z } from "zod";
import { protectedProcedure } from "../../../orpc/procedures";

export const listProviderHealthProcedure = protectedProcedure
	.route({
		method: "GET",
		path: "/integration-health/providers",
		tags: ["Integration Health"],
		summary: "List health for all registered providers",
		description:
			"Returns every registered provider's current health plus the most-recent active incident if any.",
	})
	.input(
		z.object({
			/**
			 * Optional filter to limit the result set. When unset, every
			 * registered provider is returned.
			 */
			providerKeys: z.array(z.string()).optional(),
		}),
	)
	.handler(async ({ input }) => {
		const providers = await listProviderHealth({
			providerKeys: input.providerKeys,
		});
		return { providers };
	});
