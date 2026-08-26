/**
 * Approval Template Queries
 *
 * Database queries for managing approval templates that enable auto-approval
 * of orchestrator operations based on user-defined patterns.
 */

import { db } from "../client";
import type { ApprovalTemplate } from "../generated/client";

export interface ApprovalTemplateCriteria {
	agentPattern?: string;
	operationPattern?: string;
	resourcePattern?: string;
	stepDescriptionPattern?: string;
	maxRiskLevel?: "low" | "medium" | "high" | "critical";
	executorTypes?: string[];
}

export interface ApprovalTemplateBehavior {
	autoApprove: boolean;
	notifyOnly?: boolean;
	requireConfirmation?: boolean;
	expiresAfter?: number; // Hours
	validUntil?: string; // ISO date
}

export interface CreateApprovalTemplateInput {
	name: string;
	description?: string;
	criteria: ApprovalTemplateCriteria;
	behavior: ApprovalTemplateBehavior;
	scope?: "USER" | "ORGANIZATION" | "SYSTEM";
	userId?: string;
	organizationId?: string;
}

export interface ApprovalTemplateWithParsedData extends ApprovalTemplate {
	parsedCriteria: ApprovalTemplateCriteria;
	parsedBehavior: ApprovalTemplateBehavior;
}

/**
 * Create a new approval template
 */
export async function createApprovalTemplate(
	input: CreateApprovalTemplateInput,
): Promise<ApprovalTemplate> {
	const template = await db.approvalTemplate.create({
		data: {
			name: input.name,
			description: input.description,
			criteria: input.criteria as any,
			behavior: input.behavior as any,
			scope: input.scope ?? "USER",
			userId: input.userId,
			organizationId: input.organizationId,
			usageCount: 0,
			isActive: true,
		},
	});

	return template;
}

/**
 * Get approval template by ID with tenant isolation
 */
export async function getApprovalTemplateById(
	id: string,
	tenantContext?: { userId: string; organizationId?: string },
): Promise<ApprovalTemplate | null> {
	const template = await db.approvalTemplate.findUnique({
		where: { id },
	});
	if (!template) {
		return null;
	}
	if (tenantContext) {
		if (template.scope === "SYSTEM") {
			return template;
		}
		if (
			tenantContext.organizationId &&
			template.organizationId === tenantContext.organizationId
		) {
			return template;
		}
		if (
			!tenantContext.organizationId &&
			template.userId === tenantContext.userId &&
			!template.organizationId
		) {
			return template;
		}
		return null;
	}
	return template;
}

/**
 * List approval templates for a user or organization
 */
