/**
 * Automation Template Types
 *
 * Type definitions for Save & Reuse template functionality.
 */

import { z } from "zod";

// =============================================================================
// Parameter Schema
// =============================================================================

export const ParameterTypeSchema = z.enum([
	"string",
	"number",
	"boolean",
	"url",
	"selector",
	"json",
]);

export const TemplateParameterSchema = z.object({
	name: z.string().min(1),
	type: ParameterTypeSchema,
	description: z.string().optional(),
	required: z.boolean().default(true),
	defaultValue: z.unknown().optional(),
	validation: z
		.object({
			pattern: z.string().optional(),
			min: z.number().optional(),
			max: z.number().optional(),
			enum: z.array(z.string()).optional(),
		})
		.optional(),
});

export type TemplateParameter = z.infer<typeof TemplateParameterSchema>;

// =============================================================================
// Workflow Step Schema
// =============================================================================

export const TemplateStepTypeSchema = z.enum([
	"navigate",
	"action",
	"extract",
	"screenshot",
	"api-call",
	"hybrid",
	"wait",
	"condition",
]);

export const TemplateStepSchema = z.object({
	id: z.string(),
	type: TemplateStepTypeSchema,
	name: z.string().optional(),
	config: z.record(z.string(), z.unknown()),
	// Parameter references: {{paramName}}
	parameterRefs: z.array(z.string()).optional(),
	// Conditional execution
	condition: z.string().optional(),
	// Error handling
	onError: z.enum(["stop", "skip", "retry"]).default("stop"),
	maxRetries: z.number().min(0).max(10).default(3),
});

export type TemplateStep = z.infer<typeof TemplateStepSchema>;

// =============================================================================
// Template Schema
// =============================================================================

export const AutomationTemplateSchema = z.object({
	id: z.string().optional(),
	name: z.string().min(1).max(255),
	description: z.string().max(2000).optional(),
	workflowSteps: z.array(TemplateStepSchema),
	parameters: z.array(TemplateParameterSchema).optional(),
	sourceTaskId: z.string().optional(),
	userId: z.string(),
	organizationId: z.string().optional(),
	isPublic: z.boolean().default(false),
	version: z.number().int().positive().default(1),
	category: z.string().max(100).optional(),
	tags: z.array(z.string().max(50)).max(20).default([]),
});

export type AutomationTemplate = z.infer<typeof AutomationTemplateSchema>;

// =============================================================================
// Activity Input Types
// =============================================================================

export interface CreateTemplateInput {
	name: string;
	description?: string;
	workflowSteps: TemplateStep[];
	parameters?: TemplateParameter[];
	sourceTaskId?: string;
	userId: string;
	organizationId?: string;
	isPublic?: boolean;
	category?: string;
	tags?: string[];
}

export interface CreateTemplateFromTaskInput {
	taskId: string;
	name: string;
	description?: string;
	userId: string;
	organizationId?: string;
	extractParameters?: boolean;
}

export interface ExecuteTemplateInput {
	templateId: string;
	parameterValues: Record<string, unknown>;
	userId: string;
	organizationId?: string;
}

export interface ListTemplatesInput {
	userId: string;
	organizationId?: string;
	category?: string;
	tags?: string[];
	includePublic?: boolean;
	limit?: number;
	offset?: number;
}

export interface UpdateTemplateInput {
	templateId: string;
	userId: string;
	organizationId?: string;
	name?: string;
	description?: string;
	workflowSteps?: TemplateStep[];
	parameters?: TemplateParameter[];
	isPublic?: boolean;
	category?: string;
	tags?: string[];
	incrementVersion?: boolean;
}

export interface DeleteTemplateInput {
	templateId: string;
	userId: string;
	organizationId?: string;
}
