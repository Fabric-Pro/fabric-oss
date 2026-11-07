import { describe, expect, it, vi } from "vitest";
import { FabricHttpClient } from "../src/client.js";
import { AgentTestsResource } from "../src/resources/agent-tests.js";

function setup() {
	const http = {
		get: vi.fn().mockResolvedValue({}),
		post: vi.fn().mockResolvedValue({}),
		request: vi.fn().mockResolvedValue({}),
	};
	return {
		http,
		resource: new AgentTestsResource(http as unknown as FabricHttpClient),
	};
}
const input = {
	instanceId: "example-agent",
	name: "Delivery",
	input: "Summarize",
	checks: { requiredPhrases: ["Ready"] },
};
describe("saved agent tests SDK", () => {
	it("encodes identities, pages and organization on reads", async () => {
		const { http, resource } = setup();
		await resource.listCases("agent/id", {
			org: "example team",
			limit: 5,
			cursor: "next/id",
		});
		expect(http.get).toHaveBeenLastCalledWith(
			"/agent-tests/cases?instanceId=agent%2Fid&org=example+team&limit=5&cursor=next%2Fid",
		);
		await resource.get("run/id");
		expect(http.get).toHaveBeenLastCalledWith("/agent-tests/runs/run%2Fid");
		await resource.listRuns("case/id", { limit: 5 });
		expect(http.get).toHaveBeenLastCalledWith(
			"/agent-tests/runs?caseId=case%2Fid&limit=5",
		);
	});
	it("disables automatic retries for every mutation and preserves revisions", async () => {
		const { http, resource } = setup();
		await resource.createCase(input);
		expect(http.post).toHaveBeenLastCalledWith(
			"/agent-tests/cases",
			input,
			{ retry: { maxRetries: 0 } },
		);
		const update = {
			revision: 2,
			name: input.name,
			input: input.input,
			checks: input.checks,
		};
		await resource.updateCase("case/id", update);
		expect(http.request).toHaveBeenLastCalledWith(
			"PATCH",
			"/agent-tests/cases/case%2Fid",
			{ body: update, retry: { maxRetries: 0 } },
		);
		await resource.archiveCase("case/id", 2, { org: "example-org" });
		expect(http.request).toHaveBeenLastCalledWith(
			"DELETE",
			"/agent-tests/cases/case%2Fid?revision=2&org=example-org",
			{ retry: { maxRetries: 0 } },
		);
		await resource.cancel("run/id");
		expect(http.post).toHaveBeenLastCalledWith(
			"/agent-tests/runs/run%2Fid/cancel",
			{},
			{ retry: { maxRetries: 0 } },
		);
	});
	it("does not manufacture or replace the retry identity", async () => {
		const { http, resource } = setup();
		const run = {
			caseId: "example-case",
			instanceId: "example-agent",
			caseRevision: 2,
			idempotencyKey: "7279e1aa-5913-44bf-a9ce-e57358f977dd",
		};
		await resource.start(run);
		await resource.start(run);
		expect(http.post).toHaveBeenNthCalledWith(1, "/agent-tests/runs", run, {
			retry: { maxRetries: 0 },
		});
		expect(http.post).toHaveBeenNthCalledWith(2, "/agent-tests/runs", run, {
			retry: { maxRetries: 0 },
		});
	});
	it("compares exact baseline and candidate without side effects", async () => {
		const { http, resource } = setup();
		await resource.compare("example-base", "example-next", {
			org: "example-org",
		});
		expect(http.post).toHaveBeenCalledWith(
			"/agent-tests/compare?org=example-org",
			{ baselineRunId: "example-base", candidateRunId: "example-next" },
			{ retry: { maxRetries: 0 } },
		);
	});
	it("retains definitive admission details through the real HTTP error parser without retrying", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							code: "CONFLICT",
							message: "Test changed before admission",
							data: { admission: "NOT_STARTED" },
						},
					}),
					{
						status: 409,
						headers: { "content-type": "application/json" },
					},
				),
		);
		const resource = new AgentTestsResource(
			new FabricHttpClient({
				apiKey: "example-key",
				baseUrl: "https://example.com",
				fetch,
			}),
		);
		await expect(
			resource.start({
				caseId: "example-case",
				caseRevision: 1,
				instanceId: "example-instance",
				idempotencyKey: "7279e1aa-5913-44bf-a9ce-e57358f977dd",
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { admission: "NOT_STARTED" },
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

it("passes versioned JSON and grounding checks without stripping fields or retrying writes", async () => {
	const { resource, http } = setup();
	const checks: import("../src/resources/agent-tests.js").AgentTestChecks = {
		version: 2,
		jsonSchema: {
			type: "object",
			required: ["ready"],
			properties: { ready: { type: "boolean" } },
			additionalProperties: false,
		},
		jsonAssertions: [{ pointer: "/ready", equals: true }],
		grounding: { requireCitations: true },
	};
	await resource.createCase({ ...input, checks });
	expect(http.post).toHaveBeenCalledWith(
		"/agent-tests/cases",
		{ ...input, checks },
		{ retry: { maxRetries: 0 } },
	);
});
