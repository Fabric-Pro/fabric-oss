import { ORPCError } from "@orpc/server";
import type { AIProvider } from "@repo/database";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Opts one of the caller's OWN personal keys in or out of serving their own
 * work while every ChatGPT plan serving it is spent (Fizzy #3085). Takes no
 * organization: the row is found by the session's user and the provider, so
 * no input can reach another member's key, and no organization role is
 * involved. An EMBEDDINGS_ONLY key cannot be opted in.
 *
 * Whether the key is ever used is decided at resolution time, per
 * organization and per call (`chatGptPlanPersonalKeyFallback` in `@repo/ai`).
 */
export const setPlanSpentFallbackProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/ai-config/providers/set-plan-spent-fallback",
		tags: ["AI Config"],
		summary: "Use a personal key when the ChatGPT plan is spent",
		description:
			"Opt one of the signed-in user's own provider keys in or out of serving their own work while every ChatGPT plan serving it is spent, where the organization would otherwise stop that work.",
	})
	.input(
		z.object({
			provider: z.string(),
			useWhenPlanSpent: z.boolean(),
		}),
	)
	.output(z.object({ useWhenPlanSpent: z.boolean() }))
	.handler(async ({ context: { user }, input }) => {
		const row = await db.userCloudProviderConfig.findFirst({
			where: { userId: user.id, provider: input.provider as AIProvider },
			select: { id: true, purpose: true },
		});
		if (!row) {
			throw new ORPCError("NOT_FOUND", {
				message: "You have no key for this provider.",
			});
		}
		if (input.useWhenPlanSpent && row.purpose === "EMBEDDINGS_ONLY") {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"An embeddings-only key serves document search only, so it cannot stand in for a spent ChatGPT plan.",
			});
		}
		// `updatedAt` is not maintained by Prisma on this table, and the most
		// recently updated opted-in key is the one chosen without a Default.
		const updated = await db.userCloudProviderConfig.update({
			where: { id: row.id },
			data: {
				useWhenPlanSpent: input.useWhenPlanSpent,
				updatedAt: new Date(),
			},
			select: { useWhenPlanSpent: true },
		});
		return { useWhenPlanSpent: updated.useWhenPlanSpent };
	});
