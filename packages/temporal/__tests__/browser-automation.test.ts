/**
 * Tests for Browser Automation Activities and Workflows
 *
 * Tests the Playwright-based browser automation integrated with Temporal.
 * Includes session management, actions, content extraction, and RAG integration.
 */

import { describe, expect, it } from "vitest";

describe("Browser Session Manager", () => {
	describe("generateSessionId", () => {
		it("should generate unique session IDs", async () => {
			const { generateSessionId } = await import(
				"../src/activities/browser-automation/session-manager"
			);

			const id1 = generateSessionId("user-1", "org-1");
			const id2 = generateSessionId("user-1", "org-1");

			expect(id1).not.toBe(id2);
			expect(id1).toMatch(/^browser_org:org-1_\d+_[a-z0-9]+$/);
		});

		it("should generate user-scoped ID when no org", async () => {
			const { generateSessionId } = await import(
				"../src/activities/browser-automation/session-manager"
			);

			const id = generateSessionId("user-1");
			expect(id).toMatch(/^browser_user:user-1_\d+_[a-z0-9]+$/);
		});

		it("should include timestamp for uniqueness", async () => {
			const { generateSessionId } = await import(
				"../src/activities/browser-automation/session-manager"
			);

			const id = generateSessionId("user-1", "org-1");
			const parts = id.split("_");
			const timestamp = Number.parseInt(parts[2] ?? "0", 10);

			expect(timestamp).toBeGreaterThan(0);
			expect(timestamp).toBeLessThanOrEqual(Date.now());
		});
	});
});

