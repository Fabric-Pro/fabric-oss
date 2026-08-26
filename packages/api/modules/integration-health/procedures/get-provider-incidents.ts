/**
 * List integration incidents for a single provider over a sliding window.
 *
 * Used by the per-provider timeline drawer. Default window
 * is the last 30 days; capped at 365 days (matches the storage-retention
 * window in §L13).
 *
 * Auth: `protectedProcedure` — read-only view of public-ish data (every
 * authenticated user sees the same provider history).
 */
import { listProviderIncidentsForTimeline } from "@repo/database";
import { z } from "zod";
import { protectedProcedure } from "../../../orpc/procedures";

export const getProviderIncidentsProcedure = protectedProcedure
	.route({
		method: "GET",
		path: "/integration-health/providers/{providerKey}/incidents",
		tags: ["Integration Health"],
		summary: "List recent incidents for a provider",
	})
	.input(
		z.object({
			providerKey: z.string().min(1),
			windowDays: z.number().int().min(1).max(365).default(30),
		}),
	)
	.handler(async ({ input }) => {
		const incidents = await listProviderIncidentsForTimeline({
			providerKey: input.providerKey,
			windowDays: input.windowDays,
		});
		return { incidents };
	});
