import { describe, expect, it, vi } from "vitest";
import { createFabric } from "../src/index.js";

function fixture() {
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () =>
			new Response(
				JSON.stringify({
					data: { requested: true, status: "RUNNING" },
				}),
				{ headers: { "Content-Type": "application/json" } },
			),
	);
	return {
		fetch,
		client: createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			org: "example-org",
			fetch,
			retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 1 },
		}),
	};
}
describe("agentRuns SDK", () => {
	it("exposes read/list/schedule through encoded IDs and organization-bound clones", async () => {
		const { client, fetch } = fixture();
		await client.agentRuns.list("example/instance", { limit: 5 });
		await client.agentRuns.get("example/run");
		await client
			.withOrg("another-org")
			.agentRuns.getSchedule("example-instance");
		expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
			"https://example.com/api/v1/agent-instances/example%2Finstance/runs?limit=5&org=example-org",
			"https://example.com/api/v1/agent-executions/example%2Frun?org=example-org",
			"https://example.com/api/v1/agent-instances/example-instance/run-schedule?org=another-org",
		]);
	});
	it("returns cancellation acknowledgement without claiming a terminal outcome", async () => {
		const { client, fetch } = fixture();
		expect(await client.agentRuns.cancel("example-row")).toEqual({
			requested: true,
			status: "RUNNING",
		});
		expect(fetch.mock.calls[0][1]?.method).toBe("POST");
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({});
	});
	it.each(["cancel", "schedule"])(
		"does not automatically retry ambiguous %s mutations",
		async (operation) => {
			const { client, fetch } = fixture();
			fetch.mockRejectedValue(new TypeError("Lost acknowledgement"));
			await expect(
				operation === "cancel"
					? client.agentRuns.cancel("example-row")
					: client.agentRuns.setSchedule("example-instance", {
							cronExpression: "0 9 * * *",
							timezone: "UTC",
							input: { message: "Report" },
							enabled: false,
						}),
			).rejects.toMatchObject({ code: "NETWORK_ERROR" });
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
	it("uses PUT with exact recurring task and timezone, no new execution call", async () => {
		const { client, fetch } = fixture();
		const input = {
			cronExpression: "0 9 * * *",
			timezone: "America/Phoenix",
			input: { message: "Progress" },
			enabled: true,
		};
		await client.agentRuns.setSchedule("example-instance", input);
		expect(fetch.mock.calls[0][1]?.method).toBe("PUT");
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(input);
	});
});

it("searches paged run history with safely encoded filters and a pinned organization", async () => {
	const { client, fetch } = fixture();
	await client.agentRuns.search({
		instanceId: "example-instance",
		status: "ACTIVE",
		triggerType: "MANUAL",
		query: "progress & risk",
		from: "2026-01-01T00:00:00Z",
		cursor: "opaque_cursor",
		limit: 25,
	});
	const url = new URL(String(fetch.mock.calls[0][0]));
	expect(url.pathname).toBe("/api/v1/agent-runs");
	expect(Object.fromEntries(url.searchParams)).toEqual({
		instanceId: "example-instance",
		status: "ACTIVE",
		triggerType: "MANUAL",
		query: "progress & risk",
		from: "2026-01-01T00:00:00Z",
		cursor: "opaque_cursor",
		limit: "25",
		org: "example-org",
	});
});

it.each(["example-v1", null])(
	"preserves current and original version IDs in the typed SDK history result (%s)",
	async (originalInstanceId) => {
		const history = {
			executions: [
				{
					id: "example-run",
					instanceId: "example-v2",
					executionInstanceId: originalInstanceId,
					agentName: "Current delivery reporter",
					task: "Report progress",
					status: "COMPLETED",
					lastRecordedStatus: "COMPLETED",
					queuedAt: "2026-01-01T09:00:00Z",
					createdAt: "2026-01-01T09:00:01Z",
					completedAt: "2026-01-01T09:00:04Z",
					duration: 3000,
					triggerType: "MANUAL",
				},
			],
			nextCursor: null,
		};
		const { client, fetch } = fixture();
		fetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ data: history }), {
				headers: { "Content-Type": "application/json" },
			}),
		);
		expect(await client.agentRuns.search()).toEqual(history);
	},
);
