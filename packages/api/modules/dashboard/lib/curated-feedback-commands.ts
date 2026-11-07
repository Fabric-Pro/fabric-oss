import {
	DASHBOARD_CURATED_FEEDBACK_ACTIONS,
	listDashboardCuratedFeedback,
	recordDashboardCuratedFeedback,
} from "@repo/database";
import { z } from "zod";

export interface CuratedFeedbackActor {
	userId: string;
	organizationId: string;
}

export const curatedFeedbackInputSchema = z.object({
	cardKey: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.regex(/^[a-z0-9][a-z0-9:._-]*$/),
	action: z.enum(DASHBOARD_CURATED_FEEDBACK_ACTIONS),
});

export async function listCuratedFeedbackCommand(actor: CuratedFeedbackActor) {
	return { preferences: await listDashboardCuratedFeedback(actor) };
}

export async function recordCuratedFeedbackCommand(
	actor: CuratedFeedbackActor,
	input: z.input<typeof curatedFeedbackInputSchema>,
) {
	const { cardKey, action } = curatedFeedbackInputSchema.parse(input);
	return {
		preference: await recordDashboardCuratedFeedback({
			...actor,
			cardKey,
			action,
		}),
	};
}
