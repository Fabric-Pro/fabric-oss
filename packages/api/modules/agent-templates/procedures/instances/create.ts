import { ORPCError } from "@orpc/server";
import {
	createAgentTemplateInstance,
	getAgentTemplate,
	hasWorkspaceAccess,
	initializeMemoryFromTemplate,
	writeMemoryFile,
} from "@repo/database";
import { db } from "@repo/database/prisma/client";
import type { Prisma } from "@repo/database/prisma/generated/client";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { syncDeploymentTriggers } from "../../../agent-deployments/lib/sync-triggers";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";
import {
	knowledgeConnectionsSchema,
	knowledgeResourcesSchema,
	toolConnectionsSchema,
	validateAllConnections,
} from "../../lib/validate-connections";

const requiredText = (field: string, max: number) =>
	z.string().trim().min(1, `${field} is required`).max(max);

const customInstructionsSchema = z
	.object({
		role: z.string().trim().optional(),
		additionalContext: z.string().trim().optional(),
		constraints: z.string().trim().optional(),
	})
	.passthrough()
	.refine(
		(value) =>
			typeof value.role === "string"
				? value.role.length > 0
				: typeof value.additionalContext === "string"
					? value.additionalContext.length > 0
					: false,
		{
			message: "Instructions are required",
		},
	);

const successCriteriaSchema = z
	.object({
		type: z.enum([
			"llm_judge",
			"output_contains",
			"tool_success",
			"custom",
		]),
		evaluationPrompt: z.string().optional(),
		requiredOutputs: z.array(z.string()).optional(),
		requiredTools: z.array(z.string()).optional(),
		confidenceThreshold: z.number().min(0).max(1).optional(),
	})
	.optional();

const createInputSchema = z
	.object({
		organizationId: z.string().nullable().optional(),
		templateId: z.string(),
		name: requiredText("Name", 200),
		description: requiredText("Description", 500),
		heroEmojis: z.array(z.string()).optional(),
		heroImageUrl: z.string().url().optional(),
		customInstructions: customInstructionsSchema,
		knowledgeConnections: knowledgeConnectionsSchema,
		knowledgeResources: knowledgeResourcesSchema,
		toolConnections: toolConnectionsSchema,
		triggers: z.any().optional(),
		modelOverride: z.string().optional(),
		modelConfig: z.any().optional(),
		workspaceIds: z.array(z.string()).optional(),
		// Goal-oriented execution configuration
		executionMode: z
			.enum(["single_turn", "goal_oriented"])
			.default("single_turn"),
		goal: z.string().min(1).max(2000).optional(),
		successCriteria: successCriteriaSchema,
		maxIterations: z.number().min(1).max(50).default(10),
		additionalSkillIds: z.array(z.string()).optional(),
	})
	.refine(
		(data) => {
			// Goal is required when execution mode is goal_oriented
			if (data.executionMode === "goal_oriented" && !data.goal) {
				return false;
			}
			return true;
		},
		{
			message: "Goal is required when execution mode is 'goal_oriented'",
			path: ["goal"],
		},
	);

