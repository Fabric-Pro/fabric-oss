import { ORPCError } from "@orpc/client";
import { getLockedAttachmentRulesClause } from "@repo/agent-prompts";
import { AIProviderNotConfiguredError } from "@repo/ai";
import { getProjectFunctionTagClause } from "@repo/ai/lib/function-tag-context";
import { db, generateTaskIdentifier } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Generate tasks for a user story using AI
 * Takes the story title, description, and acceptance criteria to generate implementation tasks
 */
export const generateTasksProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/generate-tasks",
		tags: ["Projects", "Stories", "Tasks"],
		summary: "Generate tasks for a story using AI",
		description:
			"Use AI to analyze a user story and generate implementation tasks",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Fetch the story
		const story = await db.userStory.findFirst({
			where: {
				id: input.storyId,
				projectId: input.projectId,
			},
			include: {
				tasks: true,
			},
		});

		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Story not found",
			});
		}

		// Build prompt for task generation. Fizzy #1767 Stage 4: append the
		// project's function-tag role-composition clause (flag-gated,
		// self-authorizing — see getProjectFunctionTagClause) so task
		// generation knows who's on the project and in what capacity. No-op
		// when the flag is off or no roster member holds a tag.
		const roleClause = await getProjectFunctionTagClause({
			projectId: input.projectId,
			requesterUserId: user.id,
			surface: "generate-tasks",
		});
		const prompt =
			buildTaskGenerationPrompt(story) +
			(roleClause ? `\n\n${roleClause}` : "");

		// Call AI to generate tasks
		const generatedTasks = await generateTasksWithAI(
			prompt,
			user.id,
			organizationId,
		);

		// Create tasks in database
		const createdTasks = [];
		let taskOrder = story.tasks.length; // Start after existing tasks

		for (const taskData of generatedTasks) {
			const identifier = await generateTaskIdentifier(story.id);
			const task = await db.storyTask.create({
				data: {
					storyId: story.id,
					identifier,
					title: taskData.title,
					description: taskData.description,
					estimatedHours: taskData.estimatedHours,
					order: taskOrder,
				},
			});
			createdTasks.push(task);
			taskOrder++;
		}

		return {
			success: true,
			tasksCreated: createdTasks.length,
			tasks: createdTasks,
		};
	});

interface StoryData {
	title: string;
	description: string | null;
	acceptanceCriteria: string | null;
	identifier: string;
}

// FR-25: the prompt embeds the shared
// locked-attachment rule (getLockedAttachmentRulesClause) between the feature
// body and the task instructions, so a generated task never claims to have seen
// or analysed a locked attachment. Exported for a focused prompt-assembly test.
// No-op today (no attachment metadata reaches AI context).
export function buildTaskGenerationPrompt(story: StoryData): string {
	return `You are a senior software developer breaking down a feature into implementation tasks.

## Feature
**${story.identifier}: ${story.title}**

${story.description ? `### Description\n${story.description}\n` : ""}
${story.acceptanceCriteria ? `### Acceptance Criteria\n${story.acceptanceCriteria}\n` : ""}

${getLockedAttachmentRulesClause()}

## Instructions
Generate 3-7 specific implementation tasks for this feature. Each task should be:
- A concrete developer action (e.g., "Create API endpoint for X", "Add database migration", "Write unit tests for Y")
- Small enough to complete in 1-4 hours
- Clear and actionable

Return ONLY a JSON array with the following structure:
[
  {"title": "Task title", "description": "Brief description", "estimatedHours": 2},
  ...
]

Do not include any explanation, just the JSON array.`;
}

interface GeneratedTask {
	title: string;
	description?: string;
	estimatedHours?: number;
}

async function generateTasksWithAI(
	prompt: string,
	userId: string,
	organizationId?: string,
): Promise<GeneratedTask[]> {
	const { generateText } = await import("ai");
	// Resolve via getAIModelWithMetadata (instead of the getAIModel wrapper, which
	// discards metadata) so the generateText call below can size an explicit
	// output-token budget — the same switch as deep-researcher/aggregation.ts. The
	// wrapper never called trackUsage, so destructuring only { model, metadata }
	// preserves this site's behavior exactly (no usage-tracking added).
	const { getAIModelWithMetadata } = await import("@repo/ai");
	const { computeMaxOutputTokenBudget } = await import(
		"@repo/ai/lib/output-token-budget"
	);

	try {
		// Use centralized single entry point for AI model access
		const { model, metadata } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{ userId, organizationId, featureKey: "generate-tasks" },
		);

		// The JSON task array is the entire product of this call — maximal mode
		// (mirrors aggregation.ts). Without an explicit budget Databricks/
		// Anthropic-direct truncate at their injected defaults (8,192 / 4,096),
		// which then throws in JSON.parse below and drops to the fallback tasks.
		const maxOutputTokens = computeMaxOutputTokenBudget(metadata, {
			promptChars: prompt.length,
		});

		const result = await generateText({
			model,
			prompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		});

		// Parse the JSON response
		const text = result.text.trim();

		// Extract JSON array from response (handle potential markdown code blocks)
		let jsonStr = text;
		if (text.includes("```")) {
			const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
			if (match) {
				jsonStr = match[1].trim();
			}
		}

		const tasks = JSON.parse(jsonStr) as GeneratedTask[];

		// Validate and sanitize
		return tasks
			.filter((t) => t.title && typeof t.title === "string")
			.map((t) => ({
				title: t.title.substring(0, 500), // Limit title length
				description: t.description?.substring(0, 2000),
				estimatedHours:
					typeof t.estimatedHours === "number"
						? t.estimatedHours
						: undefined,
			}))
			.slice(0, 10); // Max 10 tasks
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message: error.message,
			});
		}
		console.error("Failed to generate tasks with AI:", error);
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Failed to generate tasks. Please try again.",
		});
	}
}
