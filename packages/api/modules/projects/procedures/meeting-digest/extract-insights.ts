import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { MEETING_INSIGHTS_VERSION } from "@repo/temporal/activities";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Pure: whether an on-demand extraction run would do anything. Mirrors the
 * activity's own cache-hit guard (insightsExtractedAt + insightsVersion) plus
 * its text-source requirement (ProjectContext body, else stored summary).
 *
 * `opts.force` only bypasses the freshness check (a fresh cache no longer
 * short-circuits the run) — it never overrides the text-source guard. A
 * meeting with no context body and no stored summary still returns `false`
 * even when `force` is set, since there's nothing to extract from; callers
 * get back `{ started: false, reason: "not-needed" }` from the procedure.
 */
export function shouldStartInsightExtraction(
	t: {
		contextId: string | null;
		contentLength: number | null;
		summary: string | null;
		insightsExtractedAt: Date | null;
		insightsVersion: number | null;
	},
	opts?: { force?: boolean },
): boolean {
	// A context whose stored body is known-empty (contentLength === 0) can
	// never be extracted from — the activity would no-op without writing the
	// cache and the client would poll a workflow that does nothing. A null
	// contentLength is legacy-unknown and allowed through.
	const hasContextText = Boolean(t.contextId) && t.contentLength !== 0;
	const hasTextSource = hasContextText || Boolean(t.summary);
	if (!hasTextSource) {
		return false;
	}
	if (opts?.force) {
		return true;
	}
	return (
		t.insightsExtractedAt === null ||
		t.insightsVersion !== MEETING_INSIGHTS_VERSION
	);
}

/**
 * Fire-and-forget trigger that fills one digest meeting's insights cache
 * (summary, decisions, action items, open questions). PROJECT_READ on purpose:
 * the digest is a read surface for every project member and the meeting
 * self-populates on first open. Cost containment is layered — this guard skips
 * fresh caches, the deterministic workflowId (FAIL conflict policy) collapses
 * concurrent opens, and the activity re-checks the cache before calling the
 * LLM.
 */
export const extractInsightsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-digest/{transcriptId}/extract-insights",
		tags: ["Projects", "Meeting Digest"],
		summary: "Extract insights for one digest meeting (fire-and-forget)",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			transcriptId: z.string(),
			force: z.boolean().optional(),
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
				contentLength: true,
				summary: true,
				insightsExtractedAt: true,
				insightsVersion: true,
			},
		});
		if (!transcript) {
			throw new ORPCError("NOT_FOUND", { message: "Meeting not found" });
		}

		if (!shouldStartInsightExtraction(transcript, { force: input.force })) {
			return { started: false, reason: "not-needed" as const };
		}

		// Dynamic import keeps @repo/temporal's client out of the API static graph.
		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();

		try {
			// ALLOW_DUPLICATE (not REJECT_DUPLICATE like auto-analyze): a run whose
			// LLM call failed leaves the cache unfilled, and a later version bump
			// re-stales it — both need a fresh start after the previous run closed.
			// The FAIL conflict policy still collapses concurrent opens.
			await client.workflow.start(
				"extractMeetingInsightsOnDemandWorkflow",
				{
					taskQueue: "project-documents",
					workflowId: `meeting-digest-insights:${transcript.id}`,
					workflowIdReusePolicy: "ALLOW_DUPLICATE",
					workflowIdConflictPolicy: "FAIL",
					args: [
						{
							projectId: input.projectId,
							organizationId,
							userId: user.id,
							transcriptCuid: transcript.id,
							force: input.force ?? false,
						},
					],
				},
			);
		} catch (err) {
			// A start for this transcript is already running (or its id is
			// retained) — treat as success: the running workflow will fill the
			// cache the UI is polling for.
			if (
				err instanceof Error &&
				err.name === "WorkflowExecutionAlreadyStartedError"
			) {
				return { started: false, reason: "in-progress" as const };
			}
			throw err;
		}

		return { started: true, reason: "started" as const };
	});
