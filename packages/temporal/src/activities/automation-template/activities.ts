/**
 * Automation Template Activities
 *
 * Temporal activities for managing reusable automation templates.
 * Enables "Save & Reuse" functionality inspired by CUGA.
 */

import { db } from "@repo/database";
import type { Prisma } from "@repo/database/prisma/generated/client";
import type {
	CreateTemplateFromTaskInput,
	CreateTemplateInput,
	DeleteTemplateInput,
	ListTemplatesInput,
	TemplateParameter,
	TemplateStep,
	UpdateTemplateInput,
} from "./types";

// Helper to cast to Prisma InputJsonValue
function toJsonValue(value: unknown): Prisma.InputJsonValue {
	return value as Prisma.InputJsonValue;
}

// =============================================================================
// Create Template
// =============================================================================

export async function createTemplate(
	input: CreateTemplateInput,
): Promise<{ templateId: string; version: number }> {
	const template = await db.automationTemplate.create({
		data: {
			name: input.name,
			description: input.description,
			workflowSteps: toJsonValue(input.workflowSteps),
			parameters: input.parameters
				? toJsonValue(input.parameters)
				: undefined,
			sourceTaskId: input.sourceTaskId,
			userId: input.userId,
			organizationId: input.organizationId,
			isPublic: input.isPublic ?? false,
			category: input.category,
			tags: input.tags ?? [],
			version: 1,
		},
	});

	return { templateId: template.id, version: template.version };
}

// =============================================================================
// Create Template from Task
// =============================================================================

export async function createTemplateFromTask(
	input: CreateTemplateFromTaskInput,
): Promise<{ templateId: string; parameters: TemplateParameter[] }> {
	// Fetch the browser task with strict tenant isolation
	// Organization context: only tasks belonging to the org
	// Personal context: only personal tasks (organizationId is null)
	const tenantFilter = input.organizationId
		? { organizationId: input.organizationId }
		: { userId: input.userId, organizationId: null };

	const task = await db.browserTask.findFirst({
		where: {
			id: input.taskId,
			...tenantFilter,
		},
	});

	if (!task) {
		throw new Error(`Task ${input.taskId} not found or access denied`);
	}

	if (task.status !== "COMPLETED") {
		throw new Error(
			`Cannot create template from ${task.status} task. Only COMPLETED tasks can be saved.`,
		);
	}

	// Extract workflow steps from task fields (url, actions, extractors)
	const workflowSteps: TemplateStep[] = [];
	const parameters: TemplateParameter[] = [];

	// Build navigate step from task URL
	if (task.url) {
		workflowSteps.push({
			id: "step-navigate",
			type: "navigate",
			name: "Navigate to URL",
			config: { url: input.extractParameters ? "{{url}}" : task.url },
			parameterRefs: input.extractParameters ? ["url"] : [],
			onError: "stop",
			maxRetries: 3,
		});

		if (input.extractParameters) {
			parameters.push({
				name: "url",
				type: "url",
				description: "Target URL to navigate to",
				required: true,
				defaultValue: task.url,
			});
		}
	}

	// Add actions if present
	const actions = task.actions as Array<Record<string, unknown>> | null;
	if (actions?.length) {
		for (let i = 0; i < actions.length; i++) {
			const action = actions[i];
			workflowSteps.push({
				id: `step-action-${i}`,
				type: "action",
				name: `Action ${i + 1}: ${action?.type ?? "unknown"}`,
				config: action ?? {},
				onError: "stop",
				maxRetries: 3,
			});
		}
	}

	// Add extractors if present
	const extractors = task.extractors as Array<Record<string, unknown>> | null;
	if (extractors?.length) {
		workflowSteps.push({
			id: "step-extract",
			type: "extract",
			name: "Extract Content",
			config: { extractors },
			onError: "stop",
			maxRetries: 3,
		});
	}

	// Create the template
	const template = await db.automationTemplate.create({
		data: {
			name: input.name,
			description: input.description,
			workflowSteps: toJsonValue(workflowSteps),
			parameters: toJsonValue(parameters),
			sourceTaskId: input.taskId,
			userId: input.userId,
			organizationId: input.organizationId,
			isPublic: false,
			version: 1,
		},
	});

	return { templateId: template.id, parameters };
}

// =============================================================================
// Get Template
// =============================================================================

export async function getTemplate(input: {
	templateId: string;
	userId: string;
	organizationId?: string;
}): Promise<{
	id: string;
	name: string;
	description: string | null;
	workflowSteps: TemplateStep[];
	parameters: TemplateParameter[];
	version: number;
	category: string | null;
	tags: string[];
	useCount: number;
} | null> {
	// Get template with strict tenant isolation
	// Organization context: only org templates
	// Personal context: only personal templates (organizationId is null)
	const tenantFilter = input.organizationId
		? { organizationId: input.organizationId }
		: { userId: input.userId, organizationId: null };

	const template = await db.automationTemplate.findFirst({
		where: {
			id: input.templateId,
			...tenantFilter,
		},
	});

	if (!template) {
		return null;
	}

	return {
		id: template.id,
		name: template.name,
		description: template.description,
		workflowSteps: template.workflowSteps as unknown as TemplateStep[],
		parameters:
			(template.parameters as unknown as TemplateParameter[]) ?? [],
		version: template.version,
		category: template.category,
		tags: template.tags,
		useCount: template.useCount,
	};
}

