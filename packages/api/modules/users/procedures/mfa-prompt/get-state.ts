import { getMfaPromptState } from "@repo/database";
import { z } from "zod";
import { protectedProcedure } from "../../../../orpc/procedures";

export const getMfaPromptStateProcedure = protectedProcedure
	.route({
		method: "GET",
		path: "/users/mfa-prompt/state",
		tags: ["Users"],
		summary: "Get MFA prompt state",
		description:
			"Get the current user's MFA prompt dismissal and snooze state",
	})
	.output(
		z.object({
			dismissed: z.boolean(),
			snoozedUntil: z.date().nullable(),
		}),
	)
	.handler(async ({ context: { user } }) => {
		return await getMfaPromptState(user.id);
	});
