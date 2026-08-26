import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	chunkProjectContent,
	detectTextChunkingStrategy,
	routeContentForChunking,
} from "../content-routing";
import { chunkOpenApiSpec, type OpenApiChunk } from "../openapi-chunker";

const { mockIsFeatureEnabled } = vi.hoisted(() => ({
	mockIsFeatureEnabled: vi.fn(),
}));

// The gate is the DB-backed toggle, not an env var: an admin flips
// OPENAPI_SPEC_CONTEXT in the console and a running worker picks it up. Mocking
// the reader is what lets a unit test say "flag off" without a database.
vi.mock("@repo/database", () => ({
	isFeatureEnabled: mockIsFeatureEnabled,
}));

const SPEC = JSON.stringify({
	openapi: "3.0.0",
	info: { title: "Billing API", version: "4.0.0" },
	components: {
		schemas: {
			Charge: {
				type: "object",
				required: ["id"],
				properties: {
					id: { type: "string" },
					amount: { type: "integer" },
				},
			},
		},
	},
	paths: {
		"/charges": {
			get: {
				operationId: "listCharges",
				summary: "List charges",
				tags: ["charges"],
				responses: {
					"200": {
						description: "ok",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/Charge" },
							},
						},
					},
					"401": { description: "unauthorized" },
				},
			},
			post: {
				operationId: "createCharge",
				summary: "Create a charge",
				responses: { "201": { description: "created" } },
			},
		},
		"/charges/{id}": {
			delete: {
				operationId: "voidCharge",
				responses: {
					"204": { description: "gone" },
					"409": { description: "settled" },
				},
			},
		},
	},
});

/** Big enough that character-window chunking would definitely kick in. */
const NON_SPEC_JSON = JSON.stringify({
	name: "some-package",
	description: "x".repeat(5000),
});

