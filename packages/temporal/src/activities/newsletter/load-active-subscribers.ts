import {
	enrollProjectMembersAsSubscribers,
	listActiveNewsletterSubscribers,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";

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
	// Reconcile project members -> ACTIVE subscribers before reading the list, so
	// members who joined since the last send are included. createdByUserId is
	// resolved inside the query (no activity-input change => workflow command is
	// byte-identical => replay-safe). Best-effort: a failure must not fail the send.
	try {
		await enrollProjectMembersAsSubscribers({ projectId: input.projectId });
	} catch (err) {
		logger.warn("newsletter: member reconcile at send failed", {
			projectId: input.projectId,
			error: err,
		});
	}
	const rows = await listActiveNewsletterSubscribers(input.projectId);
	return { subscribers: rows };
}