describe("Browser Automation Types", () => {
	describe("BrowserActionSchema", () => {
		it("should validate click action", async () => {
			const { BrowserActionSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = BrowserActionSchema.safeParse({
				type: "click",
				selector: "#button",
			});

			expect(result.success).toBe(true);
		});

		it("should validate type action", async () => {
			const { BrowserActionSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = BrowserActionSchema.safeParse({
				type: "type",
				selector: "#input",
				value: "test",
			});

			expect(result.success).toBe(true);
		});

		it("should validate select action", async () => {
			const { BrowserActionSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = BrowserActionSchema.safeParse({
				type: "select",
				selector: "#dropdown",
				value: "option1",
			});

			expect(result.success).toBe(true);
		});

		it("should validate wait action", async () => {
			const { BrowserActionSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = BrowserActionSchema.safeParse({
				type: "wait",
				waitFor: { selector: ".loading", timeout: 5000 },
			});

			expect(result.success).toBe(true);
		});

		it("should validate scroll action", async () => {
			const { BrowserActionSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = BrowserActionSchema.safeParse({
				type: "scroll",
				scrollTo: { x: 0, y: 500 },
			});

			expect(result.success).toBe(true);
		});

		it("should validate evaluate action", async () => {
			const { BrowserActionSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = BrowserActionSchema.safeParse({
				type: "evaluate",
				script: "document.title",
			});

			expect(result.success).toBe(true);
		});

		it("should validate screenshot action", async () => {
			const { BrowserActionSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = BrowserActionSchema.safeParse({
				type: "screenshot",
				screenshotOptions: { fullPage: true, name: "test" },
			});

			expect(result.success).toBe(true);
		});

		it("should reject invalid action type", async () => {
			const { BrowserActionSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = BrowserActionSchema.safeParse({
				type: "invalid",
			});

			expect(result.success).toBe(false);
		});
	});

	describe("ContentExtractorSchema", () => {
		it("should validate content extractor", async () => {
			const { ContentExtractorSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = ContentExtractorSchema.safeParse({
				name: "title",
				selector: "h1",
				multiple: false,
				transform: "text",
			});

			expect(result.success).toBe(true);
		});

		it("should apply default values", async () => {
			const { ContentExtractorSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = ContentExtractorSchema.parse({
				name: "content",
				selector: "body",
			});

			expect(result.multiple).toBe(false);
			expect(result.transform).toBe("text");
		});

		it("should validate html transform", async () => {
			const { ContentExtractorSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = ContentExtractorSchema.safeParse({
				name: "content",
				selector: "article",
				transform: "html",
			});

			expect(result.success).toBe(true);
		});

		it("should validate markdown transform", async () => {
			const { ContentExtractorSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = ContentExtractorSchema.safeParse({
				name: "content",
				selector: "article",
				transform: "markdown",
			});

			expect(result.success).toBe(true);
		});

		it("should validate attribute extraction", async () => {
			const { ContentExtractorSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = ContentExtractorSchema.safeParse({
				name: "link",
				selector: "a",
				attribute: "href",
			});

			expect(result.success).toBe(true);
		});
	});

	describe("BrowserSessionOptionsSchema", () => {
		it("should validate session options", async () => {
			const { BrowserSessionOptionsSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = BrowserSessionOptionsSchema.safeParse({
				headless: true,
				timeout: 30000,
				viewport: { width: 1920, height: 1080 },
			});

			expect(result.success).toBe(true);
		});

		it("should apply default values", async () => {
			const { BrowserSessionOptionsSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = BrowserSessionOptionsSchema.parse({});

			expect(result.headless).toBe(true);
			expect(result.timeout).toBe(300000); // 5 minutes default
			expect(result.persistStorage).toBe(false);
		});

		it("should validate blockResources", async () => {
			const { BrowserSessionOptionsSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = BrowserSessionOptionsSchema.safeParse({
				blockResources: ["image", "stylesheet", "font"],
			});

			expect(result.success).toBe(true);
		});
	});

	describe("BrowserAuthConfigSchema", () => {
		it("should validate basic auth credentials", async () => {
			const { BrowserAuthConfigSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = BrowserAuthConfigSchema.safeParse({
				credentials: {
					type: "basic",
					username: "user",
					password: "pass",
				},
			});

			expect(result.success).toBe(true);
		});

		it("should validate form auth credentials", async () => {
			const { BrowserAuthConfigSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = BrowserAuthConfigSchema.safeParse({
				credentials: {
					type: "form",
					usernameSelector: "#username",
					passwordSelector: "#password",
					submitSelector: "#submit",
					username: "user",
					password: "pass",
				},
			});

			expect(result.success).toBe(true);
		});

		it("should validate MCP config ID", async () => {
			const { BrowserAuthConfigSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = BrowserAuthConfigSchema.safeParse({
				mcpConfigId: "mcp-config-123",
			});

			expect(result.success).toBe(true);
		});

		it("should validate cookies", async () => {
			const { BrowserAuthConfigSchema } = await import(
				"../src/activities/browser-automation/types"
			);

			const result = BrowserAuthConfigSchema.safeParse({
				cookies: [
					{ name: "session", value: "abc123", domain: "example.com" },
				],
			});

			expect(result.success).toBe(true);
		});
	});
});

describe("Workflow Builder Steps", () => {
	describe("browser-navigate step", () => {
		it("should be registered in step registry", async () => {
			const { stepRegistry } = await import(
				"../src/activities/lib/step-registry"
			);

			expect(stepRegistry["browser-navigate"]).toBeDefined();
			expect(stepRegistry["browser-navigate"].name).toBe(
				"Browser Navigate",
			);
		});
	});

	describe("browser-extract step", () => {
		it("should be registered in step registry", async () => {
			const { stepRegistry } = await import(
				"../src/activities/lib/step-registry"
			);

			expect(stepRegistry["browser-extract"]).toBeDefined();
			expect(stepRegistry["browser-extract"].name).toBe(
				"Browser Extract",
			);
		});
	});

	describe("browser-screenshot step", () => {
		it("should be registered in step registry", async () => {
			const { stepRegistry } = await import(
				"../src/activities/lib/step-registry"
			);

			expect(stepRegistry["browser-screenshot"]).toBeDefined();
			expect(stepRegistry["browser-screenshot"].name).toBe(
				"Browser Screenshot",
			);
		});
	});

	describe("browser-action step", () => {
		it("should be registered in step registry", async () => {
			const { stepRegistry } = await import(
				"../src/activities/lib/step-registry"
			);

			expect(stepRegistry["browser-action"]).toBeDefined();
			expect(stepRegistry["browser-action"].name).toBe("Browser Action");
		});
	});

	describe("hybrid-step", () => {
		it("should be registered in step registry", async () => {
			const { stepRegistry } = await import(
				"../src/activities/lib/step-registry"
			);

			expect(stepRegistry["hybrid-step"]).toBeDefined();
			expect(stepRegistry["hybrid-step"].name).toBe("Hybrid API/Browser");
		});
	});
});

// =============================================================================
// Phase 3: Hybrid Execution Mode Tests
// =============================================================================

describe("Hybrid Execution Mode", () => {
	describe("HybridMode types", () => {
		it("should support api-first mode", async () => {
			const { HybridExecutionInputSchema } = await import(
				"./test-helpers/hybrid-schemas"
			);

			const result = HybridExecutionInputSchema.safeParse({
				taskId: "task-1",
				userId: "user-1",
				mode: "api-first",
				steps: [{ type: "api", url: "https://api.example.com/data" }],
			});

			expect(result.success).toBe(true);
		});

		it("should support browser-first mode", async () => {
			const { HybridExecutionInputSchema } = await import(
				"./test-helpers/hybrid-schemas"
			);

			const result = HybridExecutionInputSchema.safeParse({
				taskId: "task-1",
				userId: "user-1",
				mode: "browser-first",
				steps: [{ type: "browser", url: "https://example.com" }],
			});

			expect(result.success).toBe(true);
		});

		it("should support api-only mode", async () => {
			const { HybridExecutionInputSchema } = await import(
				"./test-helpers/hybrid-schemas"
			);

			const result = HybridExecutionInputSchema.safeParse({
				taskId: "task-1",
				userId: "user-1",
				mode: "api-only",
				steps: [{ type: "api", url: "https://api.example.com/data" }],
			});

			expect(result.success).toBe(true);
		});

		it("should support browser-only mode", async () => {
			const { HybridExecutionInputSchema } = await import(
				"./test-helpers/hybrid-schemas"
			);

			const result = HybridExecutionInputSchema.safeParse({
				taskId: "task-1",
				userId: "user-1",
				mode: "browser-only",
				steps: [{ type: "browser", url: "https://example.com" }],
			});

			expect(result.success).toBe(true);
		});

		it("should support parallel mode", async () => {
			const { HybridExecutionInputSchema } = await import(
				"./test-helpers/hybrid-schemas"
			);

			const result = HybridExecutionInputSchema.safeParse({
				taskId: "task-1",
				userId: "user-1",
				mode: "parallel",
				steps: [
					{ type: "api", url: "https://api.example.com/data" },
					{ type: "browser", url: "https://example.com" },
				],
			});

			expect(result.success).toBe(true);
		});
	});

	describe("ApiStep validation", () => {
		it("should validate API step with required fields", async () => {
			const { ApiStepSchema } = await import(
				"./test-helpers/hybrid-schemas"
			);

			const result = ApiStepSchema.safeParse({
				type: "api",
				url: "https://api.example.com/data",
			});

			expect(result.success).toBe(true);
		});

		it("should validate API step with all optional fields", async () => {
			const { ApiStepSchema } = await import(
				"./test-helpers/hybrid-schemas"
			);

			const result = ApiStepSchema.safeParse({
				type: "api",
				name: "Fetch user data",
				url: "https://api.example.com/users",
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: { id: 123 },
				timeout: 30000,
				outputMapping: { userId: "$.data.id" },
			});

			expect(result.success).toBe(true);
		});

		it("should reject invalid HTTP method", async () => {
			const { ApiStepSchema } = await import(
				"./test-helpers/hybrid-schemas"
			);

			const result = ApiStepSchema.safeParse({
				type: "api",
				url: "https://api.example.com/data",
				method: "INVALID",
			});

			expect(result.success).toBe(false);
		});
	});

	describe("BrowserStep validation", () => {
		it("should validate browser step with required fields", async () => {
			const { BrowserStepSchema } = await import(
				"./test-helpers/hybrid-schemas"
			);

			const result = BrowserStepSchema.safeParse({
				type: "browser",
				url: "https://example.com",
			});

			expect(result.success).toBe(true);
		});

		it("should validate browser step with actions and extractors", async () => {
			const { BrowserStepSchema } = await import(
				"./test-helpers/hybrid-schemas"
			);

			const result = BrowserStepSchema.safeParse({
				type: "browser",
				name: "Scrape product page",
				url: "https://example.com/product",
				actions: [
					{ type: "click", selector: "#load-more" },
					{ type: "wait", waitFor: { selector: ".loaded" } },
				],
				extractors: [
					{ name: "title", selector: "h1", transform: "text" },
					{ name: "price", selector: ".price", transform: "text" },
				],
				waitForSelector: ".product-loaded",
				timeout: 60000,
			});

			expect(result.success).toBe(true);
		});
	});

	describe("Fallback configuration", () => {
		it("should accept fallbackOnError option", async () => {
			const { HybridExecutionInputSchema } = await import(
				"./test-helpers/hybrid-schemas"
			);

			const result = HybridExecutionInputSchema.safeParse({
				taskId: "task-1",
				userId: "user-1",
				mode: "api-first",
				steps: [{ type: "api", url: "https://api.example.com" }],
				fallbackOnError: true,
			});

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.fallbackOnError).toBe(true);
			}
		});

		it("should accept fallbackOnStatusCodes option", async () => {
			const { HybridExecutionInputSchema } = await import(
				"./test-helpers/hybrid-schemas"
			);

			const result = HybridExecutionInputSchema.safeParse({
				taskId: "task-1",
				userId: "user-1",
				mode: "api-first",
				steps: [{ type: "api", url: "https://api.example.com" }],
				fallbackOnStatusCodes: [429, 500, 502, 503],
			});

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.fallbackOnStatusCodes).toEqual([
					429, 500, 502, 503,
				]);
			}
		});
	});

	describe("Variable substitution", () => {
		it("should accept variables for data passing between steps", async () => {
			const { HybridExecutionInputSchema } = await import(
				"./test-helpers/hybrid-schemas"
			);

			const result = HybridExecutionInputSchema.safeParse({
				taskId: "task-1",
				userId: "user-1",
				mode: "api-first",
				steps: [
					{ type: "api", url: "https://api.example.com/{{userId}}" },
				],
				variables: { userId: "12345", apiKey: "secret-key" },
			});

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.variables).toEqual({
					userId: "12345",
					apiKey: "secret-key",
				});
			}
		});
	});
});

// =============================================================================
// Phase 4: Template Types Tests
// =============================================================================

describe("Automation Template Types", () => {
	describe("TemplateParameterSchema", () => {
		it("should validate string parameter", async () => {
			const { TemplateParameterSchema } = await import(
				"../src/activities/automation-template/types"
			);

			const result = TemplateParameterSchema.safeParse({
				name: "url",
				type: "url",
				description: "Target URL to navigate to",
				required: true,
			});

			expect(result.success).toBe(true);
		});

		it("should validate parameter with default value", async () => {
			const { TemplateParameterSchema } = await import(
				"../src/activities/automation-template/types"
			);

			const result = TemplateParameterSchema.safeParse({
				name: "timeout",
				type: "number",
				required: false,
				defaultValue: 30000,
			});

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.defaultValue).toBe(30000);
			}
		});

		it("should validate parameter with validation rules", async () => {
			const { TemplateParameterSchema } = await import(
				"../src/activities/automation-template/types"
			);

			const result = TemplateParameterSchema.safeParse({
				name: "retryCount",
				type: "number",
				validation: { min: 0, max: 10 },
			});

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.validation?.min).toBe(0);
				expect(result.data.validation?.max).toBe(10);
			}
		});

		it("should validate parameter with enum validation", async () => {
			const { TemplateParameterSchema } = await import(
				"../src/activities/automation-template/types"
			);

			const result = TemplateParameterSchema.safeParse({
				name: "format",
				type: "string",
				validation: { enum: ["json", "xml", "csv"] },
			});

			expect(result.success).toBe(true);
		});
	});

	describe("TemplateStepSchema", () => {
		it("should validate navigate step", async () => {
			const { TemplateStepSchema } = await import(
				"../src/activities/automation-template/types"
			);

			const result = TemplateStepSchema.safeParse({
				id: "step-1",
				type: "navigate",
				name: "Navigate to URL",
				config: { url: "{{url}}" },
				parameterRefs: ["url"],
			});

			expect(result.success).toBe(true);
		});

		it("should validate action step", async () => {
			const { TemplateStepSchema } = await import(
				"../src/activities/automation-template/types"
			);

			const result = TemplateStepSchema.safeParse({
				id: "step-2",
				type: "action",
				name: "Click button",
				config: { type: "click", selector: "#submit" },
				onError: "skip",
				maxRetries: 5,
			});

			expect(result.success).toBe(true);
		});

		it("should validate extract step", async () => {
			const { TemplateStepSchema } = await import(
				"../src/activities/automation-template/types"
			);

			const result = TemplateStepSchema.safeParse({
				id: "step-3",
				type: "extract",
				config: {
					extractors: [
						{ name: "title", selector: "h1" },
						{ name: "content", selector: "article" },
					],
				},
			});

			expect(result.success).toBe(true);
		});

		it("should validate conditional step", async () => {
			const { TemplateStepSchema } = await import(
				"../src/activities/automation-template/types"
			);

			const result = TemplateStepSchema.safeParse({
				id: "step-4",
				type: "action",
				config: { type: "click", selector: ".pagination" },
				condition: "{{hasMorePages}} === true",
			});

			expect(result.success).toBe(true);
		});

		it("should apply default values for onError and maxRetries", async () => {
			const { TemplateStepSchema } = await import(
				"../src/activities/automation-template/types"
			);

			const result = TemplateStepSchema.parse({
				id: "step-5",
				type: "screenshot",
				config: { fullPage: true },
			});

			expect(result.onError).toBe("stop");
			expect(result.maxRetries).toBe(3);
		});
	});

	describe("AutomationTemplateSchema", () => {
		it("should validate complete template", async () => {
			const { AutomationTemplateSchema } = await import(
				"../src/activities/automation-template/types"
			);

			const result = AutomationTemplateSchema.safeParse({
				name: "Product Scraper",
				description: "Scrape product details from e-commerce sites",
				workflowSteps: [
					{
						id: "step-1",
						type: "navigate",
						config: { url: "{{productUrl}}" },
						parameterRefs: ["productUrl"],
					},
					{
						id: "step-2",
						type: "extract",
						config: {
							extractors: [
								{ name: "title", selector: ".product-title" },
								{ name: "price", selector: ".product-price" },
							],
						},
					},
				],
				parameters: [
					{
						name: "productUrl",
						type: "url",
						description: "URL of the product page",
						required: true,
					},
				],
				userId: "user-123",
				organizationId: "org-456",
				isPublic: false,
				category: "e-commerce",
				tags: ["scraping", "products", "automation"],
			});

			expect(result.success).toBe(true);
		});

		it("should apply default values", async () => {
			const { AutomationTemplateSchema } = await import(
				"../src/activities/automation-template/types"
			);

			const result = AutomationTemplateSchema.parse({
				name: "Simple Template",
				workflowSteps: [
					{
						id: "step-1",
						type: "navigate",
						config: { url: "https://example.com" },
					},
				],
				userId: "user-123",
			});

			expect(result.isPublic).toBe(false);
			expect(result.version).toBe(1);
			expect(result.tags).toEqual([]);
		});

		it("should reject template without name", async () => {
			const { AutomationTemplateSchema } = await import(
				"../src/activities/automation-template/types"
			);

			const result = AutomationTemplateSchema.safeParse({
				workflowSteps: [],
				userId: "user-123",
			});

			expect(result.success).toBe(false);
		});

		it("should reject template without userId", async () => {
			const { AutomationTemplateSchema } = await import(
				"../src/activities/automation-template/types"
			);

			const result = AutomationTemplateSchema.safeParse({
				name: "Test Template",
				workflowSteps: [],
			});

			expect(result.success).toBe(false);
		});
	});
});

// =============================================================================
// Template Parameter Resolution Tests
// =============================================================================

describe("Template Parameter Resolution", () => {
	// Inline implementation for testing (mirrors workflow logic)
	function resolveTemplateParameters(
		workflowSteps: Array<{ id: string; config: Record<string, unknown> }>,
		parameterValues: Record<string, unknown>,
	): Array<{ id: string; config: Record<string, unknown> }> {
		const resolved = JSON.stringify(workflowSteps);
		const resolvedSteps = resolved.replace(
			/\{\{(\w+)\}\}/g,
			(_, paramName) => {
				const value = parameterValues[paramName];
				if (value === undefined) {
					throw new Error(`Missing required parameter: ${paramName}`);
				}
				return typeof value === "string"
					? value
					: JSON.stringify(value);
			},
		);
		return JSON.parse(resolvedSteps);
	}

	it("should resolve simple string parameter", () => {
		const steps = [{ id: "step-1", config: { url: "{{targetUrl}}" } }];
		const params = { targetUrl: "https://example.com" };

		const resolved = resolveTemplateParameters(steps, params);

		expect(resolved[0].config.url).toBe("https://example.com");
	});

	it("should resolve multiple parameters in same step", () => {
		const steps = [
			{
				id: "step-1",
				config: { username: "{{user}}", password: "{{pass}}" },
			},
		];
		const params = { user: "admin", pass: "secret123" };

		const resolved = resolveTemplateParameters(steps, params);

		expect(resolved[0].config.username).toBe("admin");
		expect(resolved[0].config.password).toBe("secret123");
	});

	it("should resolve parameters across multiple steps", () => {
		const steps = [
			{ id: "step-1", config: { url: "{{baseUrl}}/login" } },
			{ id: "step-2", config: { url: "{{baseUrl}}/dashboard" } },
		];
		const params = { baseUrl: "https://app.example.com" };

		const resolved = resolveTemplateParameters(steps, params);

		expect(resolved[0].config.url).toBe("https://app.example.com/login");
		expect(resolved[1].config.url).toBe(
			"https://app.example.com/dashboard",
		);
	});

	it("should resolve number parameters as JSON", () => {
		const steps = [{ id: "step-1", config: { timeout: "{{timeout}}" } }];
		const params = { timeout: 30000 };

		const resolved = resolveTemplateParameters(steps, params);

		// Numbers get stringified
		expect(resolved[0].config.timeout).toBe("30000");
	});

	it("should throw error for missing required parameter", () => {
		const steps = [{ id: "step-1", config: { url: "{{missingParam}}" } }];
		const params = {};

		expect(() => resolveTemplateParameters(steps, params)).toThrow(
			"Missing required parameter: missingParam",
		);
	});

	it("should preserve non-parameterized values", () => {
		const steps = [
			{
				id: "step-1",
				config: {
					url: "{{url}}",
					method: "GET",
					headers: { Accept: "application/json" },
				},
			},
		];
		const params = { url: "https://api.example.com" };

		const resolved = resolveTemplateParameters(steps, params);

		expect(resolved[0].config.url).toBe("https://api.example.com");
		expect(resolved[0].config.method).toBe("GET");
		expect(
			(resolved[0].config.headers as Record<string, string>).Accept,
		).toBe("application/json");
	});

	it("should handle nested object parameters", () => {
		const steps = [{ id: "step-1", config: { selector: "{{selector}}" } }];
		const params = { selector: "#complex[data-id='123']" };

		const resolved = resolveTemplateParameters(steps, params);

		expect(resolved[0].config.selector).toBe("#complex[data-id='123']");
	});
});

// =============================================================================
// Template Activity Input Validation Tests
// =============================================================================

describe("Template Activity Input Types", () => {
	describe("CreateTemplateInput", () => {
		it("should accept valid create template input", async () => {
			const { CreateTemplateInputSchema } = await import(
				"./test-helpers/template-schemas"
			);

			const result = CreateTemplateInputSchema.safeParse({
				name: "My Template",
				description: "A test template",
				workflowSteps: [
					{
						id: "step-1",
						type: "navigate",
						config: { url: "https://example.com" },
					},
				],
				userId: "user-123",
				organizationId: "org-456",
				isPublic: false,
				category: "testing",
				tags: ["test", "automation"],
			});

			expect(result.success).toBe(true);
		});
	});

	describe("CreateTemplateFromTaskInput", () => {
		it("should accept valid create from task input", async () => {
			const { CreateTemplateFromTaskInputSchema } = await import(
				"./test-helpers/template-schemas"
			);

			const result = CreateTemplateFromTaskInputSchema.safeParse({
				taskId: "task-123",
				name: "Template from Task",
				description: "Created from successful task",
				userId: "user-123",
				extractParameters: true,
			});

			expect(result.success).toBe(true);
		});
	});

	describe("ListTemplatesInput", () => {
		it("should accept valid list templates input", async () => {
			const { ListTemplatesInputSchema } = await import(
				"./test-helpers/template-schemas"
			);

			const result = ListTemplatesInputSchema.safeParse({
				userId: "user-123",
				organizationId: "org-456",
				category: "e-commerce",
				tags: ["scraping"],
				includePublic: true,
				limit: 20,
				offset: 0,
			});

			expect(result.success).toBe(true);
		});
	});

	describe("UpdateTemplateInput", () => {
		it("should accept valid update template input", async () => {
			const { UpdateTemplateInputSchema } = await import(
				"./test-helpers/template-schemas"
			);

			const result = UpdateTemplateInputSchema.safeParse({
				templateId: "template-123",
				userId: "user-123",
				name: "Updated Name",
				description: "Updated description",
				incrementVersion: true,
			});

			expect(result.success).toBe(true);
		});
	});

	describe("ExecuteTemplateInput", () => {
		it("should accept valid execute template input", async () => {
			const { ExecuteTemplateInputSchema } = await import(
				"./test-helpers/template-schemas"
			);

			const result = ExecuteTemplateInputSchema.safeParse({
				templateId: "template-123",
				parameterValues: { url: "https://example.com", timeout: 30000 },
				userId: "user-123",
				organizationId: "org-456",
			});

			expect(result.success).toBe(true);
		});

		it("should require parameterValues object", async () => {
			const { ExecuteTemplateInputSchema } = await import(
				"./test-helpers/template-schemas"
			);

			const result = ExecuteTemplateInputSchema.safeParse({
				templateId: "template-123",
				userId: "user-123",
			});

			expect(result.success).toBe(false);
		});
	});
});
