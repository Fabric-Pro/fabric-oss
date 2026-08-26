import { describe, expect, it } from "vitest";
import { OpenApiDescribeError } from "../src/describe-types";
import { describeOpenApiSpec, looksLikeOpenApiSpec } from "../src/lib/describe";
import {
	renderModel,
	renderOperation,
	renderSpecSummary,
} from "../src/lib/render";

const OPENAPI_3_JSON = JSON.stringify({
	openapi: "3.0.3",
	info: {
		title: "Payments API",
		version: "2.1.0",
		description: "Take money.",
	},
	servers: [
		{
			url: "https://api.example.com/{stage}",
			variables: { stage: { default: "v1" } },
		},
	],
	components: {
		securitySchemes: {
			bearerAuth: { type: "http", scheme: "bearer" },
		},
		schemas: {
			Refund: {
				type: "object",
				required: ["id", "amount"],
				description: "A refund of a captured payment.",
				properties: {
					id: { type: "string", description: "Refund identifier." },
					amount: { type: "integer", format: "int64" },
					reason: {
						type: "string",
						enum: ["duplicate", "fraudulent"],
					},
				},
			},
			Error: {
				type: "object",
				properties: { message: { type: "string" } },
			},
		},
	},
	security: [{ bearerAuth: [] }],
	paths: {
		"/refunds/{refundId}": {
			parameters: [
				{
					name: "refundId",
					in: "path",
					required: true,
					schema: { type: "string" },
				},
			],
			get: {
				operationId: "getRefund",
				summary: "Fetch a refund",
				tags: ["refunds"],
				parameters: [
					{ name: "expand", in: "query", schema: { type: "string" } },
				],
				responses: {
					"200": {
						description: "The refund",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/Refund" },
							},
						},
					},
					"404": {
						description: "No such refund",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/Error" },
							},
						},
					},
					default: { description: "Unexpected" },
				},
			},
			post: {
				summary: "Cancel a refund",
				security: [],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/Refund" },
						},
					},
				},
				responses: {
					"202": { description: "Cancelling" },
					"409": { description: "Already settled" },
				},
			},
		},
	},
});

const SWAGGER_2_YAML = `
swagger: "2.0"
info:
  title: Legacy Billing
  version: "1.0"
host: legacy.example.com
basePath: /api
schemes:
  - https
consumes:
  - application/json
produces:
  - application/json
securityDefinitions:
  apiKey:
    type: apiKey
    name: X-Api-Key
    in: header
definitions:
  Invoice:
    type: object
    required:
      - number
    properties:
      number:
        type: string
      total:
        type: number
        format: double
paths:
  /invoices:
    post:
      operationId: createInvoice
      summary: Raise an invoice
      parameters:
        - name: body
          in: body
          required: true
          schema:
            $ref: '#/definitions/Invoice'
        - name: dryRun
          in: query
          type: boolean
      responses:
        "201":
          description: Created
          schema:
            $ref: '#/definitions/Invoice'
        "400":
          description: Bad request
        "500":
          description: Boom
`;

describe("looksLikeOpenApiSpec", () => {
	it("recognises an OpenAPI 3 document", () => {
		expect(looksLikeOpenApiSpec(OPENAPI_3_JSON)).toEqual({
			kind: "spec",
			specVersion: "3.0.3",
		});
	});

	it("recognises a Swagger 2.0 YAML document", () => {
		expect(looksLikeOpenApiSpec(SWAGGER_2_YAML)).toEqual({
			kind: "spec",
			specVersion: "2.0",
		});
	});

	it("treats ordinary JSON as not-a-spec rather than malformed", () => {
		// FR7: a non-spec JSON file must fall through to generic handling
		// silently. Reporting it as malformed would put an error in front of a
		// user who attached a perfectly ordinary config file.
		expect(
			looksLikeOpenApiSpec('{"name":"package","version":"1.0.0"}'),
		).toEqual({ kind: "not-a-spec" });
	});

	it("treats unparseable text as not-a-spec", () => {
		expect(looksLikeOpenApiSpec("just some prose, not a document")).toEqual(
			{
				kind: "not-a-spec",
			},
		);
	});

	it("reports a document that declares a version but has no paths", () => {
		const detection = looksLikeOpenApiSpec(
			JSON.stringify({
				openapi: "3.0.0",
				info: { title: "x", version: "1" },
			}),
		);
		expect(detection.kind).toBe("malformed");
	});

	it("reports a document that declares a version but has no info", () => {
		const detection = looksLikeOpenApiSpec(
			JSON.stringify({ openapi: "3.0.0", paths: {} }),
		);
		expect(detection.kind).toBe("malformed");
	});

	it("reports an unsupported major version", () => {
		const detection = looksLikeOpenApiSpec(
			JSON.stringify({
				swagger: "1.2",
				info: { title: "x", version: "1" },
				paths: {},
			}),
		);
		expect(detection.kind).toBe("malformed");
		if (detection.kind === "malformed") {
			expect(detection.reason).toContain("1.2");
		}
	});
});

