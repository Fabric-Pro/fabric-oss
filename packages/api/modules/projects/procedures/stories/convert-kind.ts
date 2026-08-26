/**
 * Convert a work item's type (BUG ↔ FEATURE), and regenerate its body.
 *
 * Flips the stored kind and snaps `draftingStage` to DRAFT so the item cannot
 * land in a stage that is invalid for its new type (a feature in
 * PASSIVE_ANALYSIS converted to a bug would otherwise fail the per-kind stage
 * validator).
 *
 * Fizzy #2048 — THE BODY IS NO LONGER PRESERVED. F-171 put prompt re-chaining on
 * convert out of scope, and this handler asserted that in its header and in its
 * published route description. The product owner reversed that decision: an item
 * whose type changed still reads in the old type's shape, which is the whole
 * complaint. A conversion now redrafts the body through the NEW type's template.
 *
 * The redraft is a model call on the order of a minute, so it runs off the
 * request path: this procedure returns as soon as the flip lands, and the
 * rewrite proceeds in a Temporal workflow whose state the front end follows
 * through `projects.stories.regenerationStatus`. A regeneration that fails,
 * comes back empty, or loses a race leaves the prior body exactly as it was —
 * the flip and the rewrite are deliberately separate steps.
 *
 * The workflow id is deterministic per work item, so a user alternating an
 * item's type never puts more than one regeneration in flight for it on a task
 * queue shared with interactive AI paths.
 *
 * The user-facing affordance is a kebab-menu item on the roadmap card and the
 * work item detail page.
 */

import { ORPCError } from "@orpc/client";
import {
	createBackgroundJob,
	db,
	failBackgroundJob,
	type StoryKind,
	updateStory,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireOrganizationMembership,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { stripInternalStoryFields } from "../../lib/strip-internal-story-fields";

/**
 * Names this path in the canonical resolution log (NFR1's "from which entry
 * point" dimension). It has no other source — the activity cannot tell a
 * conversion from any other caller of the same workflow — so it travels in the
 * workflow arguments.
 */
const STORY_KIND_CONVERSION_ENTRY_POINT = "typeConversionRegeneration";

/**
 * Deterministic, per-work-item workflow id.
 *
 * This is the dedup primitive. Temporal rejects a second start under a live
 * workflow id, so the id itself claims the slot atomically — the same property
 * `backlog/start-proposal-draft.ts` gets from its compare-and-set claim, without
 * a second table. Without it a user toggling an item's type would queue an
 * unbounded series of minute-long model calls on the `ai-chat` queue, which also
 * serves interactive chat.
 *
 * Exported so the status read cannot drift from the writer.
 */
export function storyKindRegenerationWorkflowId(storyId: string): string {
	return `regenerate-body-for-kind-${storyId}`;
}

/**
 * Temporal's "this workflow id is already live" signal. Matched by name and by
 * message because the client surfaces it as a plain error in some transports —
 * same detection as `contexts/process-context-file.ts`, which uses a
 * deterministic workflow id for the same reason.
 */
function isAlreadyStartedError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "WorkflowExecutionAlreadyStartedError" ||
			error.message?.includes("already started") ||
			error.message?.includes("already exists"))
	);
}

