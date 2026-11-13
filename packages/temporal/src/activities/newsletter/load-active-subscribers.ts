import {
	enrollProjectMembersAsSubscribers,
	getNewsletterSettings,
	listActiveNewsletterSubscribers,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { reconcileOrganizationSubscribers } from "./reconcile-organization-subscribers";

export interface LoadActiveSubscribersInput {
	projectId: string;
}
export interface NewsletterRecipient {
	id: string;
	email: string;
	name: string | null;
	unsubscribeToken: string;
}
export interface LoadActiveSubscribersOutput {
	subscribers: NewsletterRecipient[];
}

export async function loadActiveSubscribersActivity(
	input: LoadActiveSubscribersInput,
): Promise<LoadActiveSubscribersOutput> {
	heartbeat("loadActiveSubscribers");
	// Project members join the list only while the newsletter is enabled, as
	// on the enable and join paths, so a "Send now" on a disabled newsletter
	// does not enrol them.
	const { enabled } = await getNewsletterSettings(input.projectId);
	if (enabled) {
		// Reconcile project members -> ACTIVE subscribers before reading the list,
		// so members who joined since the last send are included. createdByUserId
		// is resolved inside the query (no activity-input change => workflow
		// command is byte-identical => replay-safe). Best-effort: a failure must
		// not fail the send.
		try {
			await enrollProjectMembersAsSubscribers({
				projectId: input.projectId,
			});
		} catch (err) {
			logger.warn("newsletter: member reconcile at send failed", {
				projectId: input.projectId,
				error: err,
			});
		}
	}
	// On every send, enabled or not: the organization sync does nothing unless
	// an admin turned on "Send to entire organization", and it is also what
	// removes people who have left the organization. Inside the activity for
	// the same replay reason, and after the member reconcile so a project
	// member keeps the row they were enrolled with.
	await reconcileOrganizationSubscribers(input.projectId);
	const rows = await listActiveNewsletterSubscribers(input.projectId);
	return { subscribers: rows };
}
