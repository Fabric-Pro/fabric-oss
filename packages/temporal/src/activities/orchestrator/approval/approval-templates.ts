/**
 * Approval Templates
 *
 * Phase 3.3: Pre-approved patterns for common operations.
 * Allows users to define templates that auto-approve matching operations.
 */

import { logger } from "@repo/logs";

// =============================================================================
// Types
// =============================================================================

export interface ApprovalTemplate {
	id: string;
	name: string;
	description: string;

	// Matching criteria
	criteria: {
		agentPattern?: string; // Regex for agent IDs
		operationPattern?: string; // Regex for operations
		resourcePattern?: string; // Regex for targets
		stepDescriptionPattern?: string; // Regex for step descriptions
		maxRiskLevel: "low" | "medium" | "high" | "critical";
		executorTypes?: string[]; // e.g., ["agent", "mcp_tool"]
	};

	// Template behavior
	behavior: {
		autoApprove: boolean;
		notifyOnly: boolean; // Show notification but don't require action
		requireConfirmation: boolean; // Quick confirm vs detailed review
		expiresAfter?: number; // Auto-expire after N uses (0 = never)
		validUntil?: Date; // Time-based expiration
	};

	// Scope
	scope: "USER" | "ORGANIZATION" | "SYSTEM";
	userId?: string;
	organizationId?: string;

	// Audit
	usageCount: number;
	lastUsed?: Date;
	createdBy: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface TemplateMatchResult {
	matched: boolean;
	template?: ApprovalTemplate;
	matchedCriteria?: string[];
	autoApprove: boolean;
	notifyOnly: boolean;
	reason: string;
}

export interface CreateTemplateInput {
	name: string;
	description: string;
	criteria: ApprovalTemplate["criteria"];
	behavior: ApprovalTemplate["behavior"];
	scope: ApprovalTemplate["scope"];
	userId?: string;
	organizationId?: string;
	createdBy: string;
}

export interface StepToMatch {
	stepId: string;
	description: string;
	executor?: string;
	executorType?: "agent" | "mcp_tool" | "workflow";
	operation?: string;
	resource?: string;
	riskLevel: "low" | "medium" | "high" | "critical";
}

// =============================================================================
// Template Store (In-Memory)
// =============================================================================

/**
 * In-memory template store.
 * In production, this would be backed by database.
 */
class ApprovalTemplateStore {
	private templates: Map<string, ApprovalTemplate> = new Map();
	private templateIdCounter = 0;

	/**
	 * Create a new approval template.
	 */
	create(input: CreateTemplateInput): ApprovalTemplate {
		const id = `template-${++this.templateIdCounter}`;
		const now = new Date();

		const template: ApprovalTemplate = {
			id,
			name: input.name,
			description: input.description,
			criteria: input.criteria,
			behavior: input.behavior,
			scope: input.scope,
			userId: input.userId,
			organizationId: input.organizationId,
			usageCount: 0,
			createdBy: input.createdBy,
			createdAt: now,
			updatedAt: now,
		};

		this.templates.set(id, template);
		logger.info("[ApprovalTemplates] Created template", {
			id,
			name: input.name,
		});

		return template;
	}

	/**
	 * Get a template by ID.
	 */
	get(id: string): ApprovalTemplate | undefined {
		return this.templates.get(id);
	}

	/**
	 * Update a template.
	 */
	update(
		id: string,
		updates: Partial<
			Omit<ApprovalTemplate, "id" | "createdAt" | "createdBy">
		>,
	): ApprovalTemplate | undefined {
		const template = this.templates.get(id);
		if (!template) {
			return undefined;
		}

		Object.assign(template, updates, { updatedAt: new Date() });
		return template;
	}

	/**
	 * Delete a template.
	 */
	delete(id: string): boolean {
		return this.templates.delete(id);
	}

	/**
	 * List templates for a user/organization.
	 */
	list(filter?: {
		userId?: string;
		organizationId?: string;
		scope?: ApprovalTemplate["scope"];
	}): ApprovalTemplate[] {
		let results = Array.from(this.templates.values());

		if (filter?.scope) {
			results = results.filter((t) => t.scope === filter.scope);
		}
		if (filter?.userId) {
			results = results.filter(
				(t) => t.userId === filter.userId || t.scope === "SYSTEM",
			);
		}
		if (filter?.organizationId) {
			results = results.filter(
				(t) =>
					t.organizationId === filter.organizationId ||
					t.scope === "SYSTEM",
			);
		}

		return results;
	}

