/**
 * Approval Templates API Procedures
 *
 * CRUD operations for approval template management.
 * Enables users to define patterns for auto-approving operations.
 *
 * Uses in-memory storage. For production, migrate to database after
 * running Prisma migration for the ApprovalTemplate model.
 */

import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

// =============================================================================
// In-Memory Storage
// =============================================================================

interface StoredTemplate {
	id: string;
	name: string;
	description: string | null;
	criteria: Record<string, unknown>;
	behavior: Record<string, unknown>;
	scope: string;
	userId: string | null;
	organizationId: string | null;
	usageCount: number;
	lastUsed: Date | null;
	isActive: boolean;
	createdAt: Date;
	updatedAt: Date;
}

const templateStore = new Map<string, StoredTemplate>();
let templateIdCounter = 0;

// =============================================================================
// Schemas
// =============================================================================

const ApprovalCriteriaSchema = z.object({
	agentPattern: z.string().optional(),
	operationPattern: z.string().optional(),
	resourcePattern: z.string().optional(),
	stepDescriptionPattern: z.string().optional(),
	maxRiskLevel: z.enum(["low", "medium", "high", "critical"]),
	executorTypes: z.array(z.string()).optional(),
});

const ApprovalBehaviorSchema = z.object({
	autoApprove: z.boolean(),
	notifyOnly: z.boolean(),
	requireConfirmation: z.boolean(),
	expiresAfter: z.number().optional(),
	validUntil: z.string().datetime().optional(),
});

const ApprovalTemplateSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	criteria: ApprovalCriteriaSchema,
	behavior: ApprovalBehaviorSchema,
	scope: z.enum(["USER", "ORGANIZATION", "SYSTEM"]),
	userId: z.string().nullable(),
	organizationId: z.string().nullable(),
	usageCount: z.number(),
	lastUsed: z.string().datetime().nullable(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	isActive: z.boolean(),
});

// =============================================================================
// List Templates
// =============================================================================

export const listApprovalTemplates = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/orchestrator/approval-templates",
		tags: ["Orchestrator", "Approval"],
		summary: "List approval templates",
		description: "List all approval templates accessible to the user.",
	})
	.input(
		z
			.object({
				scope: z
					.enum(["USER", "ORGANIZATION", "SYSTEM", "ALL"])
					.optional(),
				organizationId: z.string().nullable().optional(),
				includeInactive: z.boolean().optional(),
			})
			.optional(),
	)
	.output(z.array(ApprovalTemplateSchema))
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input?.organizationId,
			context.session,
		);

		const templates = Array.from(templateStore.values()).filter((t) => {
			// Filter by access
			const hasAccess =
				t.userId === userId ||
				t.scope === "SYSTEM" ||
				(t.scope === "ORGANIZATION" &&
					t.organizationId === organizationId);

			if (!hasAccess) {
				return false;
			}

			// Filter by scope
			if (
				input?.scope &&
				input.scope !== "ALL" &&
				t.scope !== input.scope
			) {
				return false;
			}

			// Filter by active status
			if (!input?.includeInactive && !t.isActive) {
				return false;
			}

			return true;
		});

		return templates
			.sort((a, b) => b.usageCount - a.usageCount)
			.map((t) => ({
				id: t.id,
				name: t.name,
				description: t.description || "",
				criteria: t.criteria as z.infer<typeof ApprovalCriteriaSchema>,
				behavior: t.behavior as z.infer<typeof ApprovalBehaviorSchema>,
				scope: t.scope as "USER" | "ORGANIZATION" | "SYSTEM",
				userId: t.userId,
				organizationId: t.organizationId,
				usageCount: t.usageCount,
				lastUsed: t.lastUsed?.toISOString() ?? null,
				createdAt: t.createdAt.toISOString(),
				updatedAt: t.updatedAt.toISOString(),
				isActive: t.isActive,
			}));
	});

// =============================================================================
// Get Template
// =============================================================================

export const getApprovalTemplate = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/orchestrator/approval-templates/{id}",
		tags: ["Orchestrator", "Approval"],
		summary: "Get approval template",
		description: "Get a specific approval template by ID.",
	})
	.input(z.object({ id: z.string() }))
	.output(ApprovalTemplateSchema)
	.handler(async ({ input, context }) => {
		const template = templateStore.get(input.id);

		if (!template) {
			throw new ORPCError("NOT_FOUND", {
				message: `Template '${input.id}' not found`,
			});
		}

		// Check access
		if (
			template.userId !== context.user.id &&
			template.scope !== "SYSTEM"
		) {
			throw new ORPCError("NOT_FOUND", {
				message: `Template '${input.id}' not found`,
			});
		}

		return {
			id: template.id,
			name: template.name,
			description: template.description || "",
			criteria: template.criteria as z.infer<
				typeof ApprovalCriteriaSchema
			>,
			behavior: template.behavior as z.infer<
				typeof ApprovalBehaviorSchema
			>,
			scope: template.scope as "USER" | "ORGANIZATION" | "SYSTEM",
			userId: template.userId,
			organizationId: template.organizationId,
			usageCount: template.usageCount,
			lastUsed: template.lastUsed?.toISOString() ?? null,
			createdAt: template.createdAt.toISOString(),
			updatedAt: template.updatedAt.toISOString(),
			isActive: template.isActive,
		};
	});

