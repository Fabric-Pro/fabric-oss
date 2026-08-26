/**
 * Fabric MCP Server Types
 *
 * Type definitions for the MCP server that exposes fabric browser automation.
 */

import { z } from "zod";

// =============================================================================
// Configuration Types
// =============================================================================

// =============================================================================
// Browser Action Schemas (match Temporal workflow types)
// =============================================================================

const BrowserActionTypeSchema = z.enum([
	"navigate",
	"click",
	"type",
	"select",
	"wait",
	"scroll",
	"screenshot",
	"extract",
	"evaluate",
]);

export const BrowserActionSchema = z.object({
	type: BrowserActionTypeSchema,
	selector: z.string().optional(),
	value: z.string().optional(),
	timeout: z.number().optional(),
	waitOptions: z
		.object({
			state: z
				.enum(["visible", "hidden", "attached", "detached"])
				.optional(),
			timeout: z.number().optional(),
		})
		.optional(),
	scrollOptions: z
		.object({
			direction: z.enum(["up", "down", "left", "right"]).optional(),
			amount: z.number().optional(),
		})
		.optional(),
	script: z.string().optional(),
	screenshotOptions: z
		.object({
			fullPage: z.boolean().default(false),
			name: z.string().optional(),
		})
		.optional(),
});

export const ContentExtractorSchema = z.object({
	name: z.string(),
	selector: z.string(),
	attribute: z.string().optional(),
	multiple: z.boolean().default(false),
	transform: z.enum(["text", "html", "markdown"]).default("text"),
});

// =============================================================================
// Tool Input Schemas
// =============================================================================

export const RunBrowserTaskInputSchema = z.object({
	url: z.string().url().describe("The URL to navigate to"),
	actions: z
		.array(BrowserActionSchema)
		.optional()
		.describe("Browser actions to execute (click, type, etc.)"),
	extractors: z
		.array(ContentExtractorSchema)
		.optional()
		.describe("Content extractors to run after actions"),
	takeScreenshots: z
		.boolean()
		.optional()
		.describe("Whether to take screenshots during execution"),
});

export const HybridModeSchema = z.enum([
	"api-first",
	"browser-first",
	"api-only",
	"browser-only",
	"parallel",
]);

const ApiStepSchema = z.object({
	type: z.literal("api"),
	name: z.string().optional(),
	url: z.string().url(),
	method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional(),
	headers: z.record(z.string()).optional(),
	body: z.unknown().optional(),
	timeout: z.number().optional(),
});

const BrowserStepSchema = z.object({
	type: z.literal("browser"),
	name: z.string().optional(),
	url: z.string().url(),
	actions: z.array(BrowserActionSchema).optional(),
	extractors: z.array(ContentExtractorSchema).optional(),
	waitForSelector: z.string().optional(),
	timeout: z.number().optional(),
});

const HybridStepSchema = z.union([ApiStepSchema, BrowserStepSchema]);

export const RunHybridTaskInputSchema = z.object({
	mode: HybridModeSchema.describe(
		"Execution mode: api-first, browser-first, api-only, browser-only, or parallel",
	),
	steps: z.array(HybridStepSchema).describe("Steps to execute"),
	fallbackOnError: z
		.boolean()
		.optional()
		.describe("Whether to fallback to alternative method on error"),
	variables: z
		.record(z.unknown())
		.optional()
		.describe("Variables for template substitution in URLs/values"),
});

export const ExecuteTemplateInputSchema = z.object({
	templateId: z.string().describe("ID of the saved automation template"),
	parameters: z
		.record(z.unknown())
		.describe("Parameter values to substitute in the template"),
	takeScreenshots: z
		.boolean()
		.optional()
		.describe("Whether to take screenshots during execution"),
});

export const ListTemplatesInputSchema = z.object({
	category: z.string().optional().describe("Filter templates by category"),
	tags: z.array(z.string()).optional().describe("Filter templates by tags"),
});

export const ExtractWebContentInputSchema = z.object({
	urls: z.array(z.string().url()).describe("URLs to extract content from"),
	selectors: z
		.object({
			content: z
				.string()
				.optional()
				.describe("CSS selector for main content"),
			title: z.string().optional().describe("CSS selector for title"),
			exclude: z
				.array(z.string())
				.optional()
				.describe("CSS selectors to exclude"),
		})
		.optional()
		.describe("CSS selectors for content extraction"),
	waitForSelector: z
		.string()
		.optional()
		.describe("Wait for this selector before extraction"),
});
