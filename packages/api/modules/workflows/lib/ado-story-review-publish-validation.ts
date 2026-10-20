import { getFrameById } from "@repo/database";
import { resolveProjectPmRead } from "@repo/mcp/lib/project-pm-read";
import type { AdoStoryReviewConfig } from "@repo/temporal/ado-story-review-config";
import { loadReviewEvaluator } from "@repo/temporal/ado-story-review-evaluator";

interface ReviewNode {
	name: string;
	config: AdoStoryReviewConfig;
}

interface ReviewActor {
	userId: string;
	organizationId: string | null;
	projectId: string | null;
}

/** Check current run-as access without reading ADO stories or invoking a model. */
export async function adoStoryReviewPublishProblems(
	reviews: ReviewNode[],
	actor: ReviewActor,
): Promise<string[]> {
	if (reviews.length === 0) {
		return [];
	}
	if (!actor.organizationId || !actor.projectId) {
		return reviews.map(
			({ name }) =>
				`${name}: link this workflow to a project in its organization before reviewing stories.`,
		);
	}
	const context = {
		userId: actor.userId,
		organizationId: actor.organizationId,
		projectId: actor.projectId,
	};
	try {
		const read = await resolveProjectPmRead(context);
		if (read.status !== "ready") {
			return reviews.map(
				({ name }) =>
					`${name}: the workflow owner needs a connected Azure DevOps account for the attached project.`,
			);
		}
	} catch {
		return reviews.map(
			({ name }) =>
				`${name}: the project connection could not be verified. Try again.`,
		);
	}
	const problems: string[] = [];
	for (const { name, config } of reviews) {
		try {
			if (config.workspaceFrameId) {
				const frame = await getFrameById({
					id: config.workspaceFrameId,
					userId: context.userId,
					organizationId: context.organizationId,
				});
				if (
					!frame ||
					frame.userId !== context.userId ||
					frame.organizationId !== context.organizationId ||
					frame.surface !== "workspace" ||
					(frame.projectId && frame.projectId !== context.projectId)
				) {
					problems.push(
						`${name}: choose one of your Workspaces in this project or an unattached Workspace.`,
					);
					continue;
				}
			}
			await loadReviewEvaluator(config, context);
		} catch {
			problems.push(
				`${name}: selected review instructions could not be verified. Check the agent and published skills.`,
			);
		}
	}
	return problems;
}
