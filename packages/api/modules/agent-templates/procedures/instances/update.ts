import { ORPCError } from "@orpc/server";
import type { AgentInstanceStatus } from "@repo/database";
import {
	archiveInstanceVersion,
	getAgentTemplateInstance,
	hasWorkspaceAccess,
	restoreInstanceVersion,
	updateAgentTemplateInstance,
} from "@repo/database";
import type { Prisma } from "@repo/database/prisma/generated/client";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
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

const optionalTrimmedText = (field: string, max: number) =>
	z.string().trim().min(1, `${field} is required`).max(max).optional();

const customInstructionsSchema = z
	.object({
		role: z.string().trim().optional(),
		additionalContext: z.string().trim().optional(),
		constraints: z.string().trim().optional(),
	})
	.passthrough()
	.refine(
		(value) =>
			value.role !== undefined ||
			value.additionalContext !== undefined ||
			value.constraints !== undefined,
		{
			message: "Instructions are required",
		},
	)
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
	)
	.optional();

const agentInstanceStatusSchema = z.enum([
	"DRAFT",
	"PENDING",
	"ACTIVE",
	"ARCHIVED",
]);

const updateInputSchema = z
	.object({
		id: z.string(),
		name: optionalTrimmedText("Name", 200),
		description: optionalTrimmedText("Description", 500),
		heroEmojis: z.array(z.string()).optional(),
		heroImageUrl: z.string().url().nullable().optional(),
		customInstructions: customInstructionsSchema,
		knowledgeConnections: knowledgeConnectionsSchema,
		knowledgeResources: knowledgeResourcesSchema,
		toolConnections: toolConnectionsSchema,
		triggers: z.any().optional(),
		modelOverride: z.string().optional(),
		modelConfig: z.any().optional(),
		workspaceIds: z.array(z.string()).optional(),
		/** @deprecated Use status instead */
		isActive: z.boolean().optional(),
		// New versioning fields
		status: agentInstanceStatusSchema.optional(),
		// Goal-oriented fields
		executionMode: z.enum(["single_turn", "goal_oriented"]).optional(),
		goal: z.string().trim().optional(),
		successCriteria: z.any().optional(),
		maxIterations: z.number().min(1).max(50).optional(),
		// External API exposure
		isApiExposed: z.boolean().optional(),
		apiConfig: z.any().optional(),
		/**
		 * If true, creates a new version instead of updating in place.
		 * The old version will be archived, and a new version with incremented
		 * version number will be created with the updates applied.
		 */
		createNewVersion: z.boolean().default(false),
	})
	.refine(
		(data) => {
			if (data.executionMode === "goal_oriented") {
				return !!data.goal?.trim();
			}
			return true;
		},
		{
			message: "Goal is required when execution mode is 'goal_oriented'",
			path: ["goal"],
		},
	);

export const updateInstanceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_MANAGE))
	.input(updateInputSchema)
	.handler(async ({ input, context }) => {
		// Verify ownership or org membership
		const existing = await getAgentTemplateInstance(input.id);
		if (!existing) {
			throw new Error("Instance not found");
		}

		const isOwner = existing.userId === context.user.id;
		let isOrgMember = false;

		if (existing.organizationId) {
			const membership = await verifyOrganizationMembership(
				existing.organizationId,
				context.user.id,
			);
			isOrgMember = !!membership;
		}

		if (!isOwner && !isOrgMember) {
			throw new Error(
				"You don't have permission to update this instance",
			);
		}

		// Validate workspace access if workspaceIds provided
		if (input.workspaceIds && input.workspaceIds.length > 0) {
			for (const workspaceId of input.workspaceIds) {
				const hasAccess = await hasWorkspaceAccess(
					workspaceId,
					context.user.id,
					existing.organizationId ?? undefined,
				);
				if (!hasAccess) {
					throw new Error(
						`You don't have access to workspace ${workspaceId}`,
					);
				}
			}
		}

		// Validate integration connections if provided - ensures user has access to referenced integrations
		// This prevents storing invalid references that would fail at runtime
		if (
			input.knowledgeConnections !== undefined ||
			input.toolConnections !== undefined
		) {
			const connectionValidation = await validateAllConnections(
				input.knowledgeConnections,
				input.toolConnections,
				context.user.id,
				existing.organizationId ?? undefined,
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
				!input.knowledgeResources?.DATABRICKS_VECTOR_SEARCH?.indexes
					?.length
			) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Select at least one Databricks vector index for this agent",
				});
			}
		}

		const instance = await updateAgentTemplateInstance({
			id: input.id,
			// Required for OAuth lookup when resolving knowledgeConnections
			userId: context.user.id,
			organizationId: existing.organizationId ?? undefined,
			name: input.name,
			description: input.description,
			heroEmojis: input.heroEmojis,
			heroImageUrl: input.heroImageUrl ?? undefined,
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
			status: input.status as AgentInstanceStatus | undefined,
			// Goal-oriented fields
			executionMode: input.executionMode,
			goal: input.goal,
			successCriteria: input.successCriteria as
				| Prisma.InputJsonValue
				| undefined,
			maxIterations: input.maxIterations,
			// External API exposure
			isApiExposed: input.isApiExposed,
			apiConfig: input.apiConfig as Prisma.InputJsonValue | undefined,
			// Versioning
			createNewVersion: input.createNewVersion,
		});

		if (input.triggers !== undefined) {
			try {
				await syncDeploymentTriggers({
					instanceId: instance.id,
					userId: context.user.id,
					organizationId: existing.organizationId,
				});
			} catch (error) {
				console.error(
					"[updateInstance] Failed to sync deployment triggers",
					{ instanceId: instance.id, error },
				);
			}
		}

		return { instance };
	});

// Archive an instance version
const archiveInputSchema = z.object({
	id: z.string(),
});

export const archiveInstanceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_MANAGE))
	.input(archiveInputSchema)
	.handler(async ({ input, context }) => {
		const existing = await getAgentTemplateInstance(input.id);
		if (!existing) {
			throw new Error("Instance not found");
		}

		// Verify ownership or org membership
		const isOwner = existing.userId === context.user.id;
		let isOrgMember = false;

		if (existing.organizationId) {
			const membership = await verifyOrganizationMembership(
				existing.organizationId,
				context.user.id,
			);
			isOrgMember = !!membership;
		}

		if (!isOwner && !isOrgMember) {
			throw new Error(
				"You don't have permission to archive this instance",
			);
		}

		const instance = await archiveInstanceVersion(input.id);
		return { instance };
	});

// Restore an archived version (creates a new version from the archived one)
const restoreInputSchema = z.object({
	id: z.string(),
});

export const restoreInstanceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_MANAGE))
	.input(restoreInputSchema)
	.handler(async ({ input, context }) => {
		const existing = await getAgentTemplateInstance(input.id);
		if (!existing) {
			throw new Error("Instance not found");
		}

		// Verify ownership or org membership
		const isOwner = existing.userId === context.user.id;
		let isOrgMember = false;

		if (existing.organizationId) {
			const membership = await verifyOrganizationMembership(
				existing.organizationId,
				context.user.id,
			);
			isOrgMember = !!membership;
		}

		if (!isOwner && !isOrgMember) {
			throw new Error(
				"You don't have permission to restore this instance",
			);
		}

		if (existing.status !== "ARCHIVED") {
			throw new Error("Can only restore archived versions");
		}

		const instance = await restoreInstanceVersion(input.id);
		return { instance };
	});
