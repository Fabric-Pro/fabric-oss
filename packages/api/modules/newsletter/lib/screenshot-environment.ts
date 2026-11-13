import { db, recordAuditTx } from "@repo/database";

/**
 * The environment release-notes screenshots are captured from is confirmed by
 * an admin to show sample data only. That confirmation is about the
 * environment as it was: once its address, sign-in page, type or credential
 * changes, it no longer holds. This drops the binding from the project's
 * newsletter settings when they name the environment, and records why, in one
 * transaction, so an admin has to choose and confirm it again. Returns whether
 * a binding was dropped.
 */
export async function releaseScreenshotEnvironment(input: {
	projectId: string;
	environmentId: string;
	user: { id: string; email?: string | null; name?: string | null };
	/** What changed on the environment, for the audit entry. */
	changed: string[];
}): Promise<boolean> {
	return db.$transaction(async (tx) => {
		const { count } = await tx.newsletterSettings.updateMany({
			where: {
				projectId: input.projectId,
				screenshotEnvironmentId: input.environmentId,
			},
			data: {
				screenshotEnvironmentId: null,
				screenshotSampleDataConfirmedAt: null,
			},
		});
		if (count === 0) {
			return false;
		}
		await recordAuditTx(tx, {
			action: "newsletter.screenshots.environment_changed",
			actor: {
				type: "user",
				userId: input.user.id,
				emailSnapshot: input.user.email ?? null,
				nameSnapshot: input.user.name ?? null,
			},
			projectId: input.projectId,
			resource: {
				type: "newsletter_settings",
				id: input.projectId,
			},
			metadata: {
				screenshotEnvironmentId: null,
				sampleDataConfirmed: false,
				releasedEnvironmentId: input.environmentId,
				environmentChanged: input.changed,
			},
		});
		return true;
	});
}