	/**
	 * Record template usage.
	 */
	recordUsage(id: string): void {
		const template = this.templates.get(id);
		if (template) {
			template.usageCount++;
			template.lastUsed = new Date();

			// Check if template should expire
			if (
				template.behavior.expiresAfter &&
				template.usageCount >= template.behavior.expiresAfter
			) {
				logger.info(
					"[ApprovalTemplates] Template expired due to usage limit",
					{
						id,
						usageCount: template.usageCount,
					},
				);
				this.templates.delete(id);
			}
		}
	}

	/**
	 * Clear all templates (for testing).
	 */
	clear(): void {
		this.templates.clear();
		this.templateIdCounter = 0;
	}
}

export const approvalTemplateStore = new ApprovalTemplateStore();

// =============================================================================
// Template Matcher
// =============================================================================

const RISK_LEVELS: Record<string, number> = {
	low: 1,
	medium: 2,
	high: 3,
	critical: 4,
};

/**
 * Match a step against approval templates.
 */
export function matchApprovalTemplate(
	step: StepToMatch,
	userId?: string,
	organizationId?: string,
): TemplateMatchResult {
	// Get applicable templates (user's templates, org templates, system templates)
	const templates = approvalTemplateStore.list({ userId, organizationId });

	// Sort by specificity (more specific criteria = higher priority)
	const sortedTemplates = templates.sort((a, b) => {
		const aSpecificity = countCriteria(a.criteria);
		const bSpecificity = countCriteria(b.criteria);
		return bSpecificity - aSpecificity;
	});

	for (const template of sortedTemplates) {
		// Check if template is still valid
		if (
			template.behavior.validUntil &&
			new Date() > template.behavior.validUntil
		) {
			continue;
		}

		const matchResult = matchesTemplate(step, template);
		if (matchResult.matched) {
			// Record usage
			approvalTemplateStore.recordUsage(template.id);

			return {
				matched: true,
				template,
				matchedCriteria: matchResult.matchedCriteria,
				autoApprove: template.behavior.autoApprove,
				notifyOnly: template.behavior.notifyOnly,
				reason: `Matched template: ${template.name}`,
			};
		}
	}

	return {
		matched: false,
		autoApprove: false,
		notifyOnly: false,
		reason: "No matching template found",
	};
}

/**
 * Check if a step matches a template's criteria.
 */
function matchesTemplate(
	step: StepToMatch,
	template: ApprovalTemplate,
): { matched: boolean; matchedCriteria: string[] } {
	const matchedCriteria: string[] = [];
	const criteria = template.criteria;

	// Check risk level first (must be at or below max)
	const stepRisk = RISK_LEVELS[step.riskLevel] || 1;
	const maxRisk = RISK_LEVELS[criteria.maxRiskLevel] || 4;
	if (stepRisk > maxRisk) {
		return { matched: false, matchedCriteria: [] };
	}
	matchedCriteria.push(
		`riskLevel:${step.riskLevel}<=max:${criteria.maxRiskLevel}`,
	);

	// Check agent pattern
	if (criteria.agentPattern && step.executor) {
		try {
			const regex = new RegExp(criteria.agentPattern, "i");
			if (!regex.test(step.executor)) {
				return { matched: false, matchedCriteria: [] };
			}
			matchedCriteria.push(`agent:${criteria.agentPattern}`);
		} catch {
			// Invalid regex, skip this criterion
		}
	}

	// Check operation pattern
	if (criteria.operationPattern && step.operation) {
		try {
			const regex = new RegExp(criteria.operationPattern, "i");
			if (!regex.test(step.operation)) {
				return { matched: false, matchedCriteria: [] };
			}
			matchedCriteria.push(`operation:${criteria.operationPattern}`);
		} catch {
			// Invalid regex
		}
	}

	// Check resource pattern
	if (criteria.resourcePattern && step.resource) {
		try {
			const regex = new RegExp(criteria.resourcePattern, "i");
			if (!regex.test(step.resource)) {
				return { matched: false, matchedCriteria: [] };
			}
			matchedCriteria.push(`resource:${criteria.resourcePattern}`);
		} catch {
			// Invalid regex
		}
	}

	// Check step description pattern
	if (criteria.stepDescriptionPattern) {
		try {
			const regex = new RegExp(criteria.stepDescriptionPattern, "i");
			if (!regex.test(step.description)) {
				return { matched: false, matchedCriteria: [] };
			}
			matchedCriteria.push(
				`description:${criteria.stepDescriptionPattern}`,
			);
		} catch {
			// Invalid regex
		}
	}

	// Check executor types
	if (
		criteria.executorTypes &&
		criteria.executorTypes.length > 0 &&
		step.executorType
	) {
		if (!criteria.executorTypes.includes(step.executorType)) {
			return { matched: false, matchedCriteria: [] };
		}
		matchedCriteria.push(`executorType:${step.executorType}`);
	}

	return { matched: true, matchedCriteria };
}

/**
 * Count the number of non-empty criteria in a template.
 */
function countCriteria(criteria: ApprovalTemplate["criteria"]): number {
	let count = 0;
	if (criteria.agentPattern) {
		count++;
	}
	if (criteria.operationPattern) {
		count++;
	}
	if (criteria.resourcePattern) {
		count++;
	}
	if (criteria.stepDescriptionPattern) {
		count++;
	}
	if (criteria.executorTypes && criteria.executorTypes.length > 0) {
		count++;
	}
	return count;
}

// =============================================================================
// Template Suggestions
// =============================================================================

export interface TemplateSuggestion {
	name: string;
	description: string;
	criteria: ApprovalTemplate["criteria"];
	behavior: ApprovalTemplate["behavior"];
	reason: string;
}

/**
 * Suggest templates based on approval history.
 */
export function suggestTemplates(
	approvalHistory: Array<{
		step: StepToMatch;
		approved: boolean;
		timestamp: Date;
	}>,
): TemplateSuggestion[] {
	const suggestions: TemplateSuggestion[] = [];

	// Find patterns in approved operations
	const approvedSteps = approvalHistory.filter((h) => h.approved);

	// Group by executor
	const byExecutor = new Map<string, typeof approvedSteps>();
	for (const item of approvedSteps) {
		if (item.step.executor) {
			const existing = byExecutor.get(item.step.executor) || [];
			existing.push(item);
			byExecutor.set(item.step.executor, existing);
		}
	}

	// Suggest templates for frequently approved executors
	for (const [executor, steps] of byExecutor) {
		if (steps.length >= 3) {
			// At least 3 approvals
			const maxRisk = steps.reduce(
				(max, s) => {
					const risk = RISK_LEVELS[s.step.riskLevel] || 1;
					return risk > (RISK_LEVELS[max] || 1)
						? s.step.riskLevel
						: max;
				},
				"low" as "low" | "medium" | "high" | "critical",
			);

			suggestions.push({
				name: `Auto-approve ${executor}`,
				description: `Automatically approve operations from ${executor} (based on ${steps.length} previous approvals)`,
				criteria: {
					agentPattern: `^${escapeRegex(executor)}$`,
					maxRiskLevel: maxRisk,
				},
				behavior: {
					autoApprove: true,
					notifyOnly: false,
					requireConfirmation: false,
				},
				reason: `You've approved ${steps.length} operations from this executor`,
			});
		}
	}

	// Group by operation type
	const byOperation = new Map<string, typeof approvedSteps>();
	for (const item of approvedSteps) {
		if (item.step.operation) {
			const existing = byOperation.get(item.step.operation) || [];
			existing.push(item);
			byOperation.set(item.step.operation, existing);
		}
	}

	// Suggest templates for frequently approved operations
	for (const [operation, steps] of byOperation) {
		if (steps.length >= 5) {
			suggestions.push({
				name: `Auto-approve ${operation} operations`,
				description: `Automatically approve ${operation} operations`,
				criteria: {
					operationPattern: `^${escapeRegex(operation)}$`,
					maxRiskLevel: "medium",
				},
				behavior: {
					autoApprove: true,
					notifyOnly: false,
					requireConfirmation: false,
				},
				reason: `You've approved ${steps.length} ${operation} operations`,
			});
		}
	}

	return suggestions;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =============================================================================
// Activity Functions
// =============================================================================

/**
 * Create an approval template.
 */
export async function createApprovalTemplateActivity(
	input: CreateTemplateInput,
): Promise<ApprovalTemplate> {
	return approvalTemplateStore.create(input);
}

/**
 * Match a step against approval templates.
 */
export async function matchApprovalTemplateActivity(
	step: StepToMatch,
	userId?: string,
	organizationId?: string,
): Promise<TemplateMatchResult> {
	return matchApprovalTemplate(step, userId, organizationId);
}

/**
 * List approval templates.
 */
export async function listApprovalTemplatesActivity(filter?: {
	userId?: string;
	organizationId?: string;
	scope?: ApprovalTemplate["scope"];
}): Promise<ApprovalTemplate[]> {
	return approvalTemplateStore.list(filter);
}

/**
 * Delete an approval template.
 */
export async function deleteApprovalTemplateActivity(
	id: string,
): Promise<boolean> {
	return approvalTemplateStore.delete(id);
}

/**
 * Suggest templates based on history.
 */
export async function suggestApprovalTemplatesActivity(
	approvalHistory: Array<{
		step: StepToMatch;
		approved: boolean;
		timestamp: Date;
	}>,
): Promise<TemplateSuggestion[]> {
	return suggestTemplates(approvalHistory);
}
