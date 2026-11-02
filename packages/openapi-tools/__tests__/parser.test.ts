/**
 * Tests for OpenAPI Spec Parser
 */

import SwaggerParser from "@apidevtools/swagger-parser";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch;
const mockPinnedFetch = vi.fn();
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

beforeEach(() => {
	mockFetch.mockClear();
	mockPinnedFetch.mockReset();
});

describe("OpenAPI Parser", () => {
	describe("parseOpenAPISpec", () => {
		it("parses fetched content without asking SwaggerParser to fetch the URL", async () => {
			mockPinnedFetch.mockResolvedValueOnce(
				new Response(JSON.stringify(sampleOpenAPISpec), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
			const parseSpy = vi.spyOn(SwaggerParser, "parse");
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			const result = await parseOpenAPISpec(
				"https://api.example.com/openapi.json",
			);
			expect(result.title).toBe("Pet Store API");
			expect(mockPinnedFetch).toHaveBeenCalledTimes(1);
			expect(parseSpy).toHaveBeenCalledWith(
				expect.objectContaining({ openapi: "3.0.3" }),
				expect.any(Object),
			);
			expect(mockFetch).not.toHaveBeenCalled();
			expect(mockPinnedFetch).toHaveBeenCalledWith(
				"https://api.example.com/openapi.json",
				expect.any(Object),
				expect.objectContaining({
					maxBytes: 25 * 1024 * 1024,
					timeoutMs: 30_000,
				}),
			);
			parseSpy.mockRestore();
		});

		it("keeps parser file and HTTP resolvers disabled", async () => {
			const parseSpy = vi.spyOn(SwaggerParser, "parse");
			const dereferenceSpy = vi.spyOn(SwaggerParser, "dereference");
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			await parseOpenAPISpec(JSON.stringify(sampleOpenAPISpec), {
				isUrl: false,
			});
			const resolvers = {
				resolve: { external: false, file: false, http: false },
			};
			expect(parseSpy).toHaveBeenCalledWith(
				expect.any(Object),
				resolvers,
			);
			expect(dereferenceSpy).toHaveBeenCalledWith(
				expect.any(Object),
				resolvers,
			);
			parseSpy.mockRestore();
			dereferenceSpy.mockRestore();
		});

		it("follows a public spec redirect through the pinned guard", async () => {
			mockPinnedFetch.mockImplementationOnce(
				async (
					_url: string,
					_init?: RequestInit,
					options?: { followRedirects?: boolean },
				) =>
					options?.followRedirects === false
						? new Response(null, {
								status: 302,
								headers: {
									location:
										"https://media.example.com/openapi.json",
								},
							})
						: new Response(JSON.stringify(sampleOpenAPISpec), {
								status: 200,
								headers: { "content-type": "application/json" },
							}),
			);
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			const result = await parseOpenAPISpec(
				"https://redirect.example.com/openapi.json",
			);
			expect(result.title).toBe("Pet Store API");
			expect(mockPinnedFetch).toHaveBeenCalledOnce();
		});

		it("refuses a redirect from a public spec URL to a private address", async () => {
			const { UnsafeOutboundUrlError } = await import(
				"@repo/utils/url-security"
			);
			mockPinnedFetch.mockImplementationOnce(
				async (
					_url: string,
					_init?: RequestInit,
					options?: { followRedirects?: boolean },
				) => {
					if (options?.followRedirects === false) {
						return new Response(null, {
							status: 302,
							headers: { location: "http://10.0.0.1/private" },
						});
					}
					throw new UnsafeOutboundUrlError("Private redirect target");
				},
			);
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			await expect(
				parseOpenAPISpec("https://redirect.example.com/openapi.json"),
			).rejects.toThrow(
				"OpenAPI spec URL is not a permitted public address",
			);
			expect(mockPinnedFetch).toHaveBeenCalledOnce();
		});

		it.each([
			"application/json",
			"application/yaml",
			"application/x-yaml",
			"text/yaml",
			"text/plain",
			"application/vnd.oai.openapi+json",
			"application/vnd.oai.openapi",
			"application/octet-stream",
			"text/x-yaml",
		])(
			"accepts a public spec served as %s with charset",
			async (mediaType) => {
				mockPinnedFetch.mockImplementationOnce(
					async (
						_url: string,
						_init?: RequestInit,
						options?: { allowedContentTypes?: string[] },
					) => {
						if (
							!options?.allowedContentTypes?.includes(mediaType)
						) {
							throw new Error("Content type not allowed");
						}
						return new Response(JSON.stringify(sampleOpenAPISpec), {
							status: 200,
							headers: {
								"content-type": `${mediaType}; charset=utf-8`,
							},
						});
					},
				);
				const { parseOpenAPISpec } = await import("../src/lib/parser");
				const result = await parseOpenAPISpec(
					"https://media.example.com/openapi.json",
				);
				expect(result.title).toBe("Pet Store API");
			},
		);

		it("accepts a public spec larger than the guard's 5 MB default", async () => {
			const largeSpec = structuredClone(sampleOpenAPISpec);
			largeSpec.info.description = "x".repeat(6 * 1024 * 1024);
			mockPinnedFetch.mockImplementationOnce(
				async (
					_url: string,
					_init?: RequestInit,
					options?: { maxBytes?: number },
				) => {
					if (
						(options?.maxBytes ?? 5 * 1024 * 1024) <
						6 * 1024 * 1024
					) {
						throw new Error("Response too large");
					}
					return new Response(JSON.stringify(largeSpec), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				},
			);
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			const result = await parseOpenAPISpec(
				"https://media.example.com/large.json",
			);
			expect(result.description?.length).toBe(6 * 1024 * 1024);
		});

		it("keeps an unquoted YAML version date as a string", async () => {
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			const result = await parseOpenAPISpec(
				"openapi: 3.0.3\ninfo:\n  title: Example API\n  version: 2024-01-15\npaths: {}\n",
				{ isUrl: false },
			);
			expect(result.version).toBe("2024-01-15");
		});

		it("accepts JSON with a duplicate key using the final value", async () => {
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			const result = await parseOpenAPISpec(
				'{"openapi":"3.0.3","info":{"title":"Example API","version":"1.0.0","version":"2.0.0"},"paths":{}}',
				{ isUrl: false },
			);
			expect(result.version).toBe("2.0.0");
		});

		it("refuses a YAML alias expansion bomb", async () => {
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			const bomb = [
				"a: &a [x, x, x, x, x, x, x, x, x, x]",
				"b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
				"c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
				"d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]",
				"e: [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]",
			].join("\n");
			await expect(
				parseOpenAPISpec(bomb, { isUrl: false }),
			).rejects.toThrow(/alias/i);
		});

		it("allows a schema property literally named $ref", async () => {
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			const spec = structuredClone(sampleOpenAPISpec);
			Object.assign(spec.components, {
				schemas: {
					Example: {
						type: "object",
						properties: { $ref: { type: "string" } },
					},
				},
			});
			await expect(
				parseOpenAPISpec(JSON.stringify(spec), { isUrl: false }),
			).resolves.toMatchObject({ title: "Pet Store API" });
		});
		it.each(["/etc/passwd", "http://internal.example.com/schema.json"])(
			"refuses external reference %s before the parser can resolve it",
			async (reference) => {
				const parseSpy = vi.spyOn(SwaggerParser, "parse");
				const dereferenceSpy = vi.spyOn(SwaggerParser, "dereference");
				const { parseOpenAPISpec } = await import("../src/lib/parser");
				const spec = structuredClone(sampleOpenAPISpec);
				Object.assign(spec.paths["/pets"].get.parameters[0].schema, {
					$ref: reference,
				});
				await expect(
					parseOpenAPISpec(JSON.stringify(spec), { isUrl: false }),
				).rejects.toThrow(
					"External OpenAPI references are not supported",
				);
				expect(parseSpy).not.toHaveBeenCalled();
				expect(dereferenceSpy).not.toHaveBeenCalled();
				expect(mockFetch).not.toHaveBeenCalled();
				parseSpy.mockRestore();
				dereferenceSpy.mockRestore();
			},
		);

		it.each([
			"http://127.0.0.1/openapi.json",
			"http://10.0.0.1/openapi.json",
		])(
			"refuses a private spec URL without a request: %s",
			async (specUrl) => {
				const { parseOpenAPISpec } = await import("../src/lib/parser");
				await expect(parseOpenAPISpec(specUrl)).rejects.toThrow(
					"not a permitted public address",
				);
				expect(mockFetch).not.toHaveBeenCalled();
			},
		);

		it("resolves an internal reference", async () => {
			const { parseOpenAPISpec } = await import("../src/lib/parser");
			const spec = structuredClone(sampleOpenAPISpec);
			Object.assign(spec.components, {
				schemas: { Limit: { type: "integer" } },
			});
			Object.assign(spec.paths["/pets"].get.parameters[0].schema, {
				$ref: "#/components/schemas/Limit",
			});
			const result = await parseOpenAPISpec(JSON.stringify(spec), {
				isUrl: false,
			});
			expect(result.tools[0].queryParams[0].schema).toMatchObject({
				type: "integer",
			});
		});
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