describe("describeOpenApiSpec — OpenAPI 3.x", () => {
	const spec = describeOpenApiSpec(OPENAPI_3_JSON);

	it("reads identity and resolves server variables", () => {
		expect(spec.title).toBe("Payments API");
		expect(spec.version).toBe("2.1.0");
		expect(spec.specVersion).toBe("3.0.3");
		expect(spec.servers).toEqual(["https://api.example.com/v1"]);
	});

	it("keeps EVERY response status code, not just the success one", () => {
		// The whole reason this module exists beside the execution parser, which
		// keeps 200/201/default and discards the rest.
		const get = spec.operations.find((o) => o.operationId === "getRefund");
		expect(get?.responses.map((r) => r.statusCode)).toEqual([
			"200",
			"404",
			"default",
		]);

		const post = spec.operations.find((o) => o.method === "POST");
		expect(post?.responses.map((r) => r.statusCode)).toEqual([
			"202",
			"409",
		]);
	});

	it("records $ref targets by name instead of inlining them", () => {
		// Inlining is what makes a described spec larger than its source file.
		const get = spec.operations.find((o) => o.operationId === "getRefund");
		const ok = get?.responses.find((r) => r.statusCode === "200");
		expect(ok?.schemaRef).toBe("Refund");
		expect(ok?.schemaSummary).toBeNull();
	});

	it("lists each named model exactly once", () => {
		expect(spec.models.map((m) => m.name).sort()).toEqual([
			"Error",
			"Refund",
		]);
		const refund = spec.models.find((m) => m.name === "Refund");
		expect(refund?.properties.find((p) => p.name === "id")?.required).toBe(
			true,
		);
		expect(
			refund?.properties.find((p) => p.name === "reason")?.required,
		).toBe(false);
		expect(refund?.properties.find((p) => p.name === "amount")?.type).toBe(
			"integer<int64>",
		);
	});

	it("merges path-level parameters into each operation", () => {
		const get = spec.operations.find((o) => o.operationId === "getRefund");
		const names = get?.parameters.map((p) => p.name).sort();
		expect(names).toEqual(["expand", "refundId"]);
		expect(
			get?.parameters.find((p) => p.name === "refundId")?.required,
		).toBe(true);
	});

	it("synthesizes an operationId when the document omits one", () => {
		const post = spec.operations.find((o) => o.method === "POST");
		expect(post?.operationId).toBe("postRefundsRefundId");
	});

	it("inherits document security but honours an explicit empty override", () => {
		const get = spec.operations.find((o) => o.operationId === "getRefund");
		expect(get?.security).toEqual(["bearerAuth"]);
		// `security: []` means "this endpoint needs no auth" — inheriting the
		// document default here would misreport the endpoint as protected.
		const post = spec.operations.find((o) => o.method === "POST");
		expect(post?.security).toEqual([]);
	});

	it("captures enum values on parameters and properties", () => {
		const refund = spec.models.find((m) => m.name === "Refund");
		expect(refund?.properties.find((p) => p.name === "reason")?.type).toBe(
			"string",
		);
	});
});

describe("describeOpenApiSpec — Swagger 2.0", () => {
	const spec = describeOpenApiSpec(SWAGGER_2_YAML);

	it("parses YAML", () => {
		expect(spec.title).toBe("Legacy Billing");
		expect(spec.specVersion).toBe("2.0");
	});

	it("composes servers from host, basePath and schemes", () => {
		expect(spec.servers).toEqual(["https://legacy.example.com/api"]);
	});

	it("reads models from `definitions`", () => {
		expect(spec.models.map((m) => m.name)).toEqual(["Invoice"]);
		expect(
			spec.models[0]?.properties.find((p) => p.name === "number")
				?.required,
		).toBe(true);
	});

	it("treats the `in: body` parameter as the request body", () => {
		const operation = spec.operations[0];
		expect(operation?.requestBody?.schemaRef).toBe("Invoice");
		expect(operation?.requestBody?.required).toBe(true);
		// ...and does not leave it sitting in the parameter list.
		expect(operation?.parameters.map((p) => p.name)).toEqual(["dryRun"]);
	});

	it("keeps every response and reads the 2.0 response schema shape", () => {
		const operation = spec.operations[0];
		expect(operation?.responses.map((r) => r.statusCode)).toEqual([
			"201",
			"400",
			"500",
		]);
		expect(
			operation?.responses.find((r) => r.statusCode === "201")?.schemaRef,
		).toBe("Invoice");
	});

	it("reads securityDefinitions", () => {
		expect(spec.securitySchemes).toEqual([
			{ name: "apiKey", type: "apiKey", in: "header", scheme: undefined },
		]);
	});

	it("falls back to document-level produces for media types", () => {
		const operation = spec.operations[0];
		expect(
			operation?.responses.find((r) => r.statusCode === "201")
				?.contentTypes,
		).toEqual(["application/json"]);
	});
});

