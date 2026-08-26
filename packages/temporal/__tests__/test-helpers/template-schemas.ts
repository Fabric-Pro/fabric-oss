/**
 * Test Helpers: Template Activity Input Schemas
 *
 * Zod schemas for validating template activity inputs in tests.
 */

import { z } from "zod";
import {
	TemplateParameterSchema,
	TemplateStepSchema,
} from "../../src/activities/automation-template/types";

// =============================================================================
// Create Template Input Schema
// =============================================================================

export const CreateTemplateInputSchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	workflowSteps: z.array(TemplateStepSchema),
	parameters: z.array(TemplateParameterSchema).optional(),
	sourceTaskId: z.string().optional(),
	userId: z.string(),
	organizationId: z.string().optional(),
	isPublic: z.boolean().optional(),
	category: z.string().optional(),
	tags: z.array(z.string()).optional(),
});

export type CreateTemplateInput = z.infer<typeof CreateTemplateInputSchema>;

// =============================================================================
// Create Template From Task Input Schema
// =============================================================================

export const CreateTemplateFromTaskInputSchema = z.object({
	taskId: z.string(),
	name: z.string().min(1),
	description: z.string().optional(),
	userId: z.string(),
	organizationId: z.string().optional(),
	extractParameters: z.boolean().optional(),
});

export type CreateTemplateFromTaskInput = z.infer<
	typeof CreateTemplateFromTaskInputSchema
>;

// =============================================================================
// Execute Template Input Schema
// =============================================================================

export const ExecuteTemplateInputSchema = z.object({
	templateId: z.string(),
	parameterValues: z.record(z.string(), z.unknown()),
	userId: z.string(),
	organizationId: z.string().optional(),
});

export type ExecuteTemplateInput = z.infer<typeof ExecuteTemplateInputSchema>;

// =============================================================================
// List Templates Input Schema
// =============================================================================

export const ListTemplatesInputSchema = z.object({
	userId: z.string(),
	organizationId: z.string().optional(),
	category: z.string().optional(),
	tags: z.array(z.string()).optional(),
	includePublic: z.boolean().optional(),
	limit: z.number().positive().optional(),
	offset: z.number().nonnegative().optional(),
});

export type ListTemplatesInput = z.infer<typeof ListTemplatesInputSchema>;

// =============================================================================
// Update Template Input Schema
// =============================================================================

export const UpdateTemplateInputSchema = z.object({
	templateId: z.string(),
	userId: z.string(),
	organizationId: z.string().optional(),
	name: z.string().optional(),
	description: z.string().optional(),
	workflowSteps: z.array(TemplateStepSchema).optional(),
	parameters: z.array(TemplateParameterSchema).optional(),
	isPublic: z.boolean().optional(),
	category: z.string().optional(),
	tags: z.array(z.string()).optional(),
	incrementVersion: z.boolean().optional(),
});

export type UpdateTemplateInput = z.infer<typeof UpdateTemplateInputSchema>;

// =============================================================================
// Delete Template Input Schema
// =============================================================================

export const DeleteTemplateInputSchema = z.object({
	templateId: z.string(),
	userId: z.string(),
	organizationId: z.string().optional(),
});

export type DeleteTemplateInput = z.infer<typeof DeleteTemplateInputSchema>;

// =============================================================================
// Template Execution Result Schemas
// =============================================================================

export const StepExecutionResultSchema = z.object({
	stepId: z.string(),
	stepName: z.string().optional(),
	success: z.boolean(),
	output: z.unknown().optional(),
	error: z.string().optional(),
	screenshotUrl: z.string().optional(),
	duration: z.number(),
});

export type StepExecutionResult = z.infer<typeof StepExecutionResultSchema>;

export const TemplateExecutionResultSchema = z.object({
	taskId: z.string(),
	templateId: z.string(),
	success: z.boolean(),
	stepResults: z.array(StepExecutionResultSchema),
	aggregatedOutput: z.record(z.string(), z.unknown()),
	error: z.string().optional(),
	duration: z.number(),
});

export type TemplateExecutionResult = z.infer<
	typeof TemplateExecutionResultSchema
>;
