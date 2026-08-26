import { db } from "@repo/database";

export interface RunPatternGenerationParams {
	planId: string;
	/** Resolved Pattern planner base URL (preflighted by the caller). */
	patternUrl: string;
	/** The user-facing task statement sent to Pattern. */
	message: string;
	userId: string;
	organizationId: string | null;
	projectContext: {
		projectId: string;
		projectName: string;
		description?: string;
		techStack?: string;
	};
	/** Revision runs keep the reviewable plan on failure (see below). */
	isRevision: boolean;
	/**
	 * Pre-call plan description. Used as the description fallback when
	 * Pattern returns checkboxes without an analysis.
	 */
	priorDescription?: string | null;
}

/**
 * Shared Pattern-invocation continuation for plan create, revise, and retry.
 *
 * Calls the Pattern planner over A2A and persists the outcome on the plan
 * row. Designed to run detached from the request (via `runInBackground`):
 * it never throws — every failure, including persistence failures, is
 * caught and logged, and failure state is written to the plan so the UI
 * polling loop always terminates.
 *
 * Outcomes:
 * - Pattern returned checkboxes → persist `checkboxes`, `description`
 *   (analysis slice ≤500 chars, falling back to `priorDescription`) and
 *   `PENDING_APPROVAL`.
 * - Pattern returned no checkboxes → `PENDING_APPROVAL` (status only).
 * - Failure with `isRevision: false` (create/retry) → `FAILED` with the
 *   failure copy. The plan never reverts to DRAFT, so polling stops and the
 *   failure is visible.
 * - Failure with `isRevision: true` → restore `PENDING_APPROVAL` with the
 *   revision-failure copy; the prior checkboxes stay reviewable.
 */
export async function runPatternGeneration(
	params: RunPatternGenerationParams,
): Promise<void> {
	try {
		const { SecureA2AClient } = await import("@repo/agent-core");
		const client = new SecureA2AClient({
			timeout: 120_000,
			sourceAgent: "api",
		});

		const taskResult = await client.sendMessageSecure(
			params.patternUrl,
			{
				role: "user",
				parts: [{ type: "text", text: params.message }],
				metadata: {
					planId: params.planId,
					...(params.isRevision ? { isRevision: true } : {}),
					tenantContext: {
						userId: params.userId,
						organizationId: params.organizationId,
					},
					projectContext: params.projectContext,
				},
			},
			{
				userId: params.userId,
				organizationId: params.organizationId,
			},
		);

		const result = taskResult as unknown as {
			success?: boolean;
			checkboxes?: unknown[];
			analysis?: string;
		};

		if (result.checkboxes && Array.isArray(result.checkboxes)) {
			await db.weavePlan.update({
				where: { id: params.planId },
				data: {
					checkboxes: result.checkboxes as any,
					description:
						result.analysis?.slice(0, 500) ||
						params.priorDescription,
					status: "PENDING_APPROVAL",
				},
			});
		} else {
			await db.weavePlan.update({
				where: { id: params.planId },
				data: { status: "PENDING_APPROVAL" },
			});
		}
	} catch (error) {
		console.error(
			params.isRevision
				? "[weave] Pattern plan revision failed:"
				: "[weave] Pattern plan generation failed:",
			error,
		);
		const message =
			error instanceof Error ? error.message : "Unknown error";
		try {
			if (params.isRevision) {
				// A failed revision still has fully reviewable prior
				// checkboxes — restore the reviewable plan instead of
				// bricking it.
				await db.weavePlan.update({
					where: { id: params.planId },
					data: {
						status: "PENDING_APPROVAL",
						description: `Revision failed: ${message}. You can still approve the original plan or try again.`,
					},
				});
			} else {
				await db.weavePlan.update({
					where: { id: params.planId },
					data: {
						status: "FAILED",
						description: `Plan generation failed: ${message}.`,
					},
				});
			}
		} catch (persistError) {
			console.error(
				"[weave] Failed to persist plan failure state:",
				persistError,
			);
		}
	}
}
