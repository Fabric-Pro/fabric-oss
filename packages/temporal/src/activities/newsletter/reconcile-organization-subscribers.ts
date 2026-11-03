import {
	recordOrganizationSyncFailure,
	syncOrganizationSubscribers,
} from "@repo/database";
import { logger } from "@repo/logs";

/**
 * Brings org-synced subscribers up to date without ever costing the newsletter:
 * a failure leaves the existing list in place. It is logged and kept on the
 * settings row so an admin can see that the list may be out of date (FR17).
 */
export async function reconcileOrganizationSubscribers(
	projectId: string,
): Promise<void> {
	try {
		await syncOrganizationSubscribers(projectId);
	} catch (err) {
		logger.error("newsletter: organization sync failed", {
			projectId,
			error: err,
		});
		const message = err instanceof Error ? err.message : String(err);
		await recordOrganizationSyncFailure(projectId, message).catch(
			(recordError: unknown) => {
				logger.warn("newsletter: could not record the sync failure", {
					projectId,
					error: recordError,
				});
			},
		);
	}
}
