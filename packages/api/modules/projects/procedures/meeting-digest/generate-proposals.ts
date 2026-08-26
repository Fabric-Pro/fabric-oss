import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export type ProposalAction =
	| { kind: "no-transcript" }
	| { kind: "start"; resetFirst: boolean }
	| { kind: "in-progress" }
	| { kind: "already-analyzed"; proposalId: string }
	| { kind: "no-actionable-content" };

/** Pure: what the button should do given the transcript's analyze lifecycle. */
export function decideProposalAction(t: {
	contextId: string | null;
	analysisStatus: string;
	analyzedProposalId: string | null;
}): ProposalAction {
	if (!t.contextId) {
		return { kind: "no-transcript" };
	}
	switch (t.analysisStatus) {
		case "IN_PROGRESS":
			return { kind: "in-progress" };
		case "SCANNED":
			return t.analyzedProposalId
				? { kind: "already-analyzed", proposalId: t.analyzedProposalId }
				: { kind: "no-actionable-content" };
		case "FAILED":
			return { kind: "start", resetFirst: true };
		default: // NOT_SCANNED
			return { kind: "start", resetFirst: false };
	}
}

/**
 * #1814 FR7: user-initiated proposal generation from a digest meeting.
 * Reuses the auto-analyze workflow + PendingBacklogProposal inbox (review-
 * before-create comes free). Deliberately ignores the auto-analyze project
 * flag — that governs automatic scans; this is an explicit request. The
 * activity's own `meetingTranscriptSyncEnabled`/`meetingTranscriptAutoAnalyzeEnabled`
 * gate (a hard, tested AC1 invariant of the auto path — see
 * `auto-analyze-meeting-transcript.test.ts`) still runs for every caller, so a
 * plain workflow start here would silently no-op on any project that hasn't
 * opted into auto-analyze (the flag defaults to false). `userInitiated: true`
 * is threaded through the workflow/activity input specifically to skip that
 * gate for this explicit, one-off request — see the matching change in
 * `packages/temporal/src/activities/backlog-context/auto-analyze-meeting-transcript.ts`.
 * PROJECT_READ: the resulting proposal still requires an approver, so this
 * cannot create stories by itself.
 */
export const generateProposalsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-digest/{transcriptId}/generate-proposals",
		tags: ["Projects", "Meeting Digest"],
		summary: "Generate proposals from one digest meeting",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			transcriptId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const access = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!access) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this project",
			});
		}

		const transcript = await db.projectMeetingTranscript.findFirst({
			where: {
				projectId: input.projectId,
				transcriptId: input.transcriptId,
			},
			select: {
				id: true,
				contextId: true,
				analysisStatus: true,
				analyzedProposalId: true,
				meetingId: true,
				transcriptId: true,
				linkedMeetingId: true,
				meetingSubject: true,
				meetingDate: true,
			},
		});
		if (!transcript) {
			throw new ORPCError("NOT_FOUND", { message: "Meeting not found" });
		}

		const action = decideProposalAction(transcript);
		if (action.kind !== "start") {
			return {
				status: action.kind,
				proposalId:
					action.kind === "already-analyzed"
						? action.proposalId
						: null,
			};
		}

		// Resolve the context content BEFORE any CAS reset below. Doing the
		// FAILED→NOT_SCANNED reset first would wipe analysisError/analysisFailedAt
		// and then bail out here with "no-transcript" — destroying the failure
		// record for a transcript that was never actually going to run.
		const ctx = await db.projectContext.findUnique({
			where: { id: transcript.contextId as string },
			select: { content: true },
		});
		if (!ctx?.content) {
			return { status: "no-transcript" as const, proposalId: null };
		}

		if (action.resetFirst) {
			// CAS: only flip FAILED back — never stomp a concurrent IN_PROGRESS.
			const reset = await db.projectMeetingTranscript.updateMany({
				where: { id: transcript.id, analysisStatus: "FAILED" },
				data: {
					analysisStatus: "NOT_SCANNED",
					analysisError: null,
					analysisFailedAt: null,
				},
			});
			if (reset.count === 0) {
				return { status: "in-progress" as const, proposalId: null };
			}
		}

		// Dynamic import keeps @repo/temporal's client out of the API static graph.
		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();
		try {
			await client.workflow.start(
				"autoAnalyzeMeetingTranscriptWorkflow",
				{
					taskQueue: "ai-chat",
					// Distinct namespace + ALLOW_DUPLICATE (not the auto path's
					// REJECT_DUPLICATE `auto-analyze-meeting-transcript:<id>`, which may
					// already be burned for this transcript): each explicit click is its
					// own start attempt, FAIL still collapses concurrent clicks.
					workflowId: `meeting-digest-proposals:${transcript.id}`,
					workflowIdReusePolicy: "ALLOW_DUPLICATE",
					workflowIdConflictPolicy: "FAIL",
					args: [
						{
							projectId: input.projectId,
							userId: user.id,
							organizationId,
							transcriptRecordId: transcript.id,
							contextId: transcript.contextId,
							meetingId: transcript.meetingId,
							transcriptId: transcript.transcriptId,
							linkedMeetingId: transcript.linkedMeetingId,
							meetingSubject: transcript.meetingSubject,
							meetingDate: transcript.meetingDate
								? transcript.meetingDate.toISOString()
								: undefined,
							transcriptText: ctx.content,
							// Skip the activity's own auto-analyze-flag gate: this is an
							// explicit user action, not the automatic ingestion path.
							userInitiated: true,
						},
					],
				},
			);
		} catch (err) {
			if (
				err instanceof Error &&
				err.name === "WorkflowExecutionAlreadyStartedError"
			) {
				return { status: "in-progress" as const, proposalId: null };
			}
			throw err;
		}
		return { status: "started" as const, proposalId: null };
	});
