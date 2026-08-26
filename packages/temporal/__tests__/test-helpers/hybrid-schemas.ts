/**
 * Test Helpers: Hybrid Execution Schemas
 *
 * Zod schemas for validating hybrid execution workflow inputs in tests.
 */

import { z } from "zod";
import {
	BrowserActionSchema,
	BrowserSessionOptionsSchema,
	ContentExtractorSchema,
} from "../../src/activities/browser-automation/types";

// =============================================================================
// Hybrid Mode
// =============================================================================

export const HybridModeSchema = z.enum([
	"api-first",
	"browser-first",
	"api-only",
	"browser-only",
	"parallel",
]);

export type HybridMode = z.infer<typeof HybridModeSchema>;

// =============================================================================
// API Step Schema
// =============================================================================

export const ApiStepSchema = z.object({
	type: z.literal("api"),
	name: z.string().optional(),
	url: z.string().url(),
	method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional(),
	headers: z.record(z.string(), z.string()).optional(),
	body: z.unknown().optional(),
	timeout: z.number().positive().optional(),
	outputMapping: z.record(z.string(), z.string()).optional(),
});

export type ApiStep = z.infer<typeof ApiStepSchema>;

// =============================================================================
// Browser Step Schema
// =============================================================================

export const BrowserStepSchema = z.object({
	type: z.literal("browser"),
	name: z.string().optional(),
	url: z.string().url(),
	actions: z.array(BrowserActionSchema).optional(),
	extractors: z.array(ContentExtractorSchema).optional(),
	waitForSelector: z.string().optional(),
	timeout: z.number().positive().optional(),
	outputMapping: z.record(z.string(), z.string()).optional(),
});

export type BrowserStep = z.infer<typeof BrowserStepSchema>;

// =============================================================================
// Hybrid Step (Union)
// =============================================================================

export const HybridStepSchema = z.union([ApiStepSchema, BrowserStepSchema]);

export type HybridStep = z.infer<typeof HybridStepSchema>;

// =============================================================================
// Hybrid Execution Input Schema
// =============================================================================

export const HybridExecutionInputSchema = z.object({
	taskId: z.string(),
	userId: z.string(),
	organizationId: z.string().optional(),
	mode: HybridModeSchema,
	steps: z.array(HybridStepSchema),
	fallbackOnError: z.boolean().optional(),
	fallbackOnStatusCodes: z.array(z.number()).optional(),
	browserOptions: BrowserSessionOptionsSchema.optional(),
	variables: z.record(z.string(), z.unknown()).optional(),
});

export type HybridExecutionInput = z.infer<typeof HybridExecutionInputSchema>;

// =============================================================================
// Step Result Schema
// =============================================================================

export const StepResultSchema = z.object({
	stepName: z.string().optional(),
	stepType: z.enum(["api", "browser"]),
	success: z.boolean(),
	data: z.unknown().optional(),
	error: z.string().optional(),
	duration: z.number(),
	fallback: z.boolean().optional(),
});

export type StepResult = z.infer<typeof StepResultSchema>;

// =============================================================================
// Hybrid Execution Result Schema
// =============================================================================

export const HybridExecutionResultSchema = z.object({
	taskId: z.string(),
	success: z.boolean(),
	mode: HybridModeSchema,
	results: z.array(StepResultSchema),
	aggregatedData: z.record(z.string(), z.unknown()),
	error: z.string().optional(),
	duration: z.number(),
});

export type HybridExecutionResult = z.infer<typeof HybridExecutionResultSchema>;
