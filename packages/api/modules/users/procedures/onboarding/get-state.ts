import { getOnboardingTourState } from "@repo/database";
import { isFunctionTagsEnabled } from "@repo/utils/feature-flag";
import { z } from "zod";
import { protectedProcedure } from "../../../../orpc/procedures";
import {
	onboardingTourStateResponseSchema,
	withLegacyPromptCompat,
} from "./schema";

export const getOnboardingTourStateProcedure = protectedProcedure
	.route({
		method: "GET",
		path: "/users/onboarding/state",
		tags: ["Users"],
		summary: "Get onboarding tour state",
		description:
			"Get the current user's Get-started tour progress and whether it is eligible to auto-launch on first login.",
	})
	.output(
		z.object({
			state: onboardingTourStateResponseSchema,
			eligibleForAutoLaunch: z.boolean(),
			autoLaunchCohort: z.boolean(),
			eligibleForFunctionTagsPrompt: z.boolean(),
			eligibleForPointer: z.boolean(),
		}),
	)
	.handler(async ({ context: { user } }) => {
		const result = await getOnboardingTourState(user.id);
		// The no-tags prompt is additionally gated by the function-tags feature
		// flag — no point prompting for tags that do nothing when it is off.
		// (The DB query returns only the data-level eligibility.)
		return {
			...result,
			state: withLegacyPromptCompat(result.state),
			eligibleForFunctionTagsPrompt:
				result.eligibleForFunctionTagsPrompt && isFunctionTagsEnabled(),
		};
	});
