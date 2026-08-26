/**
 * Deployment Trigger Procedures
 *
 * Manages webhook and schedule triggers for automated agent executions.
 */

import { randomBytes } from "node:crypto";
import { db, getAgentDeploymentById, type Prisma } from "@repo/database";
import { encryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

// =============================================================================
// CREATE TRIGGER
// =============================================================================

const createTriggerInputSchema = z.object({
	deploymentId: z.string(),
	organizationId: z.string().nullable().optional(),
	type: z.enum(["WEBHOOK", "SCHEDULE"]),
	config: z
		.object({
			// Webhook config. Secure-by-default (SOC 2 CC6.1): a new webhook
			// trigger requires a valid HMAC signature unless the creator
			// explicitly opts out with requireAuth:false. Existing triggers
			// (stored config without this field) are unaffected — the handler
			// reads the stored value.
			requireAuth: z.boolean().default(true),
			allowedIps: z.array(z.string()).optional(),
			maxPayloadSize: z.number().min(1).max(10485760).optional(), // 10MB max
			// Schedule config
			cronExpression: z.string().optional(),
			timezone: z.string().optional(),
			// Common
			inputTemplate: z.record(z.string(), z.unknown()).optional(),
			priority: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).optional(),
			// Metadata
			name: z.string().optional(),
			description: z.string().optional(),
		})
		.optional(),
	isActive: z.boolean().default(true),
});

function generateWebhookSecret(): string {
	return randomBytes(32).toString("hex");
}

function generateWebhookUrl(): string {
	const path = randomBytes(16).toString("hex");
	return `/api/webhooks/agent/${path}`;
}

export const createTriggerProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.input(createTriggerInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify access
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				userId,
			);
			if (!membership) {
				throw new Error("You don't have permission to create triggers");
			}
		}

		const deployment = await getAgentDeploymentById(input.deploymentId, {
			userId,
			organizationId,
		});

		if (!deployment) {
			throw new Error("Deployment not found");
		}

		// Validate schedule config
		if (input.type === "SCHEDULE") {
			if (!input.config?.cronExpression) {
				throw new Error(
					"Cron expression is required for schedule triggers",
				);
			}
			// Basic cron validation
			const cronParts = input.config.cronExpression.split(" ");
			if (cronParts.length < 5 || cronParts.length > 6) {
				throw new Error("Invalid cron expression format");
			}
		}

		// Generate webhook-specific fields
		const webhookUrl =
			input.type === "WEBHOOK" ? generateWebhookUrl() : null;
		const webhookSecret =
			input.type === "WEBHOOK" ? generateWebhookSecret() : null;

		// TENANT ISOLATION: Pass userId and organizationId for proper tenant filtering
		const trigger = await db.agentDeploymentTrigger.create({
			data: {
				deploymentId: input.deploymentId,
				type: input.type,
				config: (input.config || {}) as Prisma.InputJsonValue,
				isActive: input.isActive,
				webhookUrl,
				// Encrypted at rest (SOC 2 CC6.1); the plaintext is returned to
				// the caller once below so they can configure their sender.
				webhookSecret: webhookSecret
					? encryptApiKey(webhookSecret)
					: null,
				cronExpression:
					input.type === "SCHEDULE"
						? input.config?.cronExpression
						: null,
				timezone: input.config?.timezone || "UTC",
				userId,
				organizationId,
			},
		});

		return {
			trigger: {
				id: trigger.id,
				deploymentId: trigger.deploymentId,
				type: trigger.type,
				config: trigger.config,
				isActive: trigger.isActive,
				webhookUrl: trigger.webhookUrl,
				cronExpression: trigger.cronExpression,
				timezone: trigger.timezone,
				createdAt: trigger.createdAt,
			},
			// Only return secret on create — the plaintext local, not the
			// encrypted value now stored on the row.
			webhookSecret,
		};
	});

// =============================================================================
// LIST TRIGGERS
// =============================================================================

const listTriggersInputSchema = z.object({
	deploymentId: z.string(),
	organizationId: z.string().nullable().optional(),
	type: z.enum(["WEBHOOK", "SCHEDULE"]).optional(),
});