describe("chunkOpenApiSpec", () => {
	const chunks = chunkOpenApiSpec(SPEC, "billing.json");

	it("emits one summary chunk, one per operation, one per model", () => {
		const kinds = chunks.map((c) => c.specMetadata.kind);
		expect(kinds.filter((k) => k === "summary")).toHaveLength(1);
		expect(kinds.filter((k) => k === "operation")).toHaveLength(3);
		expect(kinds.filter((k) => k === "model")).toHaveLength(1);
	});

	it("puts the summary first so a broad question can match it", () => {
		expect(chunks[0]?.specMetadata.kind).toBe("summary");
		expect(chunks[0]?.content).toContain("Endpoints (3)");
	});

	it("tags each operation chunk with its method, path and operationId", () => {
		const operations = chunks.filter(
			(c) => c.specMetadata.kind === "operation",
		);
		const del = operations.find(
			(c) => c.specMetadata.operationId === "voidCharge",
		);
		expect(del?.specMetadata.httpMethod).toBe("DELETE");
		expect(del?.specMetadata.path).toBe("/charges/{id}");
	});

	it("stamps every chunk with the source spec so multi-spec projects stay distinguishable", () => {
		// Two APIs in one project is the legacy-to-new integration case; without
		// this an answer cannot say which system an endpoint belongs to.
		for (const chunk of chunks) {
			expect(chunk.specMetadata.specTitle).toBe("Billing API");
			expect(chunk.specMetadata.specVersion).toBe("4.0.0");
		}
	});

	it("keeps an operation whole rather than splitting it mid-definition", () => {
		const listCharges = chunks.find(
			(c) => c.specMetadata.operationId === "listCharges",
		);
		expect(listCharges?.content).toContain("GET /charges");
		expect(listCharges?.content).toContain("**200**");
		expect(listCharges?.content).toContain("**401**");
	});

	it("respects the chunk ceiling even when one line is enormous", () => {
		// Splitting only at line boundaries left a 40,000-character single-line
		// description whole in one chunk — 6.7x the ceiling, and past the
		// embedding layer's own per-input limit, where it would be silently
		// diluted across a recombined vector. Descriptions are very often one
		// unbroken line, so this is the common case, not a pathological one.
		const oneLongLine = JSON.stringify({
			openapi: "3.0.0",
			info: { title: "T", version: "1" },
			paths: {
				"/x": {
					get: {
						operationId: "getX",
						description: "z".repeat(40000),
						responses: { "200": { description: "ok" } },
					},
				},
			},
		});
		const chunks = chunkOpenApiSpec(oneLongLine, "x.json", {
			maxChunkChars: 6000,
		});
		for (const chunk of chunks) {
			expect(chunk.content.length).toBeLessThanOrEqual(6000);
		}
		// And nothing was dropped on the way.
		const recovered = chunks
			.filter((c) => c.specMetadata.operationId === "getX")
			.map((c) => c.content)
			.join("");
		expect((recovered.match(/z/g) ?? []).length).toBe(40000);
	});

	it("bounds the repeated header, which is user-supplied", () => {
		// The continuation header is built from `info.title` and a path, neither
		// length-checked. Re-emitting it in full on every part turned a 29 KB
		// rendering into 1.9 MB across 94 parts, each one over the ceiling.
		const hugeTitle = JSON.stringify({
			openapi: "3.0.0",
			info: { title: "T".repeat(20000), version: "1" },
			paths: {
				"/x": {
					get: {
						operationId: "getX",
						description: "d".repeat(9000),
						responses: { "200": { description: "ok" } },
					},
				},
			},
		});
		const chunks = chunkOpenApiSpec(hugeTitle, "x.json", {
			maxChunkChars: 6000,
		});
		for (const chunk of chunks) {
			expect(chunk.content.length).toBeLessThanOrEqual(6000);
		}
		// And the output stays proportional to the input rather than exploding.
		const total = chunks.reduce((sum, c) => sum + c.content.length, 0);
		expect(total).toBeLessThan(hugeTitle.length * 3);
	});

	it("does not recurse forever on a self-referential model", () => {
		// Models are recorded by name rather than dereferenced, so a $ref cycle
		// is inert — this pins that property, because switching to dereferencing
		// would blow the stack here.
		const cyclic = JSON.stringify({
			openapi: "3.0.0",
			info: { title: "T", version: "1" },
			paths: {
				"/y": {
					get: {
						operationId: "getY",
						responses: {
							"200": {
								description: "ok",
								content: {
									"application/json": {
										schema: {
											$ref: "#/components/schemas/Node",
										},
									},
								},
							},
						},
					},
				},
			},
			components: {
				schemas: {
					Node: {
						type: "object",
						properties: {
							child: { $ref: "#/components/schemas/Node" },
						},
					},
				},
			},
		});
		expect(() => chunkOpenApiSpec(cyclic, "y.json")).not.toThrow();
	});

	it("splits an oversized operation instead of truncating it", () => {
		// Same rule the embedding layer follows: never silently drop text the
		// caller believed was indexed.
		const wordy = JSON.stringify({
			openapi: "3.0.0",
			info: { title: "Wordy", version: "1" },
			paths: {
				"/x": {
					get: {
						operationId: "getX",
						description: "d".repeat(9000),
						responses: { "200": { description: "ok" } },
					},
				},
			},
		});
		const wordyChunks = chunkOpenApiSpec(wordy, "wordy.json");
		const parts = wordyChunks.filter(
			(c) => c.specMetadata.operationId === "getX",
		);
		expect(parts.length).toBeGreaterThan(1);
		expect(parts[0]?.specMetadata.partCount).toBe(parts.length);
		// Every character survives somewhere.
		const combined = parts.map((p) => p.content).join("");
		expect(combined).toContain("d".repeat(500));
	});
});

