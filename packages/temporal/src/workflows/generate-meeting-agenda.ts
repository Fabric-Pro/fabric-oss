/**
 * Fire-and-forget workflow that generates a pre-meeting agenda for ONE upcoming
 * meeting occurrence (#1901).
 *
 * Started (not awaited) by `projects.meetingDigest.generateAgenda`. The caller
 * uses a deterministic, reject-duplicates workflowId
 * (`meeting-agenda:<agendaId>`) so concurrent clicks cannot double-spend the
 * LLM call.
 *
 * DEGRADATION BOUNDARY — this workflow never throws out to the caller. Nobody
 * is awaiting it, so a thrown error would be invisible and would leave the row
 * stuck on GENERATING while the UI polls until its budget expires. Every
 * failure path flips the row to FAILED, which the sheet renders as an error
 * plus a retry. Same contract as context-summarization-workflow.ts:12-17.
 *
 * IMPORTANT: This file runs in Temporal's sandboxed V8 isolate. It may only
 * import from `@temporalio/workflow` and TYPE-ONLY from activity modules.
 *
 * REPLAY: v1 has one linear command sequence. Any later change that adds an
 * activity call or a new branch MUST be gated with `patched()` — otherwise
 * in-flight executions fail replay with TMPRL1100.
 */

import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { generateAgendaActivity } = proxyActivities<typeof activities>({
	// Four parallel collector reads plus one COMPLEX-tier LLM call.
	startToCloseTimeout: "300s",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumInterval: "1m",
		maximumAttempts: 3,
		nonRetryableErrorTypes: ["ValidationError", "TenantViolation"],
	},
});

// Separate proxy: the failure marker is a single tiny write and must not
// inherit the generous generation timeout, or a failing run stays GENERATING
// for another five minutes.
const { markAgendaFailedActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30s",
	retry: { maximumAttempts: 3 },
});

export interface GenerateMeetingAgendaWorkflowInput {
	agendaId: string;
	projectId: string;
	organizationId: string | null;
	userId: string;
	linkedMeetingId: string;
}

export interface GenerateMeetingAgendaWorkflowOutput {
	status: "READY" | "FAILED";
}

export async function generateMeetingAgendaWorkflow(
	input: GenerateMeetingAgendaWorkflowInput,
): Promise<GenerateMeetingAgendaWorkflowOutput> {
	try {
		await generateAgendaActivity({
			agendaId: input.agendaId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			linkedMeetingId: input.linkedMeetingId,
		});
		return { status: "READY" };
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown error";
		log.error("[meeting-agenda] generation failed", {
			agendaId: input.agendaId,
			message,
		});

		try {
			await markAgendaFailedActivity({
				agendaId: input.agendaId,
				message,
			});
		} catch (markError) {
			// The row stays GENERATING and the client's poll budget will time it
			// out. Nothing further this workflow can do — but it must still not
			// throw, or the failure is recorded twice and read as a crash.
			log.error("[meeting-agenda] could not mark agenda failed", {
				agendaId: input.agendaId,
				message:
					markError instanceof Error
						? markError.message
						: "Unknown error",
			});
		}

		return { status: "FAILED" };
	}
}