// =============================================================================
// Create Template
// =============================================================================

export const createApprovalTemplate = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "POST",
		path: "/orchestrator/approval-templates",
		tags: ["Orchestrator", "Approval"],
		summary: "Create approval template",
		description: "Create a new approval template.",
	})
	.input(
		z.object({
			name: z.string().min(1).max(100),
			description: z.string().max(500).optional(),
			criteria: ApprovalCriteriaSchema,
			behavior: ApprovalBehaviorSchema,
			scope: z.enum(["USER", "ORGANIZATION"]).default("USER"),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(ApprovalTemplateSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Validate regex patterns
		const regexFields = [
			"agentPattern",
			"operationPattern",
			"resourcePattern",
			"stepDescriptionPattern",
		] as const;
		for (const field of regexFields) {
			const pattern = input.criteria[field];
			if (pattern) {
				try {
					new RegExp(pattern);
				} catch {
					throw new ORPCError("BAD_REQUEST", {
						message: `Invalid regex in ${field}`,
					});
				}
			}
		}

		// Check for duplicate names
		const existing = Array.from(templateStore.values()).find(
			(t) =>
				t.name === input.name &&
				t.userId === userId &&
				t.scope === input.scope,
		);

		if (existing) {
			throw new ORPCError("CONFLICT", {
				message: `Template named '${input.name}' already exists`,
			});
		}

		const now = new Date();
		const id = `template-${++templateIdCounter}`;

		const template: StoredTemplate = {
			id,
			name: input.name,
			description: input.description || null,
			criteria: input.criteria,
			behavior: input.behavior,
			scope: input.scope,
			userId,
			organizationId:
				input.scope === "ORGANIZATION"
					? (organizationId ?? null)
					: null,
			usageCount: 0,
			lastUsed: null,
			isActive: true,
			createdAt: now,
			updatedAt: now,
		};

		templateStore.set(id, template);

		return {
			id: template.id,
			name: template.name,
			description: template.description || "",
			criteria: template.criteria as z.infer<
				typeof ApprovalCriteriaSchema
			>,
			behavior: template.behavior as z.infer<
				typeof ApprovalBehaviorSchema
			>,
			scope: template.scope as "USER" | "ORGANIZATION" | "SYSTEM",
			userId: template.userId,
			organizationId: template.organizationId,
			usageCount: template.usageCount,
			lastUsed: template.lastUsed?.toISOString() ?? null,
			createdAt: template.createdAt.toISOString(),
			updatedAt: template.updatedAt.toISOString(),
			isActive: template.isActive,
		};
	});

// =============================================================================
// Update Template
// =============================================================================

export const updateApprovalTemplate = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "PATCH",
		path: "/orchestrator/approval-templates/{id}",
		tags: ["Orchestrator", "Approval"],
		summary: "Update approval template",
		description: "Update an existing approval template.",
	})
	.input(
		z.object({
			id: z.string(),
			name: z.string().min(1).max(100).optional(),
			description: z.string().max(500).optional(),
			criteria: ApprovalCriteriaSchema.partial().optional(),
			behavior: ApprovalBehaviorSchema.partial().optional(),
			isActive: z.boolean().optional(),
		}),
	)
	.output(ApprovalTemplateSchema)
	.handler(async ({ input, context }) => {
		const template = templateStore.get(input.id);

		if (!template || template.userId !== context.user.id) {
			throw new ORPCError("NOT_FOUND", {
				message: `Template '${input.id}' not found or not owned by user`,
			});
		}

		if (template.scope === "SYSTEM") {
			throw new ORPCError("FORBIDDEN", {
				message: "Cannot modify system templates",
			});
		}

		// Apply updates
		if (input.name) {
			template.name = input.name;
		}
		if (input.description !== undefined) {
			template.description = input.description;
		}
		if (input.criteria) {
			template.criteria = { ...template.criteria, ...input.criteria };
		}
		if (input.behavior) {
			template.behavior = { ...template.behavior, ...input.behavior };
		}
		if (input.isActive !== undefined) {
			template.isActive = input.isActive;
		}
		template.updatedAt = new Date();

		return {
			id: template.id,
			name: template.name,
			description: template.description || "",
			criteria: template.criteria as z.infer<
				typeof ApprovalCriteriaSchema
			>,
			behavior: template.behavior as z.infer<
				typeof ApprovalBehaviorSchema
			>,
			scope: template.scope as "USER" | "ORGANIZATION" | "SYSTEM",
			userId: template.userId,
			organizationId: template.organizationId,
			usageCount: template.usageCount,
			lastUsed: template.lastUsed?.toISOString() ?? null,
			createdAt: template.createdAt.toISOString(),
			updatedAt: template.updatedAt.toISOString(),
			isActive: template.isActive,
		};
	});

