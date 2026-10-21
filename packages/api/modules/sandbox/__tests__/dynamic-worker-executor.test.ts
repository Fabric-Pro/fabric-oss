import { runInNewContext } from "node:vm";
import { SandboxClient } from "@repo/sandbox";
import {
	DYNAMIC_CODE_LIMITS,
	ExecuteCodeRequestSchema,
	type DynamicCodeLoader,
} from "@repo/sandbox/dynamic-worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeDynamicWorkerCode } from "../../../../../services/sandbox-worker/src/dynamic-worker-executor";

function simulatedWorkerLoader() {
	const load = vi.fn<DynamicCodeLoader["load"]>((config) => {
		const source = config.modules["script.js"].replace(
			"export default",
			"globalThis.handler =",
		);
		const context = { Request, Response, TextEncoder };
		const handler = runInNewContext(`${source}; handler`, context);
		return {
			getEntrypoint: () => ({
				fetch: (request) => handler.fetch(request),
			}),
		};
	});
	return { load };
}

const input = (code: string) =>
	ExecuteCodeRequestSchema.parse({
		code,
		language: "javascript",
		inputs: { source: { values: [2, 3] } },
	});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("stateless script execution protocol", () => {
	it.each(["javascript", "typescript"])(
		"passes execution metadata as a separate %s argument in a simulated Worker",
		async (language) => {
			const execution = {
				executionId: "execution",
				workflowId: "workflow",
				version: 3,
				triggerType: "SCHEDULE",
			};
			const request = ExecuteCodeRequestSchema.parse({
				code: `const kind${language === "typescript" ? ": string" : ""} = execution.triggerType; return { kind, version: execution.version, inputKind: inputs.execution.triggerType };`,
				language,
				execution,
				inputs: { execution: { triggerType: "MANUAL" } },
			});
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_url: string, options: RequestInit) => {
					const prepared = ExecuteCodeRequestSchema.parse(
						JSON.parse(String(options.body)),
					);
					return Response.json({
						success: true,
						data: await executeDynamicWorkerCode(
							{ LOADER: simulatedWorkerLoader() },
							prepared,
						),
					});
				}),
			);
			const client = new SandboxClient({
				baseUrl: "https://sandbox.example.com",
				authSecret: "synthetic-test-secret",
			});
			const result = await client.executeCode(
				"owner",
				"example-org",
				request,
			);
			expect(result.results).toEqual([
				{
					type: "json",
					json: { kind: "SCHEDULE", version: 3, inputKind: "MANUAL" },
				},
			]);
		},
	);

	it("keeps execution undefined for existing direct callers", async () => {
		const result = await executeDynamicWorkerCode(
			{ LOADER: simulatedWorkerLoader() },
			input("return { absent: execution === undefined };"),
		);
		expect(result.results).toEqual([
			{ type: "json", json: { absent: true } },
		]);
	});
	it("transforms JSON in a simulated Worker and passes network and resource limits to its loader", async () => {
		const loader = simulatedWorkerLoader();
		const result = await executeDynamicWorkerCode(
			{ LOADER: loader },
			input(
				"console.log('sum'); return { total: inputs.source.values.reduce((a, b) => a + b, 0) };",
			),
		);
		expect(result.error).toBeUndefined();
		expect(result.results).toEqual([{ type: "json", json: { total: 5 } }]);
		expect(result.logs).toEqual([{ type: "stdout", text: "sum" }]);
		expect(loader.load).toHaveBeenCalledWith(
			expect.objectContaining({
				env: {},
				globalOutbound: null,
				limits: { cpuMs: 1000, subRequests: 0 },
			}),
		);
	});

	it("refuses uncompiled TypeScript in the Worker runtime", async () => {
		await expect(
			executeDynamicWorkerCode(
				{ LOADER: simulatedWorkerLoader() },
				{
					...input("const n: number = 2; return n;"),
					language: "typescript",
				},
			),
		).rejects.toThrow("compiled by the authenticated server client");
	});

	it("refuses a missing loader before compiling or running code", async () => {
		await expect(
			executeDynamicWorkerCode({}, input("return 1")),
		).rejects.toThrow("Loader binding");
	});

	it("bounds console count, per-entry bytes, and total log bytes", async () => {
		const result = await executeDynamicWorkerCode(
			{ LOADER: simulatedWorkerLoader() },
			input(
				"for (let i=0; i<1000; i++) console.log('x'.repeat(100000)); return true;",
			),
		);
		expect(result.error).toBeUndefined();
		expect(result.logs.length).toBeLessThanOrEqual(
			DYNAMIC_CODE_LIMITS.logEntries,
		);
		expect(
			result.logs.reduce(
				(bytes, log) =>
					bytes + new TextEncoder().encode(log.text).byteLength,
				0,
			),
		).toBeLessThanOrEqual(DYNAMIC_CODE_LIMITS.logBytes);
	});

	it.each([
		["return 'x'.repeat(70000)", /64 KiB/],
		["throw new Error('example failure')", /example failure/],
		["return 1n", /BigInt/],
		["return undefined", /JSON value/],
		["const a = {}; a.self = a; return a", /circular/i],
	])("reports bounded script errors for %s", async (code, pattern) => {
		const result = await executeDynamicWorkerCode(
			{ LOADER: simulatedWorkerLoader() },
			input(code),
		);
		expect(result.error).toMatch(pattern);
		expect(result.error?.length).toBeLessThanOrEqual(1000);
	});

	it("validates a malicious entrypoint result outside the script wrapper", async () => {
		const loader: DynamicCodeLoader = {
			load: () => ({
				getEntrypoint: () => ({
					fetch: async () =>
						Response.json({
							logs: [],
							results: [
								{ type: "json", json: "x".repeat(70000) },
							],
						}),
				}),
			}),
		};
		const result = await executeDynamicWorkerCode(
			{ LOADER: loader },
			input("return null"),
		);
		expect(result.error).toBeTruthy();
		expect(result.results).toBeUndefined();
	});

	it("clears the response deadline after an invocation settles", async () => {
		vi.useFakeTimers();
		await executeDynamicWorkerCode(
			{ LOADER: simulatedWorkerLoader() },
			input("return null"),
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("bounds waiting for an unresolved invocation without claiming isolate termination", async () => {
		vi.useFakeTimers();
		const loader: DynamicCodeLoader = {
			load: () => ({
				getEntrypoint: () => ({ fetch: () => new Promise(() => {}) }),
			}),
		};
		const run = executeDynamicWorkerCode(
			{ LOADER: loader },
			{ ...input("return null"), timeout: 1000 },
		);
		await vi.advanceTimersByTimeAsync(1000);
		expect((await run).error).toBe("Script response deadline exceeded");
		expect(vi.getTimerCount()).toBe(0);
	});
});
