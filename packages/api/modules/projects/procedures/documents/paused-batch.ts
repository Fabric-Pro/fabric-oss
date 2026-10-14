import { ORPCError } from "@orpc/server";
import {
	bulkRunResumeWorkflowId,
	cancelPausedBulkRun,
	failQueuedDocumentsOfRun,
	getPausedDocumentBatch,
	hasProjectAccess,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	getPausedRunApiAccess,
	runPausedBulkRunOnApi,
} from "../../lib/paused-bulk-run";
import { resolveProjectOrganizationId } from "../../lib/project-organization";

const CANCELLED_MESSAGE =
	"Cancelled while waiting for a ChatGPT plan reset. Generate it again when you are ready.";

const projectInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

async function requireAccess(
	projectId: string,
	userId: string,
	organizationId: string | null,
) {
	if (
		!(await hasProjectAccess(
			projectId,
			userId,
			organizationId ?? undefined,
		))
	) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have access to this project",
		});
	}
}

/** The project's paused batch, refused unless `runId` is that batch. */
async function requirePausedBatch(args: {
	projectId: string;
	organizationId: string | null;
	userId: string;
	runId: string;
}) {
	const batch = await getPausedDocumentBatch(args);
	if (!batch || batch.id !== args.runId) {
		throw new ORPCError("CONFLICT", {
			message:
				"This batch is no longer waiting for a ChatGPT plan reset.",
		});
	}
	return batch;
}

/**
 * The project's batch document generation paused for a ChatGPT plan reset
 * (Fizzy #2770), if one is: when it resumes, how many documents it still has
 * to write, and whether it may run now on the organization's AI provider.
 */
export const getPausedBatchProcedure = tenantProtectedProcedure
	.route({
		method: "GET",
		path: "/projects/:projectId/documents/paused-batch",
		tags: ["Projects", "Documents"],
		summary: "The batch generation paused for a ChatGPT plan reset",
	})
	.input(projectInput)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveProjectOrganizationId(
			input.organizationId,
			input.projectId,
		);
		await requireAccess(input.projectId, context.user.id, organizationId);
		const batch = await getPausedDocumentBatch({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
		});
		if (!batch) {
			return { batch: null };
		}
		return {
			batch: {
				...batch,
				...(await getPausedRunApiAccess({
					organizationId,
					userId: context.user.id,
				})),
			},
		};
	});

/** Cancel a paused batch: its queued documents fail with the reason. */
export const cancelPausedBatchProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/documents/paused-batch/cancel",
		tags: ["Projects", "Documents"],
		summary: "Cancel a batch generation paused for a ChatGPT plan reset",
	})
	.input(projectInput.extend({ runId: z.string() }))
	.handler(async ({ input, context }) => {
		const organizationId = await resolveProjectOrganizationId(
			input.organizationId,
			input.projectId,
		);
		await requireAccess(input.projectId, context.user.id, organizationId);
		await requirePausedBatch({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			runId: input.runId,
		});
		const cancelled = await cancelPausedBulkRun({
			kind: "DOCUMENT_BATCH",
			runId: input.runId,
			message: CANCELLED_MESSAGE,
		});
		if (!cancelled) {
			return { cancelled: false };
		}
		const scheduledWorkflowId = bulkRunResumeWorkflowId(
			cancelled.resumeState.workflowIdBase,
			cancelled.pauseCount,
		);
		await failQueuedDocumentsOfRun({
			workflowId: scheduledWorkflowId,
			message: CANCELLED_MESSAGE,
		});
		try {
			const { getTemporalClient } = await import("@repo/temporal");
			const client = await getTemporalClient();
			await client.workflow
				.getHandle(scheduledWorkflowId)
				.terminate("Cancelled by user");
		} catch {
			// The resume finds the row cancelled and ends on its own.
		}
		return { cancelled: true };
	});

/**
 * "Run now on API billing" for a paused batch: it resumes at once on the
 * organization's own provider, for this run only, audited.
 */
export const runPausedBatchOnApiProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/documents/paused-batch/run-on-api",
		tags: ["Projects", "Documents"],
		summary: "Resume a paused batch now on the organization's AI provider",
	})
	.input(projectInput.extend({ runId: z.string() }))
	.handler(async ({ input, context }) => {
		const organizationId = await resolveProjectOrganizationId(
			input.organizationId,
			input.projectId,
		);
		await requireAccess(input.projectId, context.user.id, organizationId);
		await requirePausedBatch({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			runId: input.runId,
		});
		return runPausedBulkRunOnApi({
			context,
			kind: "DOCUMENT_BATCH",
			runId: input.runId,
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
			impersonatedBy: context.session.impersonatedBy,
		});
	});
