import { ORPCError } from "@orpc/server";
import {
	ACTION_ITEM_LINK_VERSION,
	db,
	hasProjectAccess,
	isFeatureEnabled,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Pure: whether a matching run would do anything for this meeting.
 *
 * Mirrors the activity's own cache guard so the procedure can answer
 * "not-needed" without paying for a workflow start. `force` bypasses freshness
 * only — a meeting with no action items has nothing to match either way.
 */
export function shouldStartActionItemLinking(
	t: { actionItemsLinkVersion: number | null; actionItemCount: number },
	opts?: { force?: boolean },
): boolean {
	if (t.actionItemCount === 0) {
		return false;
	}
	if (opts?.force) {
		return true;
	}
	return t.actionItemsLinkVersion !== ACTION_ITEM_LINK_VERSION;
}

/**
 * #1902 FR1: fire-and-forget trigger that matches one meeting's action items
 * against the project's work items.
 *
 * PROJECT_READ on purpose, mirroring `extractInsights`: the digest is a read
 * surface for every project member and a meeting self-populates on first open.
 * Cost containment is layered — this guard skips fresh caches, the deterministic
 * workflowId collapses concurrent opens, and the activity re-checks the cache
 * before spending a token.
 */
export const linkActionItemsProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.PROJECT_READ))
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-digest/{transcriptId}/link-action-items",
		tags: ["Projects", "Meeting Digest"],
		summary: "Match one meeting's action items to work items",
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

		// Flag off is a no-op, not an error: the UI fires this optimistically and
		// a disabled feature must not surface as a failure to the user (FR8).
		if (!(await isFeatureEnabled("MEETING_ACTION_ITEM_LINKING"))) {
			return { started: false, reason: "flag-off" as const };
		}

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
				actionItemsLinkVersion: true,
				_count: { select: { actionItems: true } },
			},
		});
		if (!transcript) {
			throw new ORPCError("NOT_FOUND", { message: "Meeting not found" });
		}

		if (
			!shouldStartActionItemLinking(
				{
					actionItemsLinkVersion: transcript.actionItemsLinkVersion,
					actionItemCount: transcript._count.actionItems,
				},
				{ force: input.force },
			)
		) {
			return { started: false, reason: "not-needed" as const };
		}

		// Dynamic import keeps @repo/temporal's client out of the API static graph.
		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();

		try {
			await client.workflow.start("linkMeetingActionItemsWorkflow", {
				taskQueue: "project-documents",
				workflowId: `meeting-action-item-links:${transcript.id}`,
				// ALLOW_DUPLICATE (as for insights): a run whose LLM call failed
				// leaves the cache unstamped, and a version bump re-stales it —
				// both need a fresh start after the previous run closed. The FAIL
				// conflict policy still collapses concurrent opens.
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
			});
		} catch (err) {
			// A run for this meeting is already going — treat as success: the
			// running workflow fills the links the UI is polling for.
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