export async function listApprovalTemplates({
	userId,
	organizationId,
	scope,
	isActive,
}: {
	userId?: string;
	organizationId?: string | null;
	scope?: "USER" | "ORGANIZATION" | "SYSTEM";
	isActive?: boolean;
}): Promise<ApprovalTemplate[]> {
	const where: any = {};

	// SECURITY (SOC 2 CC6.1): ALWAYS constrain to the caller's tenant set
	// (SYSTEM + their org, or SYSTEM + their personal scope). A caller-supplied
	// `scope` narrows WITHIN that set as an AND filter — it must never REPLACE
	// the tenant filter. The previous `if (scope) { where.scope = scope }`
	// branch dropped the tenant filter entirely, returning every org's/user's
	// templates globally.
	if (userId || organizationId) {
		where.OR = [
			{ scope: "SYSTEM" },
			...(organizationId
				? [{ organizationId, scope: "ORGANIZATION" }]
				: userId
					? [{ userId, organizationId: null, scope: "USER" }]
					: []),
		];
	}
	if (scope) {
		where.scope = scope;
	}

	if (isActive !== undefined) {
		where.isActive = isActive;
	}

	return await db.approvalTemplate.findMany({
		where,
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Get active approval templates that could match an operation
 * This is used by the orchestrator to check for auto-approval
 */
export async function getActiveApprovalTemplatesForContext({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId?: string | null;
}): Promise<ApprovalTemplate[]> {
	return await db.approvalTemplate.findMany({
		where: {
			isActive: true,
			OR: [
				{ scope: "SYSTEM" },
				...(organizationId
					? [{ organizationId, scope: "ORGANIZATION" }]
					: [{ userId, organizationId: null, scope: "USER" }]),
			],
		},
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Update an approval template
 */
export async function updateApprovalTemplate(
	id: string,
	updates: Partial<{
		name: string;
		description: string;
		criteria: ApprovalTemplateCriteria;
		behavior: ApprovalTemplateBehavior;
		isActive: boolean;
	}>,
	tenantContext?: { userId: string; organizationId?: string },
): Promise<ApprovalTemplate | null> {
	try {
		// Verify ownership before updating
		if (tenantContext) {
			const existing = await getApprovalTemplateById(id, tenantContext);
			if (!existing || existing.scope === "SYSTEM") {
				return null;
			}
		}
		return await db.approvalTemplate.update({
			where: { id },
			data: {
				...(updates.name !== undefined && { name: updates.name }),
				...(updates.description !== undefined && {
					description: updates.description,
				}),
				...(updates.criteria !== undefined && {
					criteria: updates.criteria as any,
				}),
				...(updates.behavior !== undefined && {
					behavior: updates.behavior as any,
				}),
				...(updates.isActive !== undefined && {
					isActive: updates.isActive,
				}),
			},
		});
	} catch {
		return null;
	}
}

/**
 * Delete an approval template
 */
export async function deleteApprovalTemplate(
	id: string,
	tenantContext?: { userId: string; organizationId?: string },
): Promise<boolean> {
	try {
		// Verify ownership before deleting
		if (tenantContext) {
			const existing = await getApprovalTemplateById(id, tenantContext);
			if (!existing || existing.scope === "SYSTEM") {
				return false;
			}
		}
		await db.approvalTemplate.delete({
			where: { id },
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Increment usage count for a template
 */
export async function incrementApprovalTemplateUsage(
	id: string,
): Promise<void> {
	await db.approvalTemplate.update({
		where: { id },
		data: {
			usageCount: { increment: 1 },
			lastUsed: new Date(),
		},
	});
}

/**
 * Check if an operation matches an approval template
 * This is the core matching logic used by the orchestrator
 */
export function matchesApprovalTemplate({
	template,
	agentId,
	operation,
	resource,
	stepDescription,
	riskLevel,
	executorType,
}: {
	template: ApprovalTemplate;
	agentId?: string;
	operation?: string;
	resource?: string;
	stepDescription?: string;
	riskLevel?: string;
	executorType?: string;
}): boolean {
	const criteria = template.criteria as unknown as ApprovalTemplateCriteria;

	// Check risk level threshold
	if (criteria.maxRiskLevel && riskLevel) {
		const riskLevels = ["low", "medium", "high", "critical"];
		const templateRiskIndex = riskLevels.indexOf(criteria.maxRiskLevel);
		const operationRiskIndex = riskLevels.indexOf(riskLevel);

		if (operationRiskIndex > templateRiskIndex) {
			return false; // Operation risk exceeds template threshold
		}
	}

	// Check agent pattern
	if (criteria.agentPattern && agentId) {
		const regex = new RegExp(criteria.agentPattern, "i");
		if (!regex.test(agentId)) {
			return false;
		}
	}

	// Check operation pattern
	if (criteria.operationPattern && operation) {
		const regex = new RegExp(criteria.operationPattern, "i");
		if (!regex.test(operation)) {
			return false;
		}
	}

	// Check resource pattern
	if (criteria.resourcePattern && resource) {
		const regex = new RegExp(criteria.resourcePattern, "i");
		if (!regex.test(resource)) {
			return false;
		}
	}

	// Check step description pattern
	if (criteria.stepDescriptionPattern && stepDescription) {
		const regex = new RegExp(criteria.stepDescriptionPattern, "i");
		if (!regex.test(stepDescription)) {
			return false;
		}
	}

	// Check executor types
	if (criteria.executorTypes && executorType) {
		if (!criteria.executorTypes.includes(executorType)) {
			return false;
		}
	}

	return true;
}

/**
 * Find the best matching approval template for an operation
 */
export function findMatchingApprovalTemplate({
	templates,
	agentId,
	operation,
	resource,
	stepDescription,
	riskLevel,
	executorType,
}: {
	templates: ApprovalTemplate[];
	agentId?: string;
	operation?: string;
	resource?: string;
	stepDescription?: string;
	riskLevel?: string;
	executorType?: string;
}): ApprovalTemplate | null {
	for (const template of templates) {
		if (
			matchesApprovalTemplate({
				template,
				agentId,
				operation,
				resource,
				stepDescription,
				riskLevel,
				executorType,
			})
		) {
			return template;
		}
	}
	return null;
}
