import { describe, expect, it, vi } from "vitest";
import { createFabric } from "../src/index";

describe("private triage SDK transport parity", () => {
	it("routes every product operation without copying org selectors or path identities into payloads", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(JSON.stringify({ data: { version: 1 } }), {
					headers: { "Content-Type": "application/json" },
				}),
		);
		const client = createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			fetch,
		});
		const project = "example/project";
		const run = "example/run";
		const org = "example team";
		await client.projects.listTriageRuns(project, {
			org,
			before: "example-opaque-cursor",
		});
		await client.projects.startTriage(project, {
			org,
			requestId: "11111111-1111-4111-8111-111111111111",
			goal: "Find supported risks",
			evidenceIds: ["example-observation"],
		});
		await client.projects.getTriageRun(project, run, { org });
		await client.projects.getTriageResult(project, run, { org });
		await client.projects.cancelTriageRun(project, run, { org });
		await client.projects.reviewTriageProposal(project, run, {
			org,
			proposalId: "a".repeat(64),
			decision: "KEEP",
		});
		const calls = fetch.mock.calls.map(([input, init]) => ({
			url: new URL(String(input)),
			init,
		}));
		expect(calls.map((x) => [x.init?.method, x.url.pathname])).toEqual([
			["GET", "/api/v1/projects/example%2Fproject/delivery/triage"],
			["POST", "/api/v1/projects/example%2Fproject/delivery/triage"],
			[
				"GET",
				"/api/v1/projects/example%2Fproject/delivery/triage/example%2Frun",
			],
			[
				"GET",
				"/api/v1/projects/example%2Fproject/delivery/triage/example%2Frun/result",
			],
			[
				"POST",
				"/api/v1/projects/example%2Fproject/delivery/triage/example%2Frun/cancel",
			],
			[
				"POST",
				"/api/v1/projects/example%2Fproject/delivery/triage/example%2Frun/review",
			],
		]);
		expect(calls[0].url.searchParams.get("before")).toBe(
			"example-opaque-cursor",
		);
		for (const call of calls) {
			expect(call.url.searchParams.get("org")).toBe(org);
			if (call.init?.body) {
				const body = JSON.parse(String(call.init.body));
				expect(body).not.toHaveProperty("org");
				expect(body).not.toHaveProperty("projectId");
				expect(body).not.toHaveProperty("runId");
			}
		}
	});
	it("does not automatically retry an uncertain paid start", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			throw new TypeError("Example connection lost");
		});
		const client = createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			fetch,
		});
		await expect(
			client.projects.startTriage("example-project", {
				requestId: "11111111-1111-4111-8111-111111111111",
				goal: "Review",
				evidenceIds: ["example-observation"],
			}),
		).rejects.toThrow();
		expect(fetch).toHaveBeenCalledOnce();
	});
});
