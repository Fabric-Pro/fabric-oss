/**
 * Story Automations
 *
 * Fires triage-triggered automations when stories move into columns
 * that have matching Skills. A Skill matches a column transition when:
 *   - The Skill has a tag matching the target column name (case-insensitive)
 *   - The Skill is published and visible to the project's tenant context
 *
 * Example: A Skill tagged "triage" will auto-run when a story moves
 * into the "Triage" column.
 *
 * This is a fire-and-forget operation — errors are logged but never
 * block the move-story response.
 */

import { db } from "@repo/database";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

interface StoryTransition {
	storyId: string;
	storyTitle: string;
	storyIdentifier: string;
	projectId: string;
	projectName: string;
	targetColumnName: string;
	userId: string;
	organizationId: string | null;
}

export async function fireColumnAutomations(
	transition: StoryTransition,
): Promise<void> {
	try {
		const columnTag = transition.targetColumnName.toLowerCase().trim();
		if (!columnTag) {
			return;
		}

		// Find published Skills tagged with the target column name
		const matchedSkills = await db.skill.findMany({
			where: {
				isPublished: true,
				tags: { has: columnTag },
				OR: [
					{ scope: "SYSTEM" },
					...(transition.organizationId
						? [
								{
									scope: "ORGANIZATION" as const,
									organizationId: transition.organizationId,
									userId: transition.userId,
								},
							]
						: []),
					{ scope: "USER" as const, userId: transition.userId },
				],
			},
			select: {
				id: true,
				name: true,
				slug: true,
				content: true,
			},
			take: 5,
		});

		if (matchedSkills.length === 0) {
			return;
		}

		// Fire each matched skill as a lightweight Fabric Agent prompt
		// Uses the existing orchestrator to execute the skill instructions
		// against the story context.
		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();

		for (const skill of matchedSkills) {
			const workflowId = `skill-auto-${skill.slug}-${transition.storyId}-${Date.now()}`;
			const prompt = [
				`Run the "${skill.name}" skill on this feature.`,
				"",
				`Feature: ${transition.storyIdentifier} — ${transition.storyTitle}`,
				`Project: ${transition.projectName}`,
				`Triggered by: story moved to "${transition.targetColumnName}" column`,
				"",
				"## Skill Instructions",
				skill.content,
			].join("\n");

			await client.workflow.start(
				"orchestratorExecutionWorkflow",
				withCorrelationMemo({
					workflowId,
					taskQueue: "orchestrator",
					// Absolute ceiling. This starter is fire-and-forget — a skill
					// fired by a column transition, with no stream or poll loop
					// watching it — so a wedged run here is even less visible
					// than an interactive one: nothing ever surfaces it.
					workflowExecutionTimeout: "1 hour",
					args: [
						{
							executionMode: "balanced",
							userId: transition.userId,
							organizationId:
								transition.organizationId ?? undefined,
							message: prompt,
							projectId: transition.projectId,
							userStoryId: transition.storyId,
						},
					],
				}),
			);

			await db.skill.update({
				where: { id: skill.id },
				data: { useCount: { increment: 1 } },
			});
		}
	} catch (error) {
		console.error(
			"[story-automations] Failed to fire column automations:",
			error instanceof Error ? error.message : error,
		);
	}
}
