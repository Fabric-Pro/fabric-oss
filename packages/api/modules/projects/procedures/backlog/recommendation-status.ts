import {
	getTemporalClient,
	type RoadmapRecommendationProgress,
	roadmapRecommendationProgressQuery,
} from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { roadmapRecommendationWorkflowId } from "./workflow-id";

const ENTRY_POINT = z.enum([
	"EMPTY_ROADMAP",
	"MATURE_ROADMAP",
	"DO_BOTH_AFTER_PULL",
]);

// Every field is declared: an oRPC `.output()` schema silently strips any
// field it does not list.
const recommendationStatusSchema = z.discriminatedUnion("state", [
	z.object({ state: z.literal("idle") }),
	z.object({
		state: z.literal("running"),
		phase: z.enum(["gathering", "generating", "persisting"]),
		entryPoint: ENTRY_POINT,
	}),
	z.object({
		state: z.literal("completed"),
		outcome: z.enum([
			"GENERATED",
			"NO_RECOMMENDATIONS",
			"INSUFFICIENT_CONTEXT",
		]),
		proposalId: z.string().nullable(),
		changeCount: z.number(),
		entryPoint: ENTRY_POINT,
	}),
	z.object({ state: z.literal("failed") }),
]);

type RecommendationStatus = z.infer<typeof recommendationStatusSchema>;

const RUNNING_PHASES = new Set(["gathering", "generating", "persisting"]);

/**
 * The entry point a run was started from, as recorded in its memo. Runs
 * started before the memo was written fall back to the generic entry point.
 */
function entryPointFromMemo(
	memo: Record<string, unknown> | undefined,
): z.infer<typeof ENTRY_POINT> {
	const parsed = ENTRY_POINT.safeParse(memo?.entryPoint);
	return parsed.success ? parsed.data : "MATURE_ROADMAP";
}

/**
 * The project's latest roadmap-recommendation run (Fizzy #2208), read from
 * Temporal by the deterministic per-project workflow id. A failed run reports
 * `failed` with no raw error text. Read-only, so the flag is not checked: the
 * entry point is not rendered while it is off.
 */
export const recommendationStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/backlog/recommendations/status",
		tags: ["Projects", "Backlog"],
		summary: "Get the roadmap recommendation run status",
	})
	.input(z.object({ projectId: z.string() }))
	.output(recommendationStatusSchema)
	.handler(async ({ input }): Promise<RecommendationStatus> => {
		const client = await getTemporalClient();
		const handle = client.workflow.getHandle(
			roadmapRecommendationWorkflowId(input.projectId),
		);

		let statusName: string;
		let memo: Record<string, unknown> | undefined;
		try {
			const description = await handle.describe();
			statusName = description.status.name;
			memo = description.memo;
		} catch (error) {
			if (
				error instanceof Error &&
				error.name === "WorkflowNotFoundError"
			) {
				return { state: "idle" };
			}
			throw error;
		}

		if (statusName === "RUNNING") {
			let progress: RoadmapRecommendationProgress;
			try {
				progress = await handle.query(
					roadmapRecommendationProgressQuery,
				);
			} catch {
				// A run whose first workflow task has not completed yet (or with
				// no worker polling) cannot answer queries. It is still running,
				// and it has not got past gathering.
				return {
					state: "running",
					phase: "gathering",
					entryPoint: entryPointFromMemo(memo),
				};
			}
			return {
				state: "running",
				// The query can land between the last activity and completion.
				phase: RUNNING_PHASES.has(progress.status)
					? (progress.status as
							| "gathering"
							| "generating"
							| "persisting")
					: "persisting",
				entryPoint: progress.entryPoint,
			};
		}

		if (statusName === "COMPLETED") {
			const result = await handle.result();
			return {
				state: "completed",
				outcome: result.outcome,
				proposalId: result.proposalId,
				changeCount: result.changeCount,
				entryPoint: result.entryPoint,
			};
		}

		return { state: "failed" };
	});
