import { updateOnboardingTourState } from "@repo/database";
import { z } from "zod";
import { protectedProcedure } from "../../../../orpc/procedures";
import {
	onboardingTourActionSchema,
	onboardingTourStateResponseSchema,
	withLegacyPromptCompat,
} from "./schema";

export const updateOnboardingTourStateProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/users/onboarding/update",
		tags: ["Users"],
		summary: "Update onboarding tour state",
		description:
			"Advance the current user's Get-started tour: start, record a step outcome, set resume position, complete, dismiss, mark auto-launched, or restart.",
	})
	.input(z.object({ action: onboardingTourActionSchema }))
	.output(z.object({ state: onboardingTourStateResponseSchema }))
	.handler(async ({ context: { user }, input: { action } }) => {
		const state = await updateOnboardingTourState(user.id, action);
		return { state: withLegacyPromptCompat(state) };
	});
