/**
 * Tests for OpenAPI Tool Executor
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedOpenAPITool, ToolExecutionConfig } from "../src/types";

const mockPinnedFetch = vi.fn(
	(url: string, init?: RequestInit, _opts?: unknown) => fetch(url, init),
);
vi.mock("@repo/utils/url-security", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@repo/utils/url-security")>();
	return {
		...actual,
		safeFetchOutboundPinned: (
			url: string,
			init?: RequestInit,
			options?: Parameters<typeof actual.safeFetchOutboundPinned>[2],
		) =>
			/^http:\/\/(?:127\.0\.0\.1|10\.0\.0\.1)\//.test(url)
				? actual.safeFetchOutboundPinned(url, init, options)
				: mockPinnedFetch(url, init, options),
	};
});

// Mock the logger
vi.mock("@repo/logs", () => ({
	logger: {
		error: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Sample tool definition
const sampleTool: ParsedOpenAPITool = {
	operationId: "getPetById",
	method: "GET",
	path: "/pets/{petId}",
	summary: "Get a pet by ID",
	description: "Returns a single pet",
	pathParams: [
		{
			name: "petId",
			in: "path",
			required: true,
			schema: { type: "string" },
		},
	],
	queryParams: [
		{
			name: "includeDetails",
			in: "query",
			required: false,
			schema: { type: "boolean" },
		},
	],
	headerParams: [
		{
			name: "X-Request-ID",
			in: "header",
			required: false,
			schema: { type: "string" },
		},
	],
	requestBodySchema: null,
	responseSchema: { type: "object" },
	tags: ["pets"],
	deprecated: false,
};

const postTool: ParsedOpenAPITool = {
	operationId: "createPet",
	method: "POST",
	path: "/pets",
	summary: "Create a pet",
	description: "Creates a new pet",
	pathParams: [],
	queryParams: [],
	headerParams: [],
	requestBodySchema: {
		type: "object",
		properties: { name: { type: "string" }, species: { type: "string" } },
	},
	responseSchema: { type: "object" },
	tags: ["pets"],
	deprecated: false,
};

describe("OpenAPI Executor", () => {
	beforeEach(() => {
		mockFetch.mockReset();
		mockPinnedFetch.mockClear();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("executeOpenAPITool", () => {
		it("guards the agent tool execution wrapper", async () => {
			const { createOpenAPIAgentTool } = await import(
				"../src/lib/loader"
			);
			const agentTool = createOpenAPIAgentTool(
				{
					id: "example-tool",
					name: "listExamples",
					description: null,
					method: "GET",
					path: "/examples",
					operationId: "listExamples",
					parametersSchema: null,
					requestBodySchema: null,
					responseSchema: null,
					tags: [],
				},
				{
					baseUrl: "http://127.0.0.1",
					authType: "NONE",
					authKey: null,
					authValue: null,
					authLocation: null,
				},
			);
			await expect(agentTool.execute({})).resolves.toMatchObject({
				success: false,
				error: "OpenAPI tool URL is not a permitted public address",
			});
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("passes redirect and content controls to the pinned guard", async () => {
			mockFetch.mockResolvedValueOnce(
				new Response("", {
					status: 302,
					headers: { location: "http://127.0.0.1/private" },
				}),
			);
			const { executeOpenAPITool } = await import("../src/lib/executor");
			const result = await executeOpenAPITool({
				tool: sampleTool,
				config: {
					baseUrl: "https://api.example.com",
					authType: "NONE",
				},
				arguments: { petId: "1" },
			});
			expect(mockPinnedFetch).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(Object),
				expect.objectContaining({
					followRedirects: false,
					allowedContentTypes: ["*/*"],
					timeoutMs: 30_000,
				}),
			);
			expect(result.success).toBe(false);
			expect(result.error).toBe("OpenAPI tool redirects are not allowed");
			expect(result.headers).toBeUndefined();
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});

		it.each(["http://127.0.0.1", "http://10.0.0.1"])(
			"reports a blocked private base URL without its address: %s",
			async (baseUrl) => {
				const { executeOpenAPITool } = await import(
					"../src/lib/executor"
				);
				const result = await executeOpenAPITool({
					tool: sampleTool,
					config: { baseUrl, authType: "NONE" },
					arguments: { petId: "1" },
				});
				expect(result).toMatchObject({
					success: false,
					error: "OpenAPI tool URL is not a permitted public address",
				});
				expect(mockFetch).not.toHaveBeenCalled();
			},
		);
		it("should build correct URL with path parameters", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ id: "123", name: "Fluffy" }),
				headers: new Headers({ "content-type": "application/json" }),
			});

			const { executeOpenAPITool } = await import("../src/lib/executor");
			const config: ToolExecutionConfig = {
				baseUrl: "https://api.petstore.com/v1",
				authType: "NONE",
			};

			await executeOpenAPITool({
				tool: sampleTool,
				config,
				arguments: { petId: "123" },
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.petstore.com/v1/pets/123",
				expect.any(Object),
			);
		});

		it("should add query parameters to URL", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ id: "123", name: "Fluffy" }),
				headers: new Headers({ "content-type": "application/json" }),
			});

			const { executeOpenAPITool } = await import("../src/lib/executor");
			const config: ToolExecutionConfig = {
				baseUrl: "https://api.petstore.com/v1",
				authType: "NONE",
			};

			await executeOpenAPITool({
				tool: sampleTool,
				config,
				arguments: { petId: "123", includeDetails: true },
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.petstore.com/v1/pets/123?includeDetails=true",
				expect.any(Object),
			);
		});

		it("should add API key header for API_KEY auth", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ id: "123" }),
				headers: new Headers({ "content-type": "application/json" }),
			});

			const { executeOpenAPITool } = await import("../src/lib/executor");
			const config: ToolExecutionConfig = {
				baseUrl: "https://api.petstore.com/v1",
				authType: "API_KEY",
				authValue: "my-api-key",
				authLocation: "HEADER",
				authKey: "X-API-Key",
			};

			await executeOpenAPITool({
				tool: sampleTool,
				config,
				arguments: { petId: "123" },
			});

			expect(mockFetch).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headers: expect.objectContaining({
						"X-API-Key": "my-api-key",
					}),
				}),
			);
		});

		it("should add Bearer token for BEARER auth", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ id: "123" }),
				headers: new Headers({ "content-type": "application/json" }),
			});

			const { executeOpenAPITool } = await import("../src/lib/executor");
			const config: ToolExecutionConfig = {
				baseUrl: "https://api.petstore.com/v1",
				authType: "BEARER",
				authValue: "my-jwt-token",
			};

			await executeOpenAPITool({
				tool: sampleTool,
				config,
				arguments: { petId: "123" },
			});

			expect(mockFetch).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headers: expect.objectContaining({
						Authorization: "Bearer my-jwt-token",
					}),
				}),
			);
		});

		it("should send request body for POST requests", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 201,
				json: async () => ({ id: "new-pet", name: "Buddy" }),
				headers: new Headers({ "content-type": "application/json" }),
			});

			const { executeOpenAPITool } = await import("../src/lib/executor");
			const config: ToolExecutionConfig = {
				baseUrl: "https://api.petstore.com/v1",
				authType: "NONE",
			};

			await executeOpenAPITool({
				tool: postTool,
				config,
				arguments: { name: "Buddy", species: "dog" },
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.petstore.com/v1/pets",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ name: "Buddy", species: "dog" }),
					headers: expect.objectContaining({
						"Content-Type": "application/json",
					}),
				}),
			);
		});

		it("should add custom headers from headerParams", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ id: "123" }),
				headers: new Headers({ "content-type": "application/json" }),
			});

			const { executeOpenAPITool } = await import("../src/lib/executor");
			const config: ToolExecutionConfig = {
				baseUrl: "https://api.petstore.com/v1",
				authType: "NONE",
			};

			await executeOpenAPITool({
				tool: sampleTool,
				config,
				arguments: { petId: "123", "X-Request-ID": "req-456" },
			});

			expect(mockFetch).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headers: expect.objectContaining({
						"X-Request-ID": "req-456",
					}),
				}),
			);
		});

		it("should handle HTTP errors gracefully", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 404,
				statusText: "Not Found",
				text: async () => "Pet not found",
				headers: new Headers({ "content-type": "text/plain" }),
			});

			const { executeOpenAPITool } = await import("../src/lib/executor");
			const config: ToolExecutionConfig = {
				baseUrl: "https://api.petstore.com/v1",
				authType: "NONE",
			};

			const result = await executeOpenAPITool({
				tool: sampleTool,
				config,
				arguments: { petId: "999" },
			});

			expect(result.success).toBe(false);
			expect(result.statusCode).toBe(404);
			expect(result.error).toContain("404");
		});

		it("should handle network errors", async () => {
			mockFetch.mockRejectedValueOnce(new Error("Network error"));

			const { executeOpenAPITool } = await import("../src/lib/executor");
			const config: ToolExecutionConfig = {
				baseUrl: "https://api.petstore.com/v1",
				authType: "NONE",
			};

			const result = await executeOpenAPITool({
				tool: sampleTool,
				config,
				arguments: { petId: "123" },
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("Network error");
		});

		it("should add Basic auth header", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ id: "123" }),
				headers: new Headers({ "content-type": "application/json" }),
			});

			const { executeOpenAPITool } = await import("../src/lib/executor");
			const config: ToolExecutionConfig = {
				baseUrl: "https://api.petstore.com/v1",
				authType: "BASIC",
				authValue: "dXNlcjpwYXNz", // base64 of "user:pass"
			};

			await executeOpenAPITool({
				tool: sampleTool,
				config,
				arguments: { petId: "123" },
			});

			expect(mockFetch).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headers: expect.objectContaining({
						Authorization: "Basic dXNlcjpwYXNz",
					}),
				}),
			);
		});

		it("should add API key to query string when authLocation is QUERY", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ id: "123" }),
				headers: new Headers({ "content-type": "application/json" }),
			});

			const { executeOpenAPITool } = await import("../src/lib/executor");
			const config: ToolExecutionConfig = {
				baseUrl: "https://api.petstore.com/v1",
				authType: "API_KEY",
				authValue: "my-api-key",
				authLocation: "QUERY",
				authKey: "api_key",
			};

			await executeOpenAPITool({
				tool: sampleTool,
				config,
				arguments: { petId: "123" },
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.petstore.com/v1/pets/123?api_key=my-api-key",
				expect.any(Object),
			);
		});
	});
});
