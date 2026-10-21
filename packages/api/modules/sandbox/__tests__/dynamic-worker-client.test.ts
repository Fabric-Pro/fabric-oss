import { decodeJwt } from "jose";
import { SandboxClient } from "@repo/sandbox";
import {
	DYNAMIC_CODE_LIMITS,
	ExecuteCodeRequestSchema,
	ExecuteCodePublicRequestSchema,
	readBoundedJson,
} from "@repo/sandbox/dynamic-worker";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("shared stateless sandbox client", () => {
	it("rejects execution metadata on the public request contract", () => {
		expect(
			ExecuteCodePublicRequestSchema.safeParse({
				code: "return null",
				language: "javascript",
				execution: {
					executionId: "forged",
					workflowId: "workflow",
					version: 1,
					triggerType: "SCHEDULE",
				},
			}).success,
		).toBe(false);
	});
	it("strips an initial UTF-8 BOM and rejects malformed UTF-8", async () => {
		const valid = new Response(
			new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
		);
		expect(await readBoundedJson(valid, 100)).toEqual({});
		const invalid = new Response(new Uint8Array([0x22, 0xc3, 0x28, 0x22]));
		await expect(readBoundedJson(invalid, 100)).rejects.toThrow();
	});
	it("compiles TypeScript on the server and preserves original source in the response", async () => {
		const code =
			"const count: number = inputs.source.length; return { count };";
		const fetchMock = vi.fn().mockResolvedValue(
			Response.json({
				success: true,
				data: {
					code: "compiled source",
					logs: [],
					results: [{ type: "json", json: { count: 2 } }],
					executionCount: 1,
					executionTime: 1,
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new SandboxClient({
			baseUrl: "https://sandbox.example.com",
			authSecret: "synthetic-test-secret",
		});
		const result = await client.executeCode(
			"owner",
			"example-org",
			ExecuteCodeRequestSchema.parse({
				code,
				language: "typescript",
				inputs: { source: [1, 2] },
				execution: {
					executionId: "execution",
					workflowId: "workflow",
					version: 3,
					triggerType: "MANUAL",
				},
			}),
		);
		const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(sent.language).toBe("javascript");
		expect(sent.code).not.toContain(": number");
		expect(sent.code).toContain(
			"return await __fabricTypedMain(inputs, execution)",
		);
		expect(sent.execution).toEqual({
			executionId: "execution",
			workflowId: "workflow",
			version: 3,
			triggerType: "MANUAL",
		});
		expect(sent.inputs).toEqual({ source: [1, 2] });
		expect(result.code).toBe(code);
	});
	it("uses the server actor for authentication and never sends a scope in script inputs", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			Response.json({
				success: true,
				data: {
					code: "return null",
					logs: [],
					results: [{ type: "json", json: null }],
					executionCount: 1,
					executionTime: 1,
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new SandboxClient({
			baseUrl: "https://sandbox.example.com",
			authSecret: "synthetic-test-secret",
		});
		await client.executeCode(
			"owner",
			"example-org",
			ExecuteCodeRequestSchema.parse({
				code: "return null",
				language: "javascript",
				inputs: { userId: "untrusted" },
			}),
		);
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe("https://sandbox.example.com/execute");
		expect(decodeJwt(options.headers.Authorization.slice(7))).toMatchObject(
			{ sub: "owner", org: "example-org" },
		);
		expect(JSON.parse(options.body)).not.toHaveProperty("authSecret");
	});

	it("refuses an oversized service response", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response(
						"x".repeat(DYNAMIC_CODE_LIMITS.responseBytes + 1),
					),
				),
		);
		const client = new SandboxClient({
			baseUrl: "https://sandbox.example.com",
			authSecret: "synthetic-test-secret",
		});
		await expect(
			client.executeCode(
				"owner",
				"example-org",
				ExecuteCodeRequestSchema.parse({
					code: "return null",
					language: "javascript",
				}),
			),
		).rejects.toThrow("size limit");
	});

	it("keeps HTTP 501 a visible failure rather than a successful empty result", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json(
					{
						success: false,
						error: { message: "Loader unavailable" },
					},
					{ status: 501 },
				),
			),
		);
		const client = new SandboxClient({
			baseUrl: "https://sandbox.example.com",
			authSecret: "synthetic-test-secret",
		});
		await expect(
			client.executeCode(
				"owner",
				"example-org",
				ExecuteCodeRequestSchema.parse({
					code: "return null",
					language: "javascript",
				}),
			),
		).rejects.toThrow("Loader unavailable");
	});
});