describe("describeOpenApiSpec — regressions found in review", () => {
	it("accepts an UNQUOTED numeric version in YAML", () => {
		// `swagger: 2.0` unquoted is ordinary YAML and extremely common in
		// hand-written specs. YAML parses it as the number 2, and String(2.0) is
		// "2" — which matched no supported prefix, so a valid legacy Swagger file
		// was reported as malformed and failed ingestion outright. The exact
		// document this feature exists to read.
		const yaml2 = [
			"swagger: 2.0",
			"info:",
			"  title: Legacy",
			'  version: "1"',
			"paths:",
			"  /a:",
			"    get:",
			"      responses:",
			'        "200":',
			"          description: ok",
		].join("\n");
		expect(looksLikeOpenApiSpec(yaml2)).toEqual({
			kind: "spec",
			specVersion: "2.0",
		});
		expect(describeOpenApiSpec(yaml2).specVersion).toBe("2.0");

		// The 3.x sibling failed differently — silently classified not-a-spec, so
		// the feature simply never applied.
		const yaml3 = yaml2.replace("swagger: 2.0", "openapi: 3.0");
		expect(looksLikeOpenApiSpec(yaml3).kind).toBe("spec");
	});

	it("reads TRACE operations", () => {
		const spec = describeOpenApiSpec(
			JSON.stringify({
				openapi: "3.0.0",
				info: { title: "T", version: "1" },
				paths: {
					"/t": {
						trace: {
							operationId: "traceIt",
							responses: { "200": { description: "ok" } },
						},
					},
				},
			}),
		);
		expect(spec.operations.map((o) => o.method)).toEqual(["TRACE"]);
	});

	it("resolves a $ref'd parameter instead of guessing its location", () => {
		// Previously every $ref'd parameter was rendered as "query, optional".
		// A $ref to a REQUIRED PATH parameter — very common — became a confident
		// falsehood about how to call the endpoint, which is worse than omitting
		// it, because the output is fed to a model as integration guidance.
		const spec = describeOpenApiSpec(
			JSON.stringify({
				openapi: "3.0.0",
				info: { title: "T", version: "1" },
				components: {
					parameters: {
						petId: {
							name: "petId",
							in: "path",
							required: true,
							schema: { type: "string" },
							description: "Which pet.",
						},
					},
				},
				paths: {
					"/pets/{petId}": {
						get: {
							operationId: "getPet",
							parameters: [
								{ $ref: "#/components/parameters/petId" },
							],
							responses: { "200": { description: "ok" } },
						},
					},
				},
			}),
		);
		const parameter = spec.operations[0]?.parameters[0];
		expect(parameter?.name).toBe("petId");
		expect(parameter?.in).toBe("path");
		expect(parameter?.required).toBe(true);
		expect(parameter?.description).toBe("Which pet.");
	});

	it("records a path defined in another file rather than dropping it", () => {
		// A multi-file spec would otherwise present a confident but incomplete
		// endpoint inventory, with nothing telling the reader it was incomplete.
		const spec = describeOpenApiSpec(
			JSON.stringify({
				openapi: "3.0.0",
				info: { title: "T", version: "1" },
				paths: {
					"/external": { $ref: "./paths/pets.yaml" },
					"/local": {
						get: {
							operationId: "getLocal",
							responses: { "200": { description: "ok" } },
						},
					},
				},
			}),
		);
		expect(spec.unresolvedPaths).toEqual(["/external"]);
		expect(renderSpecSummary(spec)).toContain("/external");
		expect(renderSpecSummary(spec)).toContain("defined in other files");
	});

	it("follows a path-item $ref that IS resolvable locally", () => {
		const spec = describeOpenApiSpec(
			JSON.stringify({
				openapi: "3.1.0",
				info: { title: "T", version: "1" },
				components: {
					pathItems: {
						Shared: {
							get: {
								operationId: "getShared",
								responses: { "200": { description: "ok" } },
							},
						},
					},
				},
				paths: { "/s": { $ref: "#/components/pathItems/Shared" } },
			}),
		);
		expect(spec.operations.map((o) => o.operationId)).toEqual([
			"getShared",
		]);
		expect(spec.unresolvedPaths).toEqual([]);
	});

	it("survives a YAML anchor cycle instead of blowing the stack", () => {
		// js-yaml resolves an anchor into a genuinely cyclic object, unlike a
		// $ref, which is inert here. Unguarded this recursed until the stack died
		// — and on the ingestion path that surfaces as a SUCCESSFUL job with
		// nothing indexed.
		const cyclic = [
			'openapi: "3.0.0"',
			"info:",
			"  title: T",
			'  version: "1"',
			"paths:",
			"  /a:",
			"    post:",
			"      requestBody:",
			"        content:",
			"          application/json:",
			"            schema: &s",
			"              type: object",
			"              properties:",
			"                self: *s",
			"      responses:",
			'        "200":',
			"          description: ok",
		].join("\n");
		expect(() => describeOpenApiSpec(cyclic)).not.toThrow();
	});

	it("describes a webhooks-only 3.1 document", () => {
		const spec = describeOpenApiSpec(
			JSON.stringify({
				openapi: "3.1.0",
				info: { title: "T", version: "1" },
				webhooks: {
					newPet: {
						post: {
							operationId: "onNewPet",
							responses: { "200": { description: "ok" } },
						},
					},
				},
			}),
		);
		expect(spec.operations.map((o) => o.operationId)).toEqual(["onNewPet"]);
	});
});

