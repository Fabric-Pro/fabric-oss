import { unsubscribeByToken } from "@repo/database";
import { z } from "zod";
import { rateLimitedPublicProcedure } from "../../../orpc/procedures";

export const unsubscribeProcedure = rateLimitedPublicProcedure
	.route({
		method: "POST",
		path: "/newsletter/unsubscribe",
		tags: ["Newsletter"],
		summary: "Unsubscribe via token",
	})
	.input(z.object({ token: z.string().min(10) }))
	.handler(async ({ input }) => {
		// Always succeed regardless of token validity (no existence leak). Idempotent.
		await unsubscribeByToken(input.token);
		return { success: true };
	});