// =============================================================================
// List Templates
// =============================================================================

export async function listTemplates(input: ListTemplatesInput): Promise<{
	templates: Array<{
		id: string;
		name: string;
		description: string | null;
		category: string | null;
		tags: string[];
		version: number;
		useCount: number;
		isPublic: boolean;
		createdAt: Date;
	}>;
	total: number;
}> {
	const limit = input.limit ?? 20;
	const offset = input.offset ?? 0;

	// Build where clause with strict tenant isolation
	// Organization context: show org templates (optionally include public ones within same org)
	// Personal context: show only personal templates (organizationId is null)
	const tenantFilter = input.organizationId
		? {
				organizationId: input.organizationId,
				...(input.includePublic ? {} : { isPublic: false }),
			}
		: {
				userId: input.userId,
				organizationId: null,
			};

	const where: Prisma.AutomationTemplateWhereInput = {
		...tenantFilter,
		...(input.category ? { category: input.category } : {}),
		...(input.tags?.length ? { tags: { hasSome: input.tags } } : {}),
	};

	const [templates, total] = await Promise.all([
		db.automationTemplate.findMany({
			where,
			select: {
				id: true,
				name: true,
				description: true,
				category: true,
				tags: true,
				version: true,
				useCount: true,
				isPublic: true,
				createdAt: true,
			},
			orderBy: [{ useCount: "desc" }, { createdAt: "desc" }],
			take: limit,
			skip: offset,
		}),
		db.automationTemplate.count({ where }),
	]);

	return { templates, total };
}

// =============================================================================
// Update Template
// =============================================================================

export async function updateTemplate(
	input: UpdateTemplateInput,
): Promise<{ templateId: string; version: number }> {
	// Verify ownership with strict tenant isolation
	// Organization context: only update org templates
	// Personal context: only update personal templates (organizationId is null)
	const tenantFilter = input.organizationId
		? { organizationId: input.organizationId }
		: { userId: input.userId, organizationId: null };

	const existing = await db.automationTemplate.findFirst({
		where: {
			id: input.templateId,
			...tenantFilter,
		},
	});

	if (!existing) {
		throw new Error(
			`Template ${input.templateId} not found or access denied`,
		);
	}

	const template = await db.automationTemplate.update({
		where: { id: input.templateId },
		data: {
			...(input.name ? { name: input.name } : {}),
			...(input.description !== undefined
				? { description: input.description }
				: {}),
			...(input.workflowSteps
				? { workflowSteps: toJsonValue(input.workflowSteps) }
				: {}),
			...(input.parameters
				? { parameters: toJsonValue(input.parameters) }
				: {}),
			...(input.isPublic !== undefined
				? { isPublic: input.isPublic }
				: {}),
			...(input.category !== undefined
				? { category: input.category }
				: {}),
			...(input.tags ? { tags: input.tags } : {}),
			...(input.incrementVersion ? { version: { increment: 1 } } : {}),
		},
	});

	return { templateId: template.id, version: template.version };
}

// =============================================================================
// Delete Template
// =============================================================================

export async function deleteTemplate(
	input: DeleteTemplateInput,
): Promise<{ deleted: boolean }> {
	// Delete template with strict tenant isolation
	// Organization context: only delete org templates
	// Personal context: only delete personal templates (organizationId is null)
	const tenantFilter = input.organizationId
		? { organizationId: input.organizationId }
		: { userId: input.userId, organizationId: null };

	const result = await db.automationTemplate.deleteMany({
		where: {
			id: input.templateId,
			...tenantFilter,
		},
	});

	return { deleted: result.count > 0 };
}

// =============================================================================
// Record Template Usage
// =============================================================================

export async function recordTemplateUsage(input: {
	templateId: string;
}): Promise<void> {
	await db.automationTemplate.update({
		where: { id: input.templateId },
		data: {
			useCount: { increment: 1 },
			lastUsedAt: new Date(),
		},
	});
}

// =============================================================================
// Resolve Template Parameters
// =============================================================================

export function resolveTemplateParameters(
	workflowSteps: TemplateStep[],
	parameterValues: Record<string, unknown>,
): TemplateStep[] {
	const resolved = JSON.stringify(workflowSteps);

	// Replace all {{paramName}} placeholders
	const resolvedSteps = resolved.replace(/\{\{(\w+)\}\}/g, (_, paramName) => {
		const value = parameterValues[paramName];
		if (value === undefined) {
			throw new Error(`Missing required parameter: ${paramName}`);
		}
		return typeof value === "string" ? value : JSON.stringify(value);
	});

	return JSON.parse(resolvedSteps) as TemplateStep[];
}
