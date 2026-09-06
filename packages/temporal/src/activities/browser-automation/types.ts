/**
 * Browser Automation Types
 *
 * Type definitions for browser automation activities and workflows.
 * Inspired by CUGA (ConfigUrable Generalist Agent) patterns.
 */

import { z } from "zod";

// =============================================================================
// Browser Action Types
// =============================================================================

export const BrowserActionTypeSchema = z.enum([
	"navigate",
	"click",
	"type",
	"select",
	"wait",
	"scroll",
	"screenshot",
	"extract",
	"evaluate", // Execute JavaScript
]);

export type BrowserActionType = z.infer<typeof BrowserActionTypeSchema>;

export const BrowserActionSchema = z.object({
	type: BrowserActionTypeSchema,
	// Selector for element interactions
	selector: z.string().optional(),
	// Value for type/select actions
	value: z.string().optional(),
	// URL for navigate action
	url: z.string().url().optional(),
	// Wait conditions
	waitFor: z
		.object({
			selector: z.string().optional(),
			timeout: z.number().default(30000),
			state: z
				.enum(["visible", "hidden", "attached", "detached"])
				.optional(),
		})
		.optional(),
	// Scroll options
	scroll: z
		.object({
			direction: z.enum(["up", "down", "left", "right"]).default("down"),
			amount: z.number().default(500),
		})
		.optional(),
	// JavaScript to evaluate
	script: z.string().optional(),
	// Screenshot options
	screenshotOptions: z
		.object({
			fullPage: z.boolean().default(false),
			name: z.string().optional(),
		})
		.optional(),
});

export type BrowserAction = z.infer<typeof BrowserActionSchema>;

// =============================================================================
// Content Extractor Types
// =============================================================================

export const ContentExtractorSchema = z.object({
	name: z.string(),
	selector: z.string(),
	attribute: z.string().optional(), // Extract attribute instead of text
	multiple: z.boolean().default(false), // Extract all matching elements
	transform: z.enum(["text", "html", "markdown"]).default("text"),
});

export type ContentExtractor = z.infer<typeof ContentExtractorSchema>;

// =============================================================================
// Session Types
// =============================================================================

export const BrowserSessionOptionsSchema = z.object({
	headless: z.boolean().optional().default(true),
	timeout: z.number().optional().default(300000), // 5 minutes default
	viewport: z
		.object({
			width: z.number().default(1920),
			height: z.number().default(1080),
		})
		.optional(),
	userAgent: z.string().optional(),
	// Persist cookies/storage between sessions
	persistStorage: z.boolean().optional().default(false),
	// Block certain resource types
	blockResources: z
		.array(z.enum(["image", "stylesheet", "font", "media"]))
		.optional(),
});

export type BrowserSessionOptions = z.input<typeof BrowserSessionOptionsSchema>;

// =============================================================================
// Authentication Types
// =============================================================================

export const BrowserAuthConfigSchema = z.object({
	// Use stored MCP OAuth tokens
	mcpConfigId: z.string().optional(),
	// Or provide credentials directly (for basic auth, etc.)
	credentials: z
		.object({
			type: z.enum(["basic", "form", "oauth"]),
			username: z.string().optional(),
			password: z.string().optional(),
			// Form-based login
			usernameSelector: z.string().optional(),
			passwordSelector: z.string().optional(),
			submitSelector: z.string().optional(),
			// OAuth redirect handling
			oauthRedirectUrl: z.string().optional(),
		})
		.optional(),
});

export type BrowserAuthConfig = z.infer<typeof BrowserAuthConfigSchema>;

// =============================================================================
// Result Types
// =============================================================================

export interface BrowserActionResult {
	success: boolean;
	action: BrowserAction;
	output?: unknown;
	screenshot?: string; // S3 URL
	error?: string;
	duration: number; // ms
}

export interface BrowserExtractionResult {
	[key: string]: string | string[] | null;
}

export interface BrowserTaskResult {
	success: boolean;
	actionResults: BrowserActionResult[];
	extraction?: BrowserExtractionResult;
	screenshots: string[];
	error?: string;
	totalDuration: number;
}

// =============================================================================
// Activity Input Types
// =============================================================================

export interface CreateBrowserSessionInput {
	taskId: string;
	userId: string;
	organizationId?: string;
	options?: BrowserSessionOptions;
}

// Every input that names an existing session also carries the caller's
// identity, which the session manager checks against the session's recorded
// owner before handing back a live browser. `userId` is deliberately REQUIRED:
// an optional field would let a call site silently skip the ownership check,
// whereas a required one makes the compiler enumerate every call site.
// `organizationId` stays optional, matching `CreateBrowserSessionInput`.

export interface NavigateInput {
	sessionId: string;
	userId: string;
	organizationId?: string;
	url: string;
	waitForSelector?: string;
	timeout?: number;
}

export interface ExecuteActionInput {
	sessionId: string;
	userId: string;
	organizationId?: string;
	action: BrowserAction;
}

export interface ExtractContentInput {
	sessionId: string;
	userId: string;
	organizationId?: string;
	extractors: ContentExtractor[];
}

export interface TakeScreenshotInput {
	sessionId: string;
	userId: string;
	organizationId?: string;
	taskId: string;
	fullPage?: boolean;
	name?: string;
}

export interface AuthenticateInput {
	sessionId: string;
	userId: string;
	organizationId?: string;
	config: BrowserAuthConfig;
	loginUrl?: string;
}

export interface CloseBrowserSessionInput {
	sessionId: string;
	userId: string;
	organizationId?: string;
	persistStorage?: boolean;
}
