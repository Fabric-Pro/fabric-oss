import { ORPCError } from "@orpc/client";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { CLASSIFY_WORKFLOW_ID_PREFIX } from "./classify-tracks";

const ProgressOutput = z.object({
	status: z.enum(["initializing", "classifying", "complete", "failed"]),
	message: z.string(),
	classified: z.number(),
	skipped: z.number(),
	error: z.string().optional(),
});

/**
 * Query a running (or just-finished) delivery-track classification workflow.
 *
 * The workflow id must belong to the project in the input — ids are
 * `track-classify-<projectId>-<ts>` — so a reader of one project cannot probe
 * another project's runs.
 *
 * AUTHORIZATION: `requireProjectPermission(STORY_READ)`.
 */
export const classificationProgressProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/classify-tracks/{workflowId}",
		tags: ["Projects", "Features"],
		summary: "Get delivery-track classification progress",
		description:
			"Progress of a running delivery-track classification workflow.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			workflowId: z.string(),
		}),
	)
	.output(ProgressOutput)
	.handler(async ({ input }) => {
		const expectedPrefix = `${CLASSIFY_WORKFLOW_ID_PREFIX}${input.projectId}-`;
		if (!input.workflowId.startsWith(expectedPrefix)) {
			throw new ORPCError("NOT_FOUND", {
				message: "Classification workflow not found",
			});
		}

		const { getTemporalClient, classificationProgressQuery } = await import(
			"@repo/temporal"
		);
		const client = await getTemporalClient();
		const handle = client.workflow.getHandle(input.workflowId);

		try {
			const progress = await handle.query(classificationProgressQuery);
			return ProgressOutput.parse(progress);
		} catch (_queryError) {
			// Queries fail once the workflow has closed; fall back to result.
			try {
				const result = await Promise.race([
					handle.result(),
					new Promise<never>((_, reject) =>
						setTimeout(
							() => reject(new Error("Result timeout")),
							3_000,
						),
					),
				]);
				return {
					status: "complete" as const,
					message: `Classified ${result.classified} feature(s)`,
					classified: result.classified,
					skipped: result.skipped,
					error:
						result.errors.length > 0
							? result.errors.join("; ")
							: undefined,
				};
			} catch (resultError) {
				const err = resultError as Error & { cause?: Error };
				const message =
					err.cause?.message ??
					err.message ??
					"Classification failed";
				if (message === "Result timeout") {
					throw new ORPCError("NOT_FOUND", {
						message:
							"Classification workflow not found or still closing",
					});
				}
				return {
					status: "failed" as const,
					message,
					classified: 0,
					skipped: 0,
					error: message,
				};
			}
		}
	});
