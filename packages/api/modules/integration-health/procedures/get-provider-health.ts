/**
 * Get a single provider's current health row + active incident.
 *
 * Used by the per-provider drawer header. Auth:
 * `protectedProcedure` — any authenticated user can see provider health.
 */
import { ORPCError } from "@orpc/client";
import { getProviderHealth } from "@repo/database";
import { z } from "zod";
import { protectedProcedure } from "../../../orpc/procedures";

export const getProviderHealthProcedure = protectedProcedure
	.route({
		method: "GET",
		path: "/integration-health/providers/{providerKey}",
		tags: ["Integration Health"],
		summary: "Get health for a single provider",
	})
	.input(z.object({ providerKey: z.string().min(1) }))
	.handler(async ({ input }) => {
		const provider = await getProviderHealth(input.providerKey);
		if (!provider) {
			throw new ORPCError("NOT_FOUND", {
				message: `Provider not registered: ${input.providerKey}`,
			});
		}
		return { provider };
	});
