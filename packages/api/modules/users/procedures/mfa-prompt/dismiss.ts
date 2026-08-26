import { dismissMfaPrompt } from "@repo/database";
import { z } from "zod";
import { protectedProcedure } from "../../../../orpc/procedures";

export const dismissMfaPromptProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/users/mfa-prompt/dismiss",
		tags: ["Users"],
		summary: "Dismiss or snooze MFA prompt",
		description:
			"Permanently dismiss the MFA setup prompt or snooze it for 7 days",
	})
	.input(
		z.object({
			action: z.enum(["snooze", "dismiss"]),
		}),
	)
	.output(
		z.object({
			success: z.literal(true),
		}),
	)
	.handler(async ({ context: { user }, input: { action } }) => {
		await dismissMfaPrompt(user.id, action);
		return { success: true as const };
	});