export const createInstanceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_MANAGE))
	.input(createInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if creating an org instance
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				context.user.id,
			);
			if (!membership) {
				throw new Error(
					"You must be a member of the organization to create agents for it",
				);
			}
		}

		// Verify template exists and check scope permissions
		const template = await getAgentTemplate(input.templateId);
		if (!template) {
			throw new Error("Template not found");
		}

		// Validate template scope matches context
		if (template.scope === "ORGANIZATION") {
			// Organization templates can only be used within the same organization
			if (!organizationId || template.organizationId !== organizationId) {
				throw new Error(
					"This template belongs to a different organization",
				);
			}
		} else if (template.scope === "USER") {
			// User templates can only be used by the owner in personal context
			if (organizationId || template.userId !== context.user.id) {
				throw new Error(
					"This template is personal and cannot be used in this context",
				);
			}
		}
		// SYSTEM templates can be used by anyone

		// Validate workspace access if workspaceIds provided
		if (input.workspaceIds && input.workspaceIds.length > 0) {
			for (const workspaceId of input.workspaceIds) {
				const hasAccess = await hasWorkspaceAccess(
					workspaceId,
					context.user.id,
					organizationId ?? undefined,
				);
				if (!hasAccess) {
					throw new Error(
						`You don't have access to workspace ${workspaceId}`,
					);
				}
			}
		}

		// Validate integration connections - ensures user has access to referenced integrations
		// This prevents storing invalid references that would fail at runtime
		const connectionValidation = await validateAllConnections(
			input.knowledgeConnections,
			input.toolConnections,
			context.user.id,
			organizationId ?? undefined,
		);

		if (!connectionValidation.valid) {
			throw new Error(
				`Invalid integration connections: ${connectionValidation.errors.join("; ")}`,
			);
		}

		// Databricks Vector Search requires an explicit index selection - a
		// bare connection with no chosen indexes can't be queried at runtime.
		if (
			input.knowledgeConnections?.DATABRICKS_VECTOR_SEARCH &&
			!input.knowledgeResources?.DATABRICKS_VECTOR_SEARCH?.indexes?.length
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Select at least one Databricks vector index for this agent",
			});
		}

		const instance = await createAgentTemplateInstance({
			templateId: input.templateId,
			userId: context.user.id,
			organizationId: organizationId ?? undefined,
			name: input.name,
			description: input.description,
			heroEmojis: input.heroEmojis,
			heroImageUrl: input.heroImageUrl,
			customInstructions: input.customInstructions as
				| Prisma.InputJsonValue
				| undefined,
			knowledgeConnections: input.knowledgeConnections as
				| Prisma.InputJsonValue
				| undefined,
			knowledgeResources: input.knowledgeResources ?? undefined,
			toolConnections: input.toolConnections as
				| Prisma.InputJsonValue
				| undefined,
			triggers: input.triggers as Prisma.InputJsonValue | undefined,
			modelOverride: input.modelOverride,
			modelConfig: input.modelConfig as Prisma.InputJsonValue | undefined,
			workspaceIds: input.workspaceIds,
			// Goal-oriented execution fields
			executionMode: input.executionMode,
			goal: input.goal,
			successCriteria: input.successCriteria as
				| Prisma.InputJsonValue
				| undefined,
			maxIterations: input.maxIterations,
		});

		// Initialize agent memory from template (AGENTS.md, mcp.json)
		// This runs asynchronously and failures don't block instance creation
		try {
			await initializeMemoryFromTemplate({
				agentInstanceId: instance.id,
				templateId: input.templateId,
				userId: context.user.id,
				organizationId: organizationId ?? undefined,
			});
		} catch (error) {
			// Log but don't fail - memory can be initialized later
			console.warn(
				`[AgentTemplates] Failed to initialize memory for instance ${instance.id}:`,
				error instanceof Error ? error.message : error,
			);
		}

		// Materialize additional skills from catalog (beyond template skills)
		if (input.additionalSkillIds && input.additionalSkillIds.length > 0) {
			try {
				// Get existing skill memory files to avoid duplicates
				const existingSkillFiles = await db.agentMemoryFile.findMany({
					where: {
						agentInstanceId: instance.id,
						fileType: "SKILL",
						sourceSkillId: { not: null },
					},
					select: { sourceSkillId: true },
				});
				const existingSourceIds = new Set(
					existingSkillFiles.map((f) => f.sourceSkillId),
				);

				// Fetch requested skills with tenant visibility check
				// Only allow SYSTEM skills + skills owned by the caller's context
				const skillVisibility: Prisma.SkillWhereInput[] = [
					{ scope: "SYSTEM" },
				];
				if (organizationId) {
					skillVisibility.push({
						scope: "ORGANIZATION",
						organizationId,
					});
				} else {
					skillVisibility.push({
						scope: "USER",
						userId: context.user.id,
					});
				}
				const skills = await db.skill.findMany({
					where: {
						id: { in: input.additionalSkillIds },
						isPublished: true,
						OR: skillVisibility,
					},
				});

				const memCtx = {
					agentInstanceId: instance.id,
					userId: context.user.id,
					organizationId: organizationId ?? undefined,
				};

				for (const skill of skills) {
					if (existingSourceIds.has(skill.id)) {
						continue;
					}
					const skillPath = `skills/${skill.slug}/SKILL.md`;
					await writeMemoryFile(
						memCtx,
						skillPath,
						skill.content,
						"system",
						{ isEnabled: true, sourceSkillId: skill.id },
					);
				}
			} catch (error) {
				console.warn(
					`[AgentTemplates] Failed to materialize additional skills for instance ${instance.id}:`,
					error instanceof Error ? error.message : error,
				);
			}
		}

		if (input.triggers !== undefined) {
			try {
				await syncDeploymentTriggers({
					instanceId: instance.id,
					userId: context.user.id,
					organizationId: organizationId ?? null,
				});
			} catch (error) {
				console.error(
					"[createInstance] Failed to sync deployment triggers",
					{ instanceId: instance.id, error },
				);
			}
		}

		return { instance };
	});
