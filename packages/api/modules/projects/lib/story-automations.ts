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

import { createHash } from "node:crypto";
import { db } from "@repo/database";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

interface StoryTransition {
	storyId: string;
	storyTitle: string;
	storyIdentifier: string;
	projectId: string;
	projectName: string;
	targetColumnName: string;
	/** Column the story left; null when it had none. */
	fromStatusId: string | null;
	/** Column the story entered. */
	toStatusId: string;
	/**
	 * When the transition landed (ISO 8601) — the story's edit clock as set
	 * by the move that changed its lane. Two moves of the same story cannot
	 * share it: the lane change is guarded by that clock.
	 */
	transitionAt: string;
	userId: string;
	/**
	 * The project's organization. A transition without one is refused: an
	 * automation is a real orchestrator run, and runs are organization-scoped
	 * (ADR-018) — the run's authority, memory and approval routes all resolve
	 * against its organization.
	 */
	organizationId: string | null;
}

/**
 * Deterministic `orch-<uuid>` id for one (transition, skill) pair.
 *
 * The approve/stream routes validate the `orch-<uuid>` shape, so the key is
 * folded into a UUID: the first 128 bits of a SHA-256 over the transition
 * fields, with the version and variant nibbles set so it reads as a v5-style
 * name-based UUID. Temporal refuses a second start with the same id
 * (`workflowIdReusePolicy: REJECT_DUPLICATE`), so a transition delivered
 * twice — a retried request, a replayed event — starts the skill once.
 */
export function automationWorkflowId(
	transition: Pick<
		StoryTransition,
		"storyId" | "fromStatusId" | "toStatusId" | "transitionAt"
	>,
	skillSlug: string,
): string {
	const key = [
		"story-column-automation",
		transition.storyId,
		transition.fromStatusId ?? "",
		transition.toStatusId,
		transition.transitionAt,
		skillSlug,
	].join("\u0000");
	const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
	const uuid = [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`5${hex.slice(13, 16)}`,
		`${((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
		hex.slice(20, 32),
	].join("-");
	return `orch-${uuid}`;
}

function isWorkflowAlreadyStarted(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.name === "WorkflowExecutionAlreadyStartedError"
	);
}

export async function fireColumnAutomations(
	transition: StoryTransition,
): Promise<void> {
	try {
		const columnTag = transition.targetColumnName.toLowerCase().trim();
		if (!columnTag) {
			return;
		}

		// Refuse before any lookup or start, rather than mapping the missing
		// organization to an organization-less run: nothing downstream (the
		// approve/stream routes, runtime authority, run memory) has a
		// personal arm to serve it from, so such a run could only ever be
		// unanswerable or misfiled.
		const organizationId = transition.organizationId;
		if (!organizationId) {
			console.error(
				"[story-automations] Refusing to fire column automations without an organization (ADR-018):",
				{
					storyId: transition.storyId,
					projectId: transition.projectId,
					targetColumnName: transition.targetColumnName,
				},
			);
			return;
		}

		// Find published Skills tagged with the target column name
		const matchedSkills = await db.skill.findMany({
			where: {
				isPublished: true,
				tags: { has: columnTag },
				OR: [
					{ scope: "SYSTEM" },
					{
						scope: "ORGANIZATION" as const,
						organizationId,
						userId: transition.userId,
					},
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
		const { getTemporalClient, ORCHESTRATOR_TASK_QUEUE } = await import(
			"@repo/temporal"
		);
		const client = await getTemporalClient();

		for (const skill of matchedSkills) {
			// Mirror the interactive starter
			// (apps/web/app/api/agents/fabric-ai/orchestrator-temporal/route.ts):
			// `orch-<uuid>` is the format the approve/stream routes validate,
			// the workflow is looked up by that id, and `createInitialState`
			// reads `input.executionId` as-is. The old `skill-auto-*` id left
			// the workflow with an undefined executionId and unreachable from
			// the approval UI. The id is derived from the transition, not
			// random, so the same transition cannot run the skill twice.
			const executionId = automationWorkflowId(transition, skill.slug);
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

			try {
				await client.workflow.start(
					"orchestratorExecutionWorkflow",
					withCorrelationMemo({
						workflowId: executionId,
						// One run per (transition, skill), ever: a closed run with
						// this id is still that transition's run, and a re-delivery
						// must not start it again.
						workflowIdReusePolicy: "REJECT_DUPLICATE",
						// The worker polls this queue. A literal here once said
						// "orchestrator", which nothing polls, so every automation
						// was accepted by Temporal and never ran.
						taskQueue: ORCHESTRATOR_TASK_QUEUE,
						// Absolute ceiling. This starter is fire-and-forget — a skill
						// fired by a column transition, with no stream or poll loop
						// watching it — so a wedged run here is even less visible
						// than an interactive one: nothing ever surfaces it.
						workflowExecutionTimeout: "1 hour",
						args: [
							{
								executionId,
								executionMode: "balanced",
								userId: transition.userId,
								organizationId,
								message: prompt,
								projectId: transition.projectId,
								userStoryId: transition.storyId,
							},
						],
						// The approve / status / stream routes authorize by reading
						// `memo.userId` and `memo.organizationId` off the running
						// workflow; without them a step that pauses for approval
						// (runtime authority, high-risk step) cannot be answered.
						// The extra keys keep the trigger traceable in Temporal UI
						// now that the workflowId no longer names the skill.
						memo: {
							userId: transition.userId,
							organizationId,
							trigger: "story-column-automation",
							skillSlug: skill.slug,
							storyId: transition.storyId,
						},
					}),
				);
			} catch (error) {
				if (isWorkflowAlreadyStarted(error)) {
					// This transition already started this skill (a duplicate
					// delivery). Nothing to do — and no second use to count.
					continue;
				}
				throw error;
			}

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
