import http from "node:http";
import type { AddressInfo } from "node:net";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

describe("applyFabricPatternEnrichment fast-path and health caching", () => {
	let server: http.Server;
	let baseUrl = "";
	const requests: string[] = [];

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			const url = req.url || "/";
			requests.push(url);
			res.setHeader("Content-Type", "application/json");

			if (url === "/health") {
				res.end(JSON.stringify({ status: "healthy" }));
				return;
			}
			if (url === "/strategies") {
				res.end(
					JSON.stringify([
						{
							name: "cot",
							description: "Chain of thought",
							prompt: "Think step by step.",
						},
					]),
				);
				return;
			}
			if (url === "/contexts/security_expert") {
				res.end(JSON.stringify("You are a security expert."));
				return;
			}
			if (url === "/patterns/find_vulnerabilities") {
				res.end(
					JSON.stringify({
						Name: "find_vulnerabilities",
						Pattern: "Identify security issues carefully.",
					}),
				);
				return;
			}
			res.statusCode = 404;
			res.end(JSON.stringify({ error: "not found" }));
		});

		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const addr = server.address() as AddressInfo;
		baseUrl = `http://127.0.0.1:${addr.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
	});

	beforeEach(() => {
		requests.length = 0;
	});

	it("makes zero HTTP calls when a simple grounded question matches no Fabric components", async () => {
		vi.resetModules();
		process.env.FABRIC_AI_URL = baseUrl;

		const { FabricPromptComposer } = await import("@repo/agent-core");
		new FabricPromptComposer().clearCache();
		const { applyFabricPatternEnrichment } = await import(
			"../fabric-pattern-enrichment"
		);

		const result = await applyFabricPatternEnrichment({
			message: "what does this document say?",
			userId: "user-example-1",
			organizationId: "org-example-1",
			basePrompt: "Base prompt",
			enableAutoDetection: true,
		});

		expect(requests).toEqual([]);
		expect(result.composedPrompt).toBe("Base prompt");
		expect(result.components).toEqual({
			strategy: null,
			context: null,
			pattern: null,
		});
	});

	it("probes /health only once across enrichment and caches availability for subsequent advanced turns", async () => {
		vi.resetModules();
		process.env.FABRIC_AI_URL = baseUrl;

		const { FabricPromptComposer } = await import("@repo/agent-core");
		new FabricPromptComposer().clearCache();
		const { applyFabricPatternEnrichment } = await import(
			"../fabric-pattern-enrichment"
		);

		const first = await applyFabricPatternEnrichment({
			message: "find security vulnerabilities in this architecture",
			userId: "user-example-1",
			organizationId: "org-example-1",
			basePrompt: "",
			enableAutoDetection: true,
		});

		expect(first.fabricAvailable).toBe(true);
		expect(first.components).toEqual({
			strategy: "cot",
			context: "security_expert",
			pattern: "find_vulnerabilities",
		});
		expect(first.composedPrompt).toContain("Think step by step.");
		expect(first.composedPrompt).toContain("You are a security expert.");
		expect(first.composedPrompt).toContain(
			"Identify security issues carefully.",
		);
		expect(requests.filter((u) => u === "/health")).toHaveLength(1);

		requests.length = 0;

		const second = await applyFabricPatternEnrichment({
			message: "check for xss vulnerabilities here",
			userId: "user-example-1",
			organizationId: "org-example-1",
			basePrompt: "",
			enableAutoDetection: true,
		});

		expect(second.fabricAvailable).toBe(true);
		expect(requests).toEqual([]);
	});
});
