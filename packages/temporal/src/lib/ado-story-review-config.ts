import { z } from "zod";

export const ADO_REVIEW_MAX_STORIES = 50;
export const ADO_REVIEW_MAX_INPUT_CHARS = 120_000;

const field = z
	.string()
	.max(128)
	.regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/);

const literalName = z
	.string()
	.refine(
		(value) =>
			!/[\u0000-\u001f\u007f]/.test(value) &&
			!(value.includes("'") && value.includes('"')),
		"Use a literal name without control characters or mixed quotes",
	);
const sprintName = (maxLength: number) =>
	literalName
		.max(maxLength)
		.transform((value) => value.trim())
		.pipe(z.string().min(1));
const sortedNames = (maxCount: number, maxLength = 128) =>
	z
		.array(sprintName(maxLength))
		.max(maxCount)
		.transform((values) => [...new Set(values)].sort());

export const adoSprintContextSchema = z
	.object({
		iterationPaths: sortedNames(2, 512).refine(
			(paths) =>
				paths.length > 0 &&
				paths.every((path) =>
					path.split("\\").every((part) => part.trim().length > 0),
				),
			"Select one or two exact iteration paths",
		),
		assignmentFields: z
			.array(z.enum(["System.AssignedTo", "Custom.Engineer"]))
			.min(1)
			.max(2)
			.transform((values) => [...new Set(values)].sort()),
		assignedItemTypes: sortedNames(20).refine((types) => types.length > 0),
		parentSourceTypes: sortedNames(20),
		relationKinds: z
			.array(z.enum(["child", "related"]))
			.max(2)
			.transform((values) => [...new Set(values)].sort()),
		excludedAssignedStates: sortedNames(20).default([]),
	})
	.strict()
	.refine(
		(selection) =>
			selection.parentSourceTypes.every((type) =>
				selection.assignedItemTypes.includes(type),
			),
		"Parent source types must be selected assigned item types",
	);

/** Agent selections reuse instructions and model preferences, without executing tools. */
export const adoStoryReviewConfigFieldsSchema = z.object({
	sprintContext: adoSprintContextSchema.optional(),
	assignee: z.discriminatedUnion("mode", [
		z.object({ mode: z.literal("current") }),
		z.object({
			mode: z.literal("selected"),
			uniqueName: literalName.trim().min(1).max(512),
		}),
	]),
	workItemTypes: z
		.array(literalName.trim().min(1).max(128))
		.min(1)
		.max(20)
		.default(["User Story"]),
	requirementFields: z
		.array(field)
		.min(1)
		.max(20)
		.default([
			"System.Title",
			"System.Description",
			"Microsoft.VSTS.Common.AcceptanceCriteria",
		]),
	model: z.string().trim().min(1).max(256).optional(),
	workspaceFrameId: z.string().min(1).max(128).optional(),
	agentInstructionsInstanceId: z.string().min(1).max(128).optional(),
	skills: z
		.array(
			z.object({
				slug: z.string().min(1).max(128),
				textFiles: z
					.array(
						z
							.string()
							.min(1)
							.max(256)
							.regex(/\.(?:md|txt|json|ya?ml|csv)$/i),
					)
					.max(10)
					.default([]),
			}),
		)
		.max(5)
		.default([])
		.refine(
			(skills) =>
				new Set(skills.map((skill) => skill.slug)).size ===
				skills.length,
			"Select each skill only once",
		),
	rubric: z.string().trim().min(1).max(16_000),
	maxStories: z.number().int().min(1).max(ADO_REVIEW_MAX_STORIES).default(20),
});

export const adoStoryReviewStrictAssigneeSchema = z.discriminatedUnion("mode", [
	adoStoryReviewConfigFieldsSchema.shape.assignee.options[0].strict(),
	adoStoryReviewConfigFieldsSchema.shape.assignee.options[1].strict(),
]);

export const adoStoryReviewConfigSchema =
	adoStoryReviewConfigFieldsSchema.transform((config) => ({
		...config,
		workItemTypes: [...new Set(config.workItemTypes)].sort(),
		requirementFields: [...new Set(config.requirementFields)].sort(),
		skills: config.skills
			.map((skill) => ({
				...skill,
				textFiles: [...new Set(skill.textFiles)].sort(),
			}))
			.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)),
	}));

export type AdoStoryReviewConfig = z.infer<typeof adoStoryReviewConfigSchema>;

/** Reserved execution metadata authored by the bound controller command. */
export const workspaceStoryReviewRunBindingSchema = z
	.object({
		kind: z.literal("workspace-story-review"),
		version: z.literal(1),
		workflowId: z.string().min(1).max(128),
		workspaceFrameId: z.string().min(1).max(128),
		projectId: z.string().min(1).max(128),
		nodeId: z.string().min(1).max(128),
		workflowUpdatedAt: z.string().datetime(),
		frameUpdatedAt: z.string().datetime(),
		forceReview: z.boolean(),
	})
	.strict();