export const listTriggersProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.input(listTriggersInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify access
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				userId,
			);
			if (!membership) {
				throw new Error("You don't have permission to view triggers");
			}
		}

		const deployment = await getAgentDeploymentById(input.deploymentId, {
			userId,
			organizationId,
		});

		if (!deployment) {
			throw new Error("Deployment not found");
		}

		const triggers = await db.agentDeploymentTrigger.findMany({
			where: {
				deploymentId: input.deploymentId,
				...(input.type && { type: input.type }),
			},
			orderBy: { createdAt: "desc" },
		});

		return {
			triggers: triggers.map((t) => ({
				id: t.id,
				deploymentId: t.deploymentId,
				type: t.type,
				config: t.config,
				isActive: t.isActive,
				webhookUrl: t.webhookUrl,
				cronExpression: t.cronExpression,
				timezone: t.timezone,
				lastRunAt: t.lastRunAt,
				totalExecutions: t.totalExecutions,
				createdAt: t.createdAt,
			})),
		};
	});

// =============================================================================
// UPDATE TRIGGER
// =============================================================================

const updateTriggerInputSchema = z.object({
	triggerId: z.string(),
	organizationId: z.string().nullable().optional(),
	config: z
		.object({
			requireAuth: z.boolean().optional(),
			allowedIps: z.array(z.string()).optional(),
			maxPayloadSize: z.number().min(1).max(10485760).optional(),
			cronExpression: z.string().optional(),
			timezone: z.string().optional(),
			inputTemplate: z.record(z.string(), z.unknown()).optional(),
			priority: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).optional(),
			name: z.string().optional(),
			description: z.string().optional(),
		})
		.optional(),
	isActive: z.boolean().optional(),
});

export const updateTriggerProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.input(updateTriggerInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Get trigger and verify access
		const trigger = await db.agentDeploymentTrigger.findUnique({
			where: { id: input.triggerId },
			include: { deployment: true },
		});

		if (!trigger) {
			throw new Error("Trigger not found");
		}

		// Verify deployment access
		const deployment = await getAgentDeploymentById(trigger.deploymentId, {
			userId,
			organizationId,
		});

		if (!deployment) {
			throw new Error("Deployment not found or access denied");
		}

		// Validate schedule config if updating
		if (trigger.type === "SCHEDULE" && input.config?.cronExpression) {
			const cronParts = input.config.cronExpression.split(" ");
			if (cronParts.length < 5 || cronParts.length > 6) {
				throw new Error("Invalid cron expression format");
			}
		}

		const updated = await db.agentDeploymentTrigger.update({
			where: { id: input.triggerId },
			data: {
				...(input.config && {
					config: {
						...(trigger.config as object),
						...input.config,
					} as Prisma.InputJsonValue,
				}),
				...(input.isActive !== undefined && {
					isActive: input.isActive,
				}),
				...(input.config?.cronExpression && {
					cronExpression: input.config.cronExpression,
				}),
				...(input.config?.timezone && {
					timezone: input.config.timezone,
				}),
			},
		});

		return {
			trigger: {
				id: updated.id,
				type: updated.type,
				config: updated.config,
				isActive: updated.isActive,
				webhookUrl: updated.webhookUrl,
				cronExpression: updated.cronExpression,
				timezone: updated.timezone,
			},
		};
	});

// =============================================================================
// DELETE TRIGGER
// =============================================================================

const deleteTriggerInputSchema = z.object({
	triggerId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const deleteTriggerProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.input(deleteTriggerInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Get trigger and verify access
		const trigger = await db.agentDeploymentTrigger.findUnique({
			where: { id: input.triggerId },
		});

		if (!trigger) {
			throw new Error("Trigger not found");
		}

		// Verify deployment access
		const deployment = await getAgentDeploymentById(trigger.deploymentId, {
			userId,
			organizationId,
		});

		if (!deployment) {
			throw new Error("Deployment not found or access denied");
		}

		await db.agentDeploymentTrigger.delete({
			where: { id: input.triggerId },
		});

		return { success: true };
	});

// =============================================================================
// REGENERATE WEBHOOK SECRET
// =============================================================================

const regenerateSecretInputSchema = z.object({
	triggerId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const regenerateWebhookSecretProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.input(regenerateSecretInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Get trigger and verify access
		const trigger = await db.agentDeploymentTrigger.findUnique({
			where: { id: input.triggerId },
		});

		if (!trigger) {
			throw new Error("Trigger not found");
		}

		if (trigger.type !== "WEBHOOK") {
			throw new Error("Can only regenerate secret for webhook triggers");
		}

		// Verify deployment access
		const deployment = await getAgentDeploymentById(trigger.deploymentId, {
			userId,
			organizationId,
		});

		if (!deployment) {
			throw new Error("Deployment not found or access denied");
		}

		const newSecret = generateWebhookSecret();

		await db.agentDeploymentTrigger.update({
			where: { id: input.triggerId },
			data: { webhookSecret: encryptApiKey(newSecret) },
		});

		// Return the plaintext so the user can (re)configure their sender.
		return { webhookSecret: newSecret };
	});
