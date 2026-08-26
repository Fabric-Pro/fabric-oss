/**
 * Tests for OpenAPI Spec Parser
 */

import { describe, expect, it, vi } from "vitest";

// Mock the logger
vi.mock("@repo/logs", () => ({
	logger: {
		error: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

// Sample OpenAPI spec for testing
const sampleOpenAPISpec = {
	openapi: "3.0.3",
	info: {
		title: "Pet Store API",
		description: "A sample API for testing",
		version: "1.0.0",
	},
	servers: [{ url: "https://api.petstore.com/v1" }],
	paths: {
		"/pets": {
			get: {
				operationId: "listPets",
				summary: "List all pets",
				description: "Returns a list of all pets",
				parameters: [
					{
						name: "limit",
						in: "query",
						required: false,
						schema: { type: "integer" },
					},
					{
						name: "status",
						in: "query",
						required: false,
						schema: { type: "string" },
					},
				],
				responses: { 200: { description: "OK" } },
			},
			post: {
				operationId: "createPet",
				summary: "Create a pet",
				requestBody: {
					required: true,
					content: {
						"application/json": { schema: { type: "object" } },
					},
				},
				responses: { 201: { description: "Created" } },
			},
		},
		"/pets/{petId}": {
			get: {
				operationId: "getPetById",
				summary: "Get a pet by ID",
				parameters: [
					{
						name: "petId",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
				],
				responses: { 200: { description: "OK" } },
			},
			delete: {
				operationId: "deletePet",
				summary: "Delete a pet",
				parameters: [
					{
						name: "petId",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "X-Request-ID",
						in: "header",
						required: false,
						schema: { type: "string" },
					},
				],
				responses: { 204: { description: "Deleted" } },
			},
		},
	},
	components: {
		securitySchemes: {
			apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
			bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
		},
	},
};

describe("OpenAPI Parser", () => {
	describe("parseOpenAPISpec", () => {
		it("should parse a valid OpenAPI 3.x spec from content", async () => {
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			const result = await parseOpenAPISpec(
				JSON.stringify(sampleOpenAPISpec),
				{ isUrl: false },
			);

			expect(result.title).toBe("Pet Store API");
			expect(result.description).toBe("A sample API for testing");
			expect(result.version).toBe("1.0.0");
			expect(result.baseUrl).toBe("https://api.petstore.com/v1");
		});

		it("should extract tools from paths", async () => {
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			const result = await parseOpenAPISpec(
				JSON.stringify(sampleOpenAPISpec),
				{ isUrl: false },
			);

			expect(result.tools.length).toBe(4);
			const listPets = result.tools.find(
				(t) => t.operationId === "listPets",
			);
			expect(listPets).toBeDefined();
			expect(listPets?.method).toBe("GET");
			expect(listPets?.path).toBe("/pets");
		});

		it("should extract path parameters", async () => {
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			const result = await parseOpenAPISpec(
				JSON.stringify(sampleOpenAPISpec),
				{ isUrl: false },
			);

			const getPetById = result.tools.find(
				(t) => t.operationId === "getPetById",
			);
			expect(getPetById?.pathParams.length).toBe(1);
			expect(getPetById?.pathParams[0].name).toBe("petId");
			expect(getPetById?.pathParams[0].required).toBe(true);
		});

		it("should extract query parameters", async () => {
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			const result = await parseOpenAPISpec(
				JSON.stringify(sampleOpenAPISpec),
				{ isUrl: false },
			);

			const listPets = result.tools.find(
				(t) => t.operationId === "listPets",
			);
			expect(listPets?.queryParams.length).toBe(2);
		});

		it("should extract header parameters", async () => {
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			const result = await parseOpenAPISpec(
				JSON.stringify(sampleOpenAPISpec),
				{ isUrl: false },
			);

			const deletePet = result.tools.find(
				(t) => t.operationId === "deletePet",
			);
			expect(deletePet?.headerParams.length).toBe(1);
			expect(deletePet?.headerParams[0].name).toBe("X-Request-ID");
		});

		it("should extract authentication schemes", async () => {
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			const result = await parseOpenAPISpec(
				JSON.stringify(sampleOpenAPISpec),
				{ isUrl: false },
			);

			expect(result.authSchemes.length).toBe(2);
			const apiKeyScheme = result.authSchemes.find(
				(s) => s.name === "apiKey",
			);
			expect(apiKeyScheme?.type).toBe("apiKey");
			expect(apiKeyScheme?.in).toBe("header");
		});

		it("should generate spec hash", async () => {
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			const result = await parseOpenAPISpec(
				JSON.stringify(sampleOpenAPISpec),
				{ isUrl: false },
			);

			expect(result.specHash).toBeDefined();
			expect(result.specHash.length).toBe(16);
		});
	});

	describe("validateToolInput", () => {
		it("should validate required path parameters", async () => {
			const { parseOpenAPISpec, validateToolInput } = await import(
				"../src/lib/parser"
			);
			const result = await parseOpenAPISpec(
				JSON.stringify(sampleOpenAPISpec),
				{ isUrl: false },
			);
			// biome-ignore lint/style/noNonNullAssertion: test assertion — getPetById must exist in the parsed result
			const getPetById = result.tools.find(
				(t) => t.operationId === "getPetById",
			)!;

			const validation1 = validateToolInput(getPetById, {});
			expect(validation1.valid).toBe(false);
			expect(validation1.errors).toContain(
				"Missing required path parameter: petId",
			);

			const validation2 = validateToolInput(getPetById, { petId: "123" });
			expect(validation2.valid).toBe(true);
		});
	});
});
