import type { ContrastPreference } from "@repo/utils/contrast-preference";
import { db } from "../client";

/**
 * Saves a person's high-contrast theme choice on their account (Fizzy #1444).
 *
 * Only ever their own row: the caller passes the signed-in user's id, and no
 * organization is involved — the preference belongs to the person, the same in
 * every organization they belong to.
 */
export async function updateUserContrastPreference(
	userId: string,
	contrastPreference: ContrastPreference,
): Promise<ContrastPreference> {
	const user = await db.user.update({
		where: { id: userId },
		data: { contrastPreference },
		select: { contrastPreference: true },
	});
	// The column is free text (see the schema comment), but this function only
	// ever writes a member of the union, so the read-back is one too.
	return user.contrastPreference as ContrastPreference;
}