export const convertStoryKindProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/convert-kind",
		tags: ["Projects", "Stories"],
		summary: "Convert story kind (bug ↔ feature)",
		description:
			"Flips kind between BUG and FEATURE and snaps draftingStage to DRAFT, then starts an asynchronous regeneration of the body through the new type's template. Poll the regeneration status endpoint for its outcome; a regeneration that does not land leaves the previous body unchanged.",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			targetKind: z.enum(["BUG", "FEATURE"]),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		/**
		 * TWO DISTINCT TENANT QUESTIONS, AND MEMBERSHIP ANSWERS ONLY THE FIRST.
		 *
		 * (1) Is the caller in the organization they named? `resolveOrganizationId`
		 * hands back the caller-supplied id VERBATIM and runs no membership lookup,
		 * and `requireProjectPermission` resolves on (projectId, userId) without
		 * ever reading the org — so nothing above this line has checked. Same
		 * guard, same placement as `resolve-story-prompt.ts`.
		 *
		 * This became live with the regeneration: the redraft resolves the template
		 * binding and the AI model settings in this tenant's scope, which is the
		 * first tenant-keyed prompt read this procedure ever made.
		 */
		const claimedOrganizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (claimedOrganizationId) {
			await requireOrganizationMembership(claimedOrganizationId, user.id);
		}

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		/**
		 * (2) Does that organization own THIS project? Membership does not say so.
		 * A user who belongs to two organizations could convert an item in
		 * organization A's project while naming organization B: membership passes,
		 * and the redraft would then run B's prompt bindings and B's AI model
		 * settings over A's content and write the result back into A.
		 *
		 * So the tenant key that travels to the workflow is derived from the
		 * PROJECT row, and a caller-supplied id that disagrees with it is refused
		 * rather than quietly ignored — a caller naming the wrong tenant has a bug
		 * or an intent, and both deserve an answer.
		 */
		const organizationId = project.organizationId;
		if (claimedOrganizationId && claimedOrganizationId !== organizationId) {
			throw new ORPCError("FORBIDDEN", {
				message: "The organization supplied does not own this project",
			});
		}

		const existing = await db.userStory.findUnique({
			where: { id: input.storyId, projectId: input.projectId },
			include: {
				status: true,
				tasks: { orderBy: { order: "asc" } },
			},
		});

		if (!existing) {
			throw new ORPCError("NOT_FOUND", { message: "Story not found" });
		}

		// No-op when the caller asks to convert to the same kind: nothing is
		// written, no regeneration is started, and no job row is opened — there is
		// no new template to redraft through. Return the current row so callers
		// don't need to special-case it client-side.
		if (existing.kind === input.targetKind) {
			return {
				story: stripInternalStoryFields(existing),
				regeneration: { started: false, workflowId: null },
			};
		}

		const targetKind: StoryKind = input.targetKind;

		const story = await updateStory(
			input.storyId,
			input.projectId,
			{
				kind: targetKind,
				// Snap to DRAFT so the per-kind stage envelope is always
				// satisfied post-convert.
				draftingStage: "DRAFT",
			},
			{
				userId: user.id,
				// A personal project reads as `null` on the row and `undefined`
				// in the tenant context; both mean the same absence.
				organizationId: organizationId ?? undefined,
				changedBy: user.id,
				lastEditedSource: "MANUAL",
				lastEditedByName: user.name ?? null,
				changeDescription: `Converted ${existing.kind} → ${targetKind}`,
			},
		);

		/**
		 * The flip has landed; the body rewrite follows it asynchronously.
		 *
		 * Everything below is best-effort by design: a converted work item with its
		 * prior body is a valid, coherent state, so a dispatch failure is reported
		 * on the job row rather than rolled back into the caller's conversion.
		 */
		const workflowId = storyKindRegenerationWorkflowId(input.storyId);
		let started = false;
		try {
			const client = await getTemporalClient();
			const handle = await client.workflow.start(
				"regenerateBodyForKindWorkflow",
				withCorrelationMemo({
					taskQueue: "ai-chat",
					workflowId,
					/**
					 * The newest conversion wins (Fizzy #2048, FR4).
					 *
					 * The deterministic id above is what keeps a user who
					 * alternates an item's type from starting an unbounded series
					 * of minute-long model calls — only ever one runs per item.
					 * But rejecting the newer start is the wrong half of that
					 * trade: the in-flight redraft was written against the type
					 * the user has since moved away from, and it is discarded by
					 * the activity's version guard when it lands. Reject plus
					 * discard leaves the item on its NEW type carrying its OLD
					 * type's body — the exact mismatch this ticket exists to fix.
					 *
					 * Terminating instead means the last type selected is the one
					 * that gets regenerated, which is what FR4 asks for, and still
					 * caps concurrency at one run per item.
					 */
					workflowIdConflictPolicy: "TERMINATE_EXISTING",
					args: [
						{
							storyId: input.storyId,
							projectId: input.projectId,
							// The PROJECT's organization, never the caller's
							// claim. Omitting it does not fail — it silently
							// resolves the personal-context template and model
							// settings instead, which is the quiet way an org's
							// customized template stops being the one that runs.
							organizationId,
							userId: user.id,
							// Diagnostic only. The activity reads the kind back
							// off the stored row, because a caller-supplied kind
							// is a claim rather than a fact; this carries what
							// the conversion asked for so a log line can show the
							// two agreeing (or not).
							targetKind,
							// NFR1's "from which entry point" has no other source.
							entryPoint: STORY_KIND_CONVERSION_ENTRY_POINT,
						},
					],
				}),
			);
			started = true;

			/**
			 * The job row is opened AFTER the start, not before.
			 *
			 * A failed start leaves no orphan row to clean up.
			 *
			 * A second conversion DOES reach this line: the start policy terminates
			 * the in-flight run rather than refusing the new one, so the row opened
			 * here adopts the item's regeneration from the superseded run. That is
			 * the intended reading — one open row per item, always describing the
			 * newest conversion.
			 *
			 * No steps are seeded: the regeneration reports no per-step progress,
			 * and a seeded list would close out as a column of "skipped" steps
			 * reading as work that never happened.
			 */
			await createBackgroundJob({
				kind: "STORY_KIND_REGENERATION",
				title: existing.title,
				projectId: input.projectId,
				userId: user.id,
				organizationId,
				workflowId,
				runId: handle?.firstExecutionRunId ?? null,
				sourceType: "storyKindConversion",
				sourceId: input.storyId,
			});
		} catch (error) {
			if (isAlreadyStartedError(error)) {
				// One regeneration per item, by construction. The in-flight run
				// already owns the job row, so this conversion adds nothing to it.
				logger.info(
					"[stories.convertKind] a regeneration is already in flight for this work item",
					{
						projectId: input.projectId,
						storyId: input.storyId,
						workflowId,
					},
				);
			} else {
				logger.error(
					"[stories.convertKind] failed to start the body regeneration",
					{
						projectId: input.projectId,
						storyId: input.storyId,
						workflowId,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
				// Open the row and close it failed in one breath, so the user is
				// told the rewrite never started instead of being left with a
				// silently un-regenerated body.
				await createBackgroundJob({
					kind: "STORY_KIND_REGENERATION",
					title: existing.title,
					projectId: input.projectId,
					userId: user.id,
					organizationId,
					workflowId,
					sourceType: "storyKindConversion",
					sourceId: input.storyId,
				});
				await failBackgroundJob(
					{ workflowId, sourceId: input.storyId },
					{
						error: "Could not start the rewrite. The previous body was kept.",
						errorClass: "DispatchFailed",
					},
				);
			}
		}

		return {
			story: stripInternalStoryFields(story),
			regeneration: { started, workflowId },
		};
	});
