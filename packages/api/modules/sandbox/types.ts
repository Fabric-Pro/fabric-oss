/**
 * Dynamic Worker Sandbox API Types
 *
 * Type definitions for Dynamic Workers-backed code execution.
 */

import { z } from "zod";

/**
 * Supported programming languages.
 * Dynamic Workers are used only for JS/TS execution.
 */
export const LanguageSchema = z.enum(["javascript", "typescript"]);
export type Language = z.infer<typeof LanguageSchema>;

/**
 * Rich output format types
 */
const OutputFormatSchema = z.enum([
	"text",
	"html",
	"png",
	"svg",
	"json",
	"chart",
]);

/**
 * Rich output result
 */
const RichOutputSchema = z.object({
	type: OutputFormatSchema,
	text: z.string().optional(),
	html: z.string().optional(),
	png: z.string().optional(), // Base64 encoded
	svg: z.string().optional(),
	json: z.any().optional(),
	chart: z.any().optional(),
});

/**
 * Log entry
 */
const LogEntrySchema = z.object({
	type: z.enum(["stdout", "stderr"]),
	text: z.string(),
	timestamp: z.string().optional(),
});

/**
 * Execution result
 */
export const ExecutionResultSchema = z.object({
	code: z.string(),
	logs: z.array(LogEntrySchema),
	results: z.array(RichOutputSchema).optional(),
	error: z.string().optional(),
	executionCount: z.number().optional(),
	executionTime: z.number().optional(), // milliseconds
});
