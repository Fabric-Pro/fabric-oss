import { log, proxyActivities } from "@temporalio/workflow";
import type {
	dispatchNewsletterSendActivity as DispatchFn,
	findDueNewsletterProjectsActivity as FindDueFn,
} from "../activities/newsletter";

const { findDueNewsletterProjectsActivity } = proxyActivities<{
	findDueNewsletterProjectsActivity: typeof FindDueFn;
}>({
	startToCloseTimeout: "1 minute",
	heartbeatTimeout: "30 seconds",
	retry: { maximumAttempts: 3, initialInterval: "2s" },
});

const { dispatchNewsletterSendActivity } = proxyActivities<{
	dispatchNewsletterSendActivity: typeof DispatchFn;
}>({
	startToCloseTimeout: "1 minute",
	heartbeatTimeout: "30 seconds",
	retry: { maximumAttempts: 3, initialInterval: "2s" },
});

export async function newsletterDispatcherWorkflow(): Promise<{
	dispatched: number;
}> {
	const { due } = await findDueNewsletterProjectsActivity();
	let dispatched = 0;
	for (const project of due) {
		try {
			await dispatchNewsletterSendActivity(project);
			dispatched += 1;
		} catch (error) {
			// One project's failure must not block the rest of the sweep.
			log.error("[Newsletter] dispatch failed for project", {
				projectId: project.projectId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { dispatched };
}
