import { ORPCError } from "@orpc/server";
import { db, isFeatureEnabled } from "@repo/database";

/**
 * The shared door for every `projects.aiRecommended.*` procedure (Fizzy #2211).
 *
 * `AI_RECOMMENDED_LIFECYCLE` is resolved with the organization that OWNS the
 * project, read here, never the session's active one — so the per-organization
 * rollout reaches the doors exactly as it reaches the page. Off answers
 * NOT_FOUND: the feature is absent rather than present and failing.
 *
 * Returns the project's organization for the caller's writes, so a procedure
 * never has to take one from its input.
 */
export async function assertAiRecommendedLifecycleEnabled(
	projectId: string,
): Promise<{ organizationId: string | null }> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true },
	});
	if (
		!project ||
		!(await isFeatureEnabled(
			"AI_RECOMMENDED_LIFECYCLE",
			project.organizationId ?? undefined,
		))
	) {
		throw new ORPCError("NOT_FOUND", {
			message: "AI-recommended item lifecycle is not enabled.",
		});
	}
	return { organizationId: project.organizationId ?? null };
}
