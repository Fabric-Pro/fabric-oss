/**
 * The state of the body regeneration a type conversion started (Fizzy #2048).
 *
 * A conversion redrafts the work item's body through its new type's template,
 * asynchronously — the model call runs on the order of a minute. An asynchronous
 * rewrite the user cannot observe is worse than a synchronous one, so the state
 * is PERSISTED rather than inferred: the conversion opens a `BackgroundJob` row,
 * the workflow closes it, a watchdog fails it if the worker dies mid-run, and
 * this read is what the detail view polls.
 *
 * Reading a row rather than querying Temporal is what makes the progress survive
 * a page reload and a navigation away, and it is what lets a refusal ("the
 * rewrite came back empty, your previous body was kept") reach the user at all.
 *
 * Read-only, like the rest of the Job Hub surface: there is no way to start,
 * mutate or cancel a regeneration through this endpoint.
 */

import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireOrganizationMembership,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { storyKindRegenerationWorkflowId } from "./convert-kind";

/**
 * What the caller sees. `idle` is not an error state — it is the answer for a
 * work item that was never converted, and the answer once the row has aged past
 * the Job Hub's retention window.
 */
type StoryRegenerationStatus = "idle" | "running" | "completed" | "failed";

export interface GetStoryRegenerationStatusResult {
	status: StoryRegenerationStatus;
	/** User-facing reason a regeneration did not land. Never a stack trace. */
	error: string | null;
	/** Machine class of that reason, matching the activity's typed status. */
	errorClass: string | null;
	startedAt: string | null;
	completedAt: string | null;
}

export const getStoryRegenerationStatusProcedure = tenantProtectedProcedure
	// PROJECT_READ: this reports whether a rewrite is running and why one was
	// refused. It returns no prompt text and no regenerated content — anyone who
	// can read the work item can see whether it is being rewritten.
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}/regeneration-status",
		tags: ["Projects", "Stories"],
		summary: "Status of the body regeneration started by a type conversion",
		description:
			"Reports whether the body rewrite a BUG ↔ FEATURE conversion started is running, finished, or was refused. A refusal means the previous body was kept.",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(
		async ({
			input,
			context,
		}): Promise<GetStoryRegenerationStatusResult> => {
			/**
			 * The organization arrives from the client and is never trusted as a
			 * filter. It is not needed to answer this question at all — the job row
			 * is found by (projectId, workflowId), and `requireProjectPermission`
			 * has already proven the caller reaches this project — but a caller
			 * naming an organization they do not belong to is refused rather than
			 * silently ignored, matching the conversion it reports on.
			 */
			if (input.organizationId) {
				await requireOrganizationMembership(
					input.organizationId,
					context.user.id,
				);
			}

			const job = await db.backgroundJob.findFirst({
				where: {
					projectId: input.projectId,
					// Derived from the story id by the same function the conversion
					// starts the workflow with, so the reader cannot drift from the
					// writer.
					workflowId: storyKindRegenerationWorkflowId(input.storyId),
					kind: "STORY_KIND_REGENERATION",
				},
				orderBy: { createdAt: "desc" },
				select: {
					status: true,
					error: true,
					errorClass: true,
					startedAt: true,
					completedAt: true,
				},
			});

			if (!job) {
				return {
					status: "idle",
					error: null,
					errorClass: null,
					startedAt: null,
					completedAt: null,
				};
			}

			return {
				status:
					job.status === "RUNNING"
						? "running"
						: job.status === "COMPLETED"
							? "completed"
							: "failed",
				error: job.error,
				errorClass: job.errorClass,
				startedAt: job.startedAt.toISOString(),
				completedAt: job.completedAt?.toISOString() ?? null,
			};
		},
	);
