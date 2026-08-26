import { db } from "../client";

const SNOOZE_DURATION_DAYS = 7;

export async function getMfaPromptState(userId: string) {
	const user = await db.user.findUnique({
		where: { id: userId },
		select: {
			mfaPromptDismissedAt: true,
			mfaPromptSnoozedUntil: true,
		},
	});

	return {
		dismissed: user?.mfaPromptDismissedAt != null,
		snoozedUntil: user?.mfaPromptSnoozedUntil ?? null,
	};
}

export async function dismissMfaPrompt(
	userId: string,
	action: "snooze" | "dismiss",
) {
	if (action === "dismiss") {
		await db.user.update({
			where: { id: userId },
			data: {
				mfaPromptDismissedAt: new Date(),
				mfaPromptSnoozedUntil: null,
			},
		});
	} else {
		const snoozedUntil = new Date();
		snoozedUntil.setDate(snoozedUntil.getDate() + SNOOZE_DURATION_DAYS);

		await db.user.update({
			where: { id: userId },
			data: {
				mfaPromptSnoozedUntil: snoozedUntil,
			},
		});
	}
}
