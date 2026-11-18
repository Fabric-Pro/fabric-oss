import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { WorkflowFailedError } from "@temporalio/client";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { syncNowStartedAt } from "./sync-now-workflow-id";

const CLOSED_WITHOUT_SUCCESS = new Set([
	"FAILED",
	"TERMINATED",
	"CANCELLED",
	"TIMED_OUT",
]);

/** The innermost cause is the activity's own error; the outer ones only wrap it. */
function rootCauseMessage(error: unknown): string | undefined {
	let current: unknown = error;
	let message: string | undefined;
	while (current instanceof Error) {
		message = current.message || message;
		current = current.cause;
	}
	return message;
}

/**
 * Graph's server errors reach the activity as raw response text, which says
 * nothing useful to the person who pressed the button.
 */
export function describeSyncFailure(message: string | undefined): string {
	const status = message?.match(/Microsoft Graph API error: (5\d\d)/)?.[1];
	if (status) {
		return `Microsoft 365 did not respond (error ${status}), so nothing was synced. Try again later.`;
	}
	return message || "The sync failed.";
}

/**
 * AUTHORIZATION: `requireProjectPermission(PROJECT_READ)` on `projectId`, and
 * the workflow id must be a "Sync now" run of that project. The id is checked
 * before Temporal is called, so it cannot be used to read another project's
 * workflows.
 *
 * Reports how a "Sync now" run ended. Without it the button gave no outcome:
 * a run takes minutes, and with scheduled sync off it never touches the
 * project's last-run time, which was the only thing the page watched.
 */
export const syncNowStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/meeting-transcript-sync/trigger/{workflowId}",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Get the outcome of a Sync now run",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			workflowId: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		const startedAt = syncNowStartedAt(input.workflowId, input.projectId);
		if (!startedAt) {
			throw new ORPCError("NOT_FOUND", { message: "Sync not found" });
		}

		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();
		const handle = client.workflow.getHandle(input.workflowId);

		let status: string;
		try {
			status = (await handle.describe()).status.name;
		} catch {
			throw new ORPCError("NOT_FOUND", { message: "Sync not found" });
		}

		if (status === "RUNNING") {
			return { state: "running" as const };
		}

		const newTranscripts = await db.projectMeetingTranscript.count({
			where: { projectId: input.projectId, syncedAt: { gte: startedAt } },
		});

		if (CLOSED_WITHOUT_SUCCESS.has(status)) {
			const error = await handle.result().then(
				() => undefined,
				(failure: unknown) =>
					failure instanceof WorkflowFailedError
						? rootCauseMessage(failure)
						: undefined,
			);
			return {
				state: "failed" as const,
				newTranscripts,
				message: describeSyncFailure(error),
			};
		}

		// A run that could read some calendars but not others completes, and
		// records the problem on each meeting it could not reach.
		const failedMeetings = await db.projectLinkedMeeting.findMany({
			where: {
				projectId: input.projectId,
				deactivatedAt: null,
				lastErrorAt: { gte: startedAt },
			},
			select: { lastErrorMessage: true },
		});

		return {
			state: "completed" as const,
			newTranscripts,
			failedMeetings: failedMeetings.length,
			message: failedMeetings[0]?.lastErrorMessage ?? null,
		};
	});