// =============================================================================
// Delete Template
// =============================================================================

export const deleteApprovalTemplate = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "DELETE",
		path: "/orchestrator/approval-templates/{id}",
		tags: ["Orchestrator", "Approval"],
		summary: "Delete approval template",
		description: "Delete an approval template.",
	})
	.input(z.object({ id: z.string() }))
	.output(z.object({ success: z.boolean() }))
	.handler(async ({ input, context }) => {
		const template = templateStore.get(input.id);

		if (!template || template.userId !== context.user.id) {
			throw new ORPCError("NOT_FOUND", {
				message: `Template '${input.id}' not found or not owned by user`,
			});
		}

		if (template.scope === "SYSTEM") {
			throw new ORPCError("FORBIDDEN", {
				message: "Cannot delete system templates",
			});
		}

		templateStore.delete(input.id);
		return { success: true };
	});

// =============================================================================
// Test Template Match
// =============================================================================

export const testApprovalTemplateMatch = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "POST",
		path: "/orchestrator/approval-templates/test",
		tags: ["Orchestrator", "Approval"],
		summary: "Test template matching",
		description: "Test if a step would match against templates.",
	})
	.input(
		z.object({
			step: z.object({
				description: z.string(),
				executor: z.string().optional(),
				executorType: z
					.enum(["agent", "mcp_tool", "workflow"])
					.optional(),
				operation: z.string().optional(),
				resource: z.string().optional(),
				riskLevel: z.enum(["low", "medium", "high", "critical"]),
			}),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			matched: z.boolean(),
			matchedTemplate: ApprovalTemplateSchema.nullable(),
			matchedCriteria: z.array(z.string()),
			autoApprove: z.boolean(),
			notifyOnly: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Get all applicable templates
		const templates = Array.from(templateStore.values())
			.filter(
				(t) =>
					t.isActive &&
					(t.userId === userId ||
						t.scope === "SYSTEM" ||
						(t.scope === "ORGANIZATION" &&
							t.organizationId === organizationId)),
			)
			.sort((a, b) => b.usageCount - a.usageCount);

		const RISK_LEVELS: Record<string, number> = {
			low: 1,
			medium: 2,
			high: 3,
			critical: 4,
		};

		for (const template of templates) {
			const criteria = template.criteria as z.infer<
				typeof ApprovalCriteriaSchema
			>;
			const behavior = template.behavior as z.infer<
				typeof ApprovalBehaviorSchema
			>;
			const matchedCriteria: string[] = [];

			// Check risk level
			const stepRisk = RISK_LEVELS[input.step.riskLevel] || 1;
			const maxRisk = RISK_LEVELS[criteria.maxRiskLevel] || 4;
			if (stepRisk > maxRisk) {
				continue;
			}
			matchedCriteria.push(
				`riskLevel:${input.step.riskLevel}<=max:${criteria.maxRiskLevel}`,
			);

			// Check patterns
			if (criteria.agentPattern && input.step.executor) {
				try {
					if (
						!new RegExp(criteria.agentPattern, "i").test(
							input.step.executor,
						)
					) {
						continue;
					}
					matchedCriteria.push(`agent:${criteria.agentPattern}`);
				} catch {
					continue;
				}
			}

			if (criteria.operationPattern && input.step.operation) {
				try {
					if (
						!new RegExp(criteria.operationPattern, "i").test(
							input.step.operation,
						)
					) {
						continue;
					}
					matchedCriteria.push(
						`operation:${criteria.operationPattern}`,
					);
				} catch {
					continue;
				}
			}

			if (criteria.stepDescriptionPattern) {
				try {
					if (
						!new RegExp(criteria.stepDescriptionPattern, "i").test(
							input.step.description,
						)
					) {
						continue;
					}
					matchedCriteria.push(
						`description:${criteria.stepDescriptionPattern}`,
					);
				} catch {
					continue;
				}
			}

			if (criteria.executorTypes?.length && input.step.executorType) {
				if (!criteria.executorTypes.includes(input.step.executorType)) {
					continue;
				}
				matchedCriteria.push(`executorType:${input.step.executorType}`);
			}

			// Found a match - update usage
			template.usageCount++;
			template.lastUsed = new Date();

			return {
				matched: true,
				matchedTemplate: {
					id: template.id,
					name: template.name,
					description: template.description || "",
					criteria,
					behavior,
					scope: template.scope as "USER" | "ORGANIZATION" | "SYSTEM",
					userId: template.userId,
					organizationId: template.organizationId,
					usageCount: template.usageCount,
					lastUsed: template.lastUsed?.toISOString() ?? null,
					createdAt: template.createdAt.toISOString(),
					updatedAt: template.updatedAt.toISOString(),
					isActive: template.isActive,
				},
				matchedCriteria,
				autoApprove: behavior.autoApprove,
				notifyOnly: behavior.notifyOnly,
			};
		}

		return {
			matched: false,
			matchedTemplate: null,
			matchedCriteria: [],
			autoApprove: false,
			notifyOnly: false,
		};
	});