describe("routeContentForChunking", () => {
	beforeEach(() => {
		mockIsFeatureEnabled.mockReset();
		mockIsFeatureEnabled.mockResolvedValue(true);
	});

	it("routes a detected spec to the openapi chunker", async () => {
		const route = await routeContentForChunking({
			content: SPEC,
			mimeType: "application/json",
			filename: "billing.json",
		});
		expect(route.kind).toBe("openapi");
		if (route.kind !== "openapi") {
			throw new Error("expected the openapi route");
		}
		expect(route.specVersion).toBe("3.0.0");
		// The route carries the parsed document so nothing downstream re-parses
		// it — the ingestion path used to parse the same spec three times.
		expect(route.description.title).toBe("Billing API");
		expect(route.description.operations).toHaveLength(3);
	});

	it("leaves ordinary JSON on the text route", async () => {
		const route = await routeContentForChunking({
			content: NON_SPEC_JSON,
			mimeType: "application/json",
			filename: "package.json",
		});
		expect(route.kind).toBe("text");
	});

	it("reports a malformed spec rather than chunking it as prose", async () => {
		const route = await routeContentForChunking({
			content: JSON.stringify({ openapi: "3.0.0", info: { title: "x" } }),
			mimeType: "application/json",
			filename: "broken.json",
		});
		expect(route.kind).toBe("malformed-openapi");
	});

	it("does not pay detection cost for content that cannot be a spec", async () => {
		const route = await routeContentForChunking({
			content: SPEC,
			mimeType: "application/pdf",
			filename: "report.pdf",
		});
		expect(route.kind).toBe("text");
	});

	it("detects by extension when the MIME type is unhelpful", async () => {
		// Paste and drop routinely deliver an empty `File.type`.
		const route = await routeContentForChunking({
			content: SPEC,
			mimeType: "",
			filename: "openapi.yaml",
		});
		expect(route.kind).toBe("openapi");
	});

	it("falls back to today's behaviour when the flag is off", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);
		const route = await routeContentForChunking({
			content: SPEC,
			mimeType: "application/json",
			filename: "billing.json",
		});
		// Rollback is a flag flip: a spec is chunked exactly as it was before.
		expect(route).toEqual({ kind: "text", strategy: "RECURSIVE" });
	});
});

describe("detectTextChunkingStrategy", () => {
	it("preserves the pre-existing MIME mapping exactly", () => {
		// This is the fallback for every non-spec format; changing it would
		// silently re-chunk every other context type.
		expect(detectTextChunkingStrategy("text/markdown")).toBe("DOCUMENT");
		expect(detectTextChunkingStrategy("text/plain")).toBe("DOCUMENT");
		expect(detectTextChunkingStrategy("text/html")).toBe("DOCUMENT");
		expect(detectTextChunkingStrategy("application/pdf")).toBe("PARAGRAPH");
		expect(
			detectTextChunkingStrategy(
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			),
		).toBe("PARAGRAPH");
		expect(detectTextChunkingStrategy("application/json")).toBe(
			"RECURSIVE",
		);
	});
});

describe("chunkProjectContent", () => {
	beforeEach(() => {
		mockIsFeatureEnabled.mockReset();
		mockIsFeatureEnabled.mockResolvedValue(true);
	});

	it("returns spec chunks with payloads and an API_SPEC type override", async () => {
		const result = await chunkProjectContent({
			content: SPEC,
			mimeType: "application/json",
			filename: "billing.json",
		});
		expect(result.contextTypeOverride).toBe("API_SPEC");
		expect(result.chunks.length).toBe(5);
		expect(result.chunkPayloads).toHaveLength(result.chunks.length);

		const operationIndex = result.chunks.findIndex(
			(c) =>
				(c as OpenApiChunk).specMetadata?.operationId === "voidCharge",
		);
		expect(result.chunkPayloads[operationIndex]).toMatchObject({
			specTitle: "Billing API",
			httpMethod: "DELETE",
			path: "/charges/{id}",
			operationId: "voidCharge",
			specChunkKind: "operation",
		});
	});

	it("returns no chunks for a malformed spec so the caller must surface it", async () => {
		const result = await chunkProjectContent({
			content: JSON.stringify({ swagger: "2.0", info: { title: "x" } }),
			mimeType: "application/json",
			filename: "broken.json",
		});
		expect(result.route.kind).toBe("malformed-openapi");
		expect(result.chunks).toHaveLength(0);
	});

	it("leaves small non-spec content as a single unchunked entry", async () => {
		const result = await chunkProjectContent({
			content: "a short note",
			mimeType: "text/plain",
			filename: "note.txt",
		});
		expect(result.chunks).toHaveLength(1);
		expect(result.contextTypeOverride).toBeUndefined();
		expect(result.chunkPayloads[0]).toEqual({});
	});

	it("character-chunks large non-spec content as before", async () => {
		const result = await chunkProjectContent({
			content: NON_SPEC_JSON,
			mimeType: "application/json",
			filename: "package.json",
		});
		expect(result.route.kind).toBe("text");
		expect(result.chunks.length).toBeGreaterThan(1);
		expect(result.contextTypeOverride).toBeUndefined();
	});
});
