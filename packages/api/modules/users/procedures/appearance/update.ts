import { updateUserContrastPreference } from "@repo/database";
import { CONTRAST_PREFERENCES } from "@repo/utils/contrast-preference";
import { z } from "zod";
import { protectedProcedure } from "../../../../orpc/procedures";

/**
 * Saves the signed-in person's high-contrast theme choice (Fizzy #1444).
 *
 * `protectedProcedure`, not a tenant procedure: the preference belongs to the
 * account and reads the same in every organization, so there is no tenant to
 * check and no role that should be refused it (AC-11).
 *
 * Not written while an admin is impersonating. The page still changes for the
 * admin — the browser applies the choice before this call returns — but the
 * person whose account it is would otherwise find their theme changed the next
 * time they sign in, by someone who only needed it for a support session.
 * `persisted: false` tells the client which of the two happened.
 */
export const updateAppearanceProcedure = protectedProcedure
	.route({
		method: "PUT",
		path: "/users/appearance",
		tags: ["Users"],
		summary: "Update appearance preferences",
		description:
			"Save the current user's high-contrast theme preference on their account",
	})
	.input(
		z.object({
			contrastPreference: z.enum(CONTRAST_PREFERENCES),
		}),
	)
	.output(
		z.object({
			contrastPreference: z.enum(CONTRAST_PREFERENCES),
			persisted: z.boolean(),
		}),
	)
	.handler(async ({ context: { user, session }, input }) => {
		if (session.impersonatedBy) {
			return {
				contrastPreference: input.contrastPreference,
				persisted: false,
			};
		}
		const contrastPreference = await updateUserContrastPreference(
			user.id,
			input.contrastPreference,
		);
		return { contrastPreference, persisted: true };
	});