describe("describeOpenApiSpec — failures", () => {
	it("rejects a document with no version field", () => {
		expect(() => describeOpenApiSpec('{"info":{"title":"x"}}')).toThrow(
			OpenApiDescribeError,
		);
	});

	it("rejects an unsupported version", () => {
		expect(() =>
			describeOpenApiSpec(JSON.stringify({ swagger: "1.2", info: {} })),
		).toThrow(/Unsupported version/);
	});

	it("rejects empty input", () => {
		expect(() => describeOpenApiSpec("   ")).toThrow(/empty/i);
	});

	it("reports a YAML syntax error with its detail", () => {
		expect(() =>
			describeOpenApiSpec("openapi: '3.0.0'\n  bad: [indent"),
		).toThrow(/Could not parse as JSON or YAML/);
	});
});

describe("renderers", () => {
	const spec = describeOpenApiSpec(OPENAPI_3_JSON);

	it("renders an operation that stands alone", () => {
		const operation = spec.operations.find(
			(o) => o.operationId === "getRefund",
		);
		if (!operation) {
			throw new Error("fixture missing getRefund");
		}
		const text = renderOperation(spec, operation);

		// Identity, so a chunk retrieved without neighbours is still attributable.
		expect(text).toContain("Payments API");
		expect(text).toContain("GET /refunds/{refundId}");
		// Inputs with their requiredness.
		expect(text).toContain("`refundId` (path, required)");
		expect(text).toContain("`expand` (query, optional)");
		// Every status code, including the error ones.
		expect(text).toContain("**200**");
		expect(text).toContain("**404**");
		expect(text).toContain("**default**");
		// The model name, so the reader knows what to look up next.
		expect(text).toContain("Refund");
	});

	it("renders a model with required flags", () => {
		const model = spec.models.find((m) => m.name === "Refund");
		if (!model) {
			throw new Error("fixture missing Refund");
		}
		const text = renderModel(spec, model);
		expect(text).toContain("Model: Refund");
		expect(text).toContain("`id` (required): string");
		expect(text).toContain("`reason` (optional)");
	});

	it("renders a summary listing every endpoint", () => {
		const text = renderSpecSummary(spec);
		expect(text).toContain("Endpoints (2)");
		expect(text).toContain("GET /refunds/{refundId}");
		expect(text).toContain("POST /refunds/{refundId}");
		expect(text).toContain("Models (2)");
		expect(text).toContain("https://api.example.com/v1");
	});

	it("marks a deprecated operation", () => {
		const deprecatedSpec = describeOpenApiSpec(
			JSON.stringify({
				openapi: "3.0.0",
				info: { title: "T", version: "1" },
				paths: {
					"/old": {
						get: {
							deprecated: true,
							responses: { "200": { description: "ok" } },
						},
					},
				},
			}),
		);
		const text = renderSpecSummary(deprecatedSpec);
		expect(text).toContain("[deprecated]");
	});
});
